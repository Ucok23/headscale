package main

import "net/netip"

type flowKey struct {
	src, dst netip.Addr
	proto    int
	dport    int
}

// flowDelta is the traffic of one (src, dst, proto, dport) since the last poll.
type flowDelta struct {
	Src     string `json:"src"`
	Dst     string `json:"dst"`
	Proto   int    `json:"proto"`
	DPort   int    `json:"dport"`
	Bytes   int64  `json:"bytes"`
	Packets int64  `json:"packets"`
	Conns   int64  `json:"conns"`
}

// tracker turns cumulative conntrack counters into per-interval deltas.
type tracker struct {
	last    map[connKey]conn
	started bool
	pending map[flowKey]*flowDelta
}

func newTracker() *tracker {
	return &tracker{last: map[connKey]conn{}, pending: map[flowKey]*flowDelta{}}
}

// observe folds one conntrack snapshot into the pending deltas.
//
// The first snapshot after start only sets baselines: connections that were
// already open (and may have moved gigabytes before we looked) are not charged
// to this interval. Connections that appear later are counted from zero, and a
// counter that went backwards (entry reused) counts from zero too.
func (t *tracker) observe(snapshot []conn) {
	next := make(map[connKey]conn, len(snapshot))

	for _, c := range snapshot {
		k := c.key()
		next[k] = c

		prev, known := t.last[k]
		if !known && !t.started {
			continue // baseline only
		}

		d := flowDelta{Bytes: c.Bytes, Packets: c.Packets}
		if known {
			if c.Bytes >= prev.Bytes && c.Packets >= prev.Packets {
				d.Bytes, d.Packets = c.Bytes-prev.Bytes, c.Packets-prev.Packets
			}
		} else {
			d.Conns = 1
		}

		if d.Bytes == 0 && d.Packets == 0 && d.Conns == 0 {
			continue
		}

		fk := flowKey{c.Src, c.Dst, c.Proto, c.DPort}

		agg := t.pending[fk]
		if agg == nil {
			agg = &flowDelta{Src: c.Src.String(), Dst: c.Dst.String(), Proto: c.Proto, DPort: c.DPort}
			t.pending[fk] = agg
		}

		agg.Bytes += d.Bytes
		agg.Packets += d.Packets
		agg.Conns += d.Conns
	}

	t.last = next
	t.started = true
}

// drain returns and clears what has accumulated. Call it only after a report
// was accepted; on failure keep observing and the next report carries it all.
func (t *tracker) drain() []flowDelta {
	out := make([]flowDelta, 0, len(t.pending))
	for _, d := range t.pending {
		out = append(out, *d)
	}

	t.pending = map[flowKey]*flowDelta{}

	return out
}

// snapshot returns the pending deltas without clearing them.
func (t *tracker) snapshot() []flowDelta {
	out := make([]flowDelta, 0, len(t.pending))
	for _, d := range t.pending {
		out = append(out, *d)
	}

	return out
}
