package main

import (
	"bufio"
	"fmt"
	"io"
	"net/netip"
	"strconv"
	"strings"
)

// conn is one tracked connection with its cumulative counters (both directions).
type conn struct {
	Proto   int
	Src     netip.Addr
	Dst     netip.Addr
	SPort   int
	DPort   int
	Packets int64
	Bytes   int64
}

type connKey struct {
	proto        int
	src, dst     netip.Addr
	sport, dport int
}

func (c conn) key() connKey { return connKey{c.Proto, c.Src, c.Dst, c.SPort, c.DPort} }

// parseConntrack reads /proc/net/nf_conntrack. Lines look like
//
//	ipv4 2 tcp 6 431999 ESTABLISHED src=A dst=B sport=1 dport=22 packets=10 bytes=1200 src=B dst=A sport=22 dport=1 packets=8 bytes=900 [ASSURED] ...
//
// The first src/dst group is the original direction, the second the reply.
// Counters from both are summed: a flow is the whole conversation.
// sawCounters reports whether any line carried packet/byte counters; if none
// did, accounting is off (net.netfilter.nf_conntrack_acct=0).
func parseConntrack(r io.Reader, keep func(src, dst netip.Addr) bool) (conns []conn, sawCounters bool, err error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 6 {
			continue
		}

		proto, perr := strconv.Atoi(f[3])
		if perr != nil {
			continue
		}

		c := conn{Proto: proto}
		seen := map[string]int{}

		for _, tok := range f[4:] {
			k, v, ok := strings.Cut(tok, "=")
			if !ok {
				continue
			}

			seen[k]++
			first := seen[k] == 1 // original direction

			switch k {
			case "src":
				if first {
					c.Src, _ = netip.ParseAddr(v)
				}
			case "dst":
				if first {
					c.Dst, _ = netip.ParseAddr(v)
				}
			case "sport":
				if first {
					c.SPort, _ = strconv.Atoi(v)
				}
			case "dport":
				if first {
					c.DPort, _ = strconv.Atoi(v)
				}
			case "packets":
				n, _ := strconv.ParseInt(v, 10, 64)
				c.Packets += n
				sawCounters = true
			case "bytes":
				n, _ := strconv.ParseInt(v, 10, 64)
				c.Bytes += n
				sawCounters = true
			}
		}

		if !c.Src.IsValid() || !c.Dst.IsValid() || !keep(c.Src.Unmap(), c.Dst.Unmap()) {
			continue
		}

		c.Src, c.Dst = c.Src.Unmap(), c.Dst.Unmap()
		conns = append(conns, c)
	}

	if err := sc.Err(); err != nil {
		return nil, false, fmt.Errorf("reading conntrack: %w", err)
	}

	return conns, sawCounters, nil
}

// tailnetOnly keeps connections where both ends are inside the given prefixes.
func tailnetOnly(prefixes []netip.Prefix) func(src, dst netip.Addr) bool {
	in := func(a netip.Addr) bool {
		for _, p := range prefixes {
			if p.Contains(a) {
				return true
			}
		}

		return false
	}

	return func(src, dst netip.Addr) bool { return in(src) && in(dst) }
}
