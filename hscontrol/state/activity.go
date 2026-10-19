package state

import (
	"path/filepath"

	"github.com/juanfont/headscale/hscontrol/activity"
	"github.com/juanfont/headscale/hscontrol/types"
	"github.com/rs/zerolog/log"
)

// openActivity opens the activity store next to the SQLite database, or keeps
// it in memory when there is no on-disk database (e.g. PostgreSQL). Failing to
// open it must never stop the control plane, so errors degrade to a no-op sink.
func openActivity(cfg *types.Config) *activity.Store {
	path := ""
	if cfg.Database.Type == types.DatabaseSqlite && cfg.Database.Sqlite.Path != "" {
		path = filepath.Join(filepath.Dir(cfg.Database.Sqlite.Path), "activity.db")
	}

	store, err := activity.Open(path)
	if err != nil {
		log.Error().Err(err).Msg("activity log disabled")

		return nil
	}

	return store
}

// RecordNodeEvent logs an event about a node.
func (s *State) RecordNodeEvent(typ string, n types.NodeView, detail string) {
	if s == nil || s.Activity == nil || !n.Valid() {
		return
	}

	// A node can be tagged or, in odd states, have no user row at all; the
	// view's Name() would dereference nil, and logging must never panic.
	user := ""
	if u := n.User(); !n.IsTagged() && u.Valid() {
		user = u.Name()
	}

	s.Activity.Record(activity.Event{
		Type:     typ,
		NodeID:   uint64(n.ID()),
		NodeName: n.GivenName(),
		User:     user,
		Detail:   detail,
	})
}

// RecordEvent logs an event that is not about a single node.
func (s *State) RecordEvent(typ, detail string) {
	if s == nil || s.Activity == nil {
		return
	}

	s.Activity.Record(activity.Event{Type: typ, Detail: detail})
}
