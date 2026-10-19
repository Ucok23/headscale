package activity

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newStore(t *testing.T) *Store {
	t.Helper()

	s, err := Open(t.TempDir() + "/activity.db")
	require.NoError(t, err)

	return s
}

func TestNilStoreIsNoop(t *testing.T) {
	var s *Store

	s.Record(Event{Type: "x"})
	require.NoError(t, s.Ingest("r", time.Now(), nil, nil))

	ev, err := s.Events(EventFilter{})
	require.NoError(t, err)
	assert.Empty(t, ev)
}

func TestEventsFilterAndOrder(t *testing.T) {
	s := newStore(t)
	s.Record(Event{Type: "node.online", NodeID: 1, NodeName: "a"})
	s.Record(Event{Type: "node.offline", NodeID: 1, NodeName: "a"})
	s.Record(Event{Type: "policy.updated"})

	all, err := s.Events(EventFilter{})
	require.NoError(t, err)
	require.Len(t, all, 3)
	assert.Equal(t, "policy.updated", all[0].Type, "newest first")

	one, _ := s.Events(EventFilter{NodeID: 1})
	assert.Len(t, one, 2)

	typed, _ := s.Events(EventFilter{Types: []string{"node.offline", "policy.updated"}})
	assert.Len(t, typed, 2)

	page, _ := s.Events(EventFilter{Before: all[0].ID, Limit: 1})
	require.Len(t, page, 1)
	assert.Equal(t, "node.offline", page[0].Type)
}

func TestIngestAddsAndDedupesReporters(t *testing.T) {
	s := newStore(t)
	now := time.Now()
	f := Flow{Src: "100.64.0.1", Dst: "100.64.0.2", Proto: 6, DPort: 22, Bytes: 1000, Packets: 10, Conns: 1}

	// the same flow reported twice by one reporter adds up...
	require.NoError(t, s.Ingest("100.64.0.1", now, []Flow{f}, nil))
	require.NoError(t, s.Ingest("100.64.0.1", now, []Flow{f}, nil))
	// ...but both ends reporting the same traffic must not double count.
	require.NoError(t, s.Ingest("100.64.0.2", now, []Flow{{Src: f.Src, Dst: f.Dst, Proto: 6, DPort: 22, Bytes: 1900, Packets: 19, Conns: 2}}, nil))

	tr, err := s.Traffic(now.Add(-time.Hour))
	require.NoError(t, err)
	require.Len(t, tr.Edges, 1)
	assert.EqualValues(t, 2000, tr.Edges[0].Bytes, "max of reporters (2000 vs 1900), not their sum")
	require.Len(t, tr.Services, 1)
	assert.Equal(t, 22, tr.Services[0].DPort)
	require.Len(t, tr.Series, 1)
}

func TestIngestRejectsBadInput(t *testing.T) {
	s := newStore(t)
	assert.ErrorIs(t, s.Ingest("", time.Now(), nil, nil), ErrBadFlow)
	assert.ErrorIs(t, s.Ingest("r", time.Now(), []Flow{{Src: "a", Dst: "b", Bytes: -1}}, nil), ErrBadFlow)

	// a rejected batch stores nothing
	_ = s.Ingest("r", time.Now(), []Flow{{Src: "a", Dst: "b", Bytes: 5}, {Src: "", Dst: "b"}}, nil)

	tr, _ := s.Traffic(time.Now().Add(-time.Hour))
	assert.Empty(t, tr.Edges)
}

func TestTrafficWindow(t *testing.T) {
	s := newStore(t)
	now := time.Now()
	old := now.Add(-3 * time.Hour)
	require.NoError(t, s.Ingest("r", old, []Flow{{Src: "a", Dst: "b", Proto: 6, DPort: 1, Bytes: 100}}, nil))
	require.NoError(t, s.Ingest("r", now, []Flow{{Src: "a", Dst: "b", Proto: 6, DPort: 1, Bytes: 7}}, nil))

	last, _ := s.Traffic(now.Add(-time.Hour))
	require.Len(t, last.Edges, 1)
	assert.EqualValues(t, 7, last.Edges[0].Bytes)

	day, _ := s.Traffic(now.Add(-24 * time.Hour))
	assert.EqualValues(t, 107, day.Edges[0].Bytes)
}

func TestNodeTrafficSkipsCounterResets(t *testing.T) {
	s := newStore(t)
	base := time.Now().Add(-time.Minute)
	samples := []struct{ rx, tx int64 }{{100, 10}, {300, 30}, {50, 5} /* client restarted */, {150, 25}}

	for i, c := range samples {
		require.NoError(t, s.Ingest("n1", base.Add(time.Duration(i)*time.Second), nil, &Counters{RxBytes: c.rx, TxBytes: c.tx}))
	}

	nt, err := s.NodeTraffic(base.Add(-time.Minute))
	require.NoError(t, err)
	require.Len(t, nt, 1)
	assert.EqualValues(t, 200+100, nt[0].RxBytes, "200 + (reset skipped) + 100")
	assert.EqualValues(t, 20+20, nt[0].TxBytes)
}

func TestInMemoryStoresAreIsolated(t *testing.T) {
	a, err := Open("")
	require.NoError(t, err)

	b, err := Open("")
	require.NoError(t, err)

	a.Record(Event{Type: "only.in.a"})

	ev, err := b.Events(EventFilter{})
	require.NoError(t, err)
	assert.Empty(t, ev, "a second in-memory store must not see the first one's events")
}

func TestIngestReportValidation(t *testing.T) {
	s := newStore(t)

	n, err := s.IngestReport(Report{Reporter: "100.64.0.1", Flows: []Flow{{Src: "a", Dst: "b", Bytes: 5}}})
	require.NoError(t, err)
	assert.Equal(t, 1, n)

	_, err = s.IngestReport(Report{Reporter: "r", Flows: make([]Flow, MaxFlowBatch+1)})
	assert.ErrorIs(t, err, ErrBadFlow, "oversized batches are refused")

	_, err = s.IngestReport(Report{Reporter: "r", Time: time.Now().Add(-3 * time.Hour).Unix()})
	assert.ErrorIs(t, err, ErrBadFlow, "stale samples are refused")

	_, err = s.IngestReport(Report{Reporter: "r", Time: time.Now().Add(time.Hour).Unix()})
	assert.ErrorIs(t, err, ErrBadFlow, "samples from the future are refused")

	_, err = s.IngestReport(Report{})
	assert.ErrorIs(t, err, ErrBadFlow, "a reporter is required")
}
