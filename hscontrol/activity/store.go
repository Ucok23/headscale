// Package activity records what happens on a tailnet: control-plane events
// (nodes coming and going, policy changes, ...) and network flows reported by
// per-node agents. It uses its own SQLite file so it never touches the main
// database schema or its migration rules.
package activity

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/rs/zerolog/log"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const (
	eventRetention = 30 * 24 * time.Hour
	flowRetention  = 7 * 24 * time.Hour
	// Flows are summed into one-minute buckets to keep the table small.
	flowBucket     = 60 * time.Second
	pruneEveryNOps = 2000
)

// Event is one control-plane happening.
type Event struct {
	ID       int64  `json:"id"`
	Time     int64  `json:"time"` // unix milliseconds
	Type     string `json:"type"`
	NodeID   uint64 `json:"nodeId"`
	NodeName string `json:"nodeName"`
	User     string `json:"user"`
	Detail   string `json:"detail"`
}

// Store is safe for concurrent use. A nil *Store is a valid no-op sink, so
// callers never need to check whether activity recording is enabled.
type Store struct {
	db  *gorm.DB
	mu  sync.Mutex
	ops int
}

// Open creates the store at path. An empty path keeps everything in memory.
func Open(path string) (*Store, error) {
	dsn := path
	if dsn == "" {
		dsn = "file:activity?mode=memory&cache=shared"
	}

	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		return nil, fmt.Errorf("opening activity database: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err //nolint:wrapcheck // trivially wrapped above
	}
	// A single writer keeps SQLite free of "database is locked" errors.
	sqlDB.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		return nil, err
	}

	s.prune()

	return s, nil
}

func (s *Store) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			type TEXT NOT NULL,
			node_id INTEGER NOT NULL DEFAULT 0,
			node_name TEXT NOT NULL DEFAULT '',
			user TEXT NOT NULL DEFAULT '',
			detail TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS events_ts ON events(ts)`,
		`CREATE TABLE IF NOT EXISTS flows (
			bucket INTEGER NOT NULL,
			reporter TEXT NOT NULL,
			src TEXT NOT NULL,
			dst TEXT NOT NULL,
			proto INTEGER NOT NULL,
			dport INTEGER NOT NULL,
			bytes INTEGER NOT NULL DEFAULT 0,
			packets INTEGER NOT NULL DEFAULT 0,
			conns INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (bucket, reporter, src, dst, proto, dport)
		)`,
		`CREATE INDEX IF NOT EXISTS flows_bucket ON flows(bucket)`,
		`CREATE TABLE IF NOT EXISTS node_counters (
			ts INTEGER NOT NULL,
			node TEXT NOT NULL,
			rx INTEGER NOT NULL,
			tx INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS node_counters_ts ON node_counters(ts)`,
	}
	for _, q := range stmts {
		if err := s.db.Exec(q).Error; err != nil {
			return fmt.Errorf("activity schema: %w", err)
		}
	}

	return nil
}

func (s *Store) tick() {
	s.ops++
	if s.ops%pruneEveryNOps == 0 {
		s.pruneLocked()
	}
}

func (s *Store) prune() {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.pruneLocked()
}

func (s *Store) pruneLocked() {
	now := time.Now()
	s.db.Exec(`DELETE FROM events WHERE ts < ?`, now.Add(-eventRetention).UnixMilli())
	s.db.Exec(`DELETE FROM flows WHERE bucket < ?`, now.Add(-flowRetention).Unix())
	s.db.Exec(`DELETE FROM node_counters WHERE ts < ?`, now.Add(-flowRetention).Unix())
}

// Record appends an event. It never fails the caller: a logging problem must
// not break node registration or policy updates.
func (s *Store) Record(e Event) {
	if s == nil {
		return
	}

	if e.Time == 0 {
		e.Time = time.Now().UnixMilli()
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	err := s.db.Exec(
		`INSERT INTO events (ts, type, node_id, node_name, user, detail) VALUES (?,?,?,?,?,?)`,
		e.Time, e.Type, e.NodeID, e.NodeName, e.User, e.Detail,
	).Error
	if err != nil {
		log.Warn().Err(err).Str("type", e.Type).Msg("recording activity event")

		return
	}

	s.tick()
}

// EventFilter narrows [Store.Events].
type EventFilter struct {
	Types  []string
	NodeID uint64
	Since  int64 // unix ms, inclusive
	Before int64 // event id, exclusive; for paging backwards
	Limit  int
}

// Events returns the newest events first.
func (s *Store) Events(f EventFilter) ([]Event, error) {
	if s == nil {
		return []Event{}, nil
	}

	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 200
	}

	q := `SELECT id, ts AS time, type, node_id, node_name, user, detail FROM events WHERE ts >= ?`
	args := []any{f.Since}

	if f.NodeID != 0 {
		q += ` AND node_id = ?`
		args = append(args, f.NodeID)
	}

	if f.Before != 0 {
		q += ` AND id < ?`
		args = append(args, f.Before)
	}

	if len(f.Types) > 0 {
		q += ` AND type IN (?)`
		args = append(args, f.Types)
	}

	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, f.Limit)

	s.mu.Lock()
	defer s.mu.Unlock()

	out := []Event{}
	if err := s.db.Raw(q, args...).Scan(&out).Error; err != nil {
		return nil, fmt.Errorf("listing events: %w", err)
	}

	return out, nil
}

// ErrBadFlow is returned for flow records that cannot be stored.
var ErrBadFlow = errors.New("invalid flow record")

// Flow is traffic between two tailnet addresses, as seen by one reporter.
type Flow struct {
	Src     string `json:"src"`
	Dst     string `json:"dst"`
	Proto   int    `json:"proto"`
	DPort   int    `json:"dport"`
	Bytes   int64  `json:"bytes"`
	Packets int64  `json:"packets"`
	Conns   int64  `json:"conns"`
}

// Counters are a node's cumulative byte counters from its client metrics.
type Counters struct {
	RxBytes int64 `json:"rxBytes"`
	TxBytes int64 `json:"txBytes"`
}

// Ingest adds the deltas an agent measured since its previous report.
func (s *Store) Ingest(reporter string, at time.Time, flows []Flow, c *Counters) error {
	if s == nil {
		return nil
	}

	if reporter == "" {
		return fmt.Errorf("%w: reporter is required", ErrBadFlow)
	}

	bucket := at.Truncate(flowBucket).Unix()

	s.mu.Lock()
	defer s.mu.Unlock()

	tx := s.db.Begin()
	defer tx.Rollback()

	for _, f := range flows {
		if f.Src == "" || f.Dst == "" || f.Bytes < 0 || f.Packets < 0 || f.Conns < 0 {
			return fmt.Errorf("%w: %+v", ErrBadFlow, f)
		}

		err := tx.Exec(
			`INSERT INTO flows (bucket, reporter, src, dst, proto, dport, bytes, packets, conns)
			 VALUES (?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(bucket, reporter, src, dst, proto, dport) DO UPDATE SET
			   bytes = bytes + excluded.bytes,
			   packets = packets + excluded.packets,
			   conns = conns + excluded.conns`,
			bucket, reporter, f.Src, f.Dst, f.Proto, f.DPort, f.Bytes, f.Packets, f.Conns,
		).Error
		if err != nil {
			return fmt.Errorf("storing flow: %w", err)
		}
	}

	if c != nil {
		err := tx.Exec(`INSERT INTO node_counters (ts, node, rx, tx) VALUES (?,?,?,?)`,
			at.Unix(), reporter, c.RxBytes, c.TxBytes).Error
		if err != nil {
			return fmt.Errorf("storing counters: %w", err)
		}
	}

	if err := tx.Commit().Error; err != nil {
		return fmt.Errorf("committing flows: %w", err)
	}

	s.tick()

	return nil
}

// Edge is the traffic from one address to another over a window.
type Edge struct {
	Src     string `json:"src"`
	Dst     string `json:"dst"`
	Bytes   int64  `json:"bytes"`
	Packets int64  `json:"packets"`
	Conns   int64  `json:"conns"`
}

// Service is the traffic to one destination port over a window.
type Service struct {
	Src   string `json:"src"`
	Dst   string `json:"dst"`
	Proto int    `json:"proto"`
	DPort int    `json:"dport" gorm:"column:dport"`
	Bytes int64  `json:"bytes"`
	Conns int64  `json:"conns"`
}

// Point is the total bytes in one time bucket.
type Point struct {
	Time  int64 `json:"time"` // unix seconds
	Bytes int64 `json:"bytes"`
}

// Traffic summarises flows in [since, now].
type Traffic struct {
	Edges    []Edge    `json:"edges"`
	Services []Service `json:"services"`
	Series   []Point   `json:"series"`
}

// dedup collapses reports of the same flow from both ends: for each bucket and
// flow key it keeps the larger of the reporters' numbers instead of summing.
const dedup = `
SELECT bucket, src, dst, proto, dport,
       MAX(bytes) AS bytes, MAX(packets) AS packets, MAX(conns) AS conns
FROM flows WHERE bucket >= ?
GROUP BY bucket, src, dst, proto, dport`

// Traffic aggregates flows since the given time.
func (s *Store) Traffic(since time.Time) (*Traffic, error) {
	out := &Traffic{Edges: []Edge{}, Services: []Service{}, Series: []Point{}}
	if s == nil {
		return out, nil
	}

	from := since.Truncate(flowBucket).Unix()

	s.mu.Lock()
	defer s.mu.Unlock()

	q := []struct {
		sql string
		dst any
	}{
		{`SELECT src, dst, SUM(bytes) AS bytes, SUM(packets) AS packets, SUM(conns) AS conns
		  FROM (` + dedup + `) GROUP BY src, dst ORDER BY bytes DESC`, &out.Edges},
		{`SELECT src, dst, proto, dport, SUM(bytes) AS bytes, SUM(conns) AS conns
		  FROM (` + dedup + `) GROUP BY src, dst, proto, dport ORDER BY bytes DESC LIMIT 100`, &out.Services},
		{`SELECT bucket AS time, SUM(bytes) AS bytes
		  FROM (` + dedup + `) GROUP BY bucket ORDER BY bucket`, &out.Series},
	}
	for _, x := range q {
		if err := s.db.Raw(x.sql, from).Scan(x.dst).Error; err != nil {
			return nil, fmt.Errorf("aggregating traffic: %w", err)
		}
	}

	return out, nil
}

// NodeTraffic is how much a node moved over a window, from its client counters.
type NodeTraffic struct {
	Node    string `json:"node"`
	RxBytes int64  `json:"rxBytes"`
	TxBytes int64  `json:"txBytes"`
}

// NodeTraffic derives per-node totals as last sample minus first sample in the
// window. A counter reset (client restart) shows up as a negative step and is
// skipped by summing only the positive steps.
func (s *Store) NodeTraffic(since time.Time) ([]NodeTraffic, error) {
	out := []NodeTraffic{}
	if s == nil {
		return out, nil
	}

	type row struct {
		Node string
		Rx   int64
		Tx   int64
	}

	var rows []row

	s.mu.Lock()
	defer s.mu.Unlock()

	err := s.db.Raw(`SELECT node, rx, tx FROM node_counters WHERE ts >= ? ORDER BY node, ts`, since.Unix()).Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("listing counters: %w", err)
	}

	var cur *NodeTraffic

	var prev row

	for _, r := range rows {
		if cur == nil || cur.Node != r.Node {
			out = append(out, NodeTraffic{Node: r.Node})
			cur = &out[len(out)-1]
			prev = r

			continue
		}

		if d := r.Rx - prev.Rx; d > 0 {
			cur.RxBytes += d
		}

		if d := r.Tx - prev.Tx; d > 0 {
			cur.TxBytes += d
		}

		prev = r
	}

	return out, nil
}
