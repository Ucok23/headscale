package main

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const sample = `ipv4     2 tcp      6 431999 ESTABLISHED src=100.64.0.1 dst=100.64.0.2 sport=45678 dport=22 packets=10 bytes=1200 src=100.64.0.2 dst=100.64.0.1 sport=22 dport=45678 packets=8 bytes=900 [ASSURED] mark=0 zone=0 use=2
ipv4     2 udp      17 29 src=100.64.0.1 dst=100.64.0.3 sport=5000 dport=53 packets=1 bytes=70 src=100.64.0.3 dst=100.64.0.1 sport=53 dport=5000 packets=1 bytes=120 mark=0 zone=0 use=2
ipv4     2 icmp     1 29 src=100.64.0.1 dst=100.64.0.2 type=8 code=0 id=7 packets=4 bytes=336 src=100.64.0.2 dst=100.64.0.1 type=0 code=0 id=7 packets=4 bytes=336 mark=0 zone=0 use=2
ipv4     2 tcp      6 100 ESTABLISHED src=192.168.1.5 dst=1.1.1.1 sport=40000 dport=443 packets=5 bytes=500 src=1.1.1.1 dst=192.168.1.5 sport=443 dport=40000 packets=5 bytes=900 mark=0 zone=0 use=2
ipv6    10 tcp      6 431999 ESTABLISHED src=fd7a:115c:a1e0::1 dst=fd7a:115c:a1e0::2 sport=50000 dport=8080 packets=3 bytes=300 src=fd7a:115c:a1e0::2 dst=fd7a:115c:a1e0::1 sport=8080 dport=50000 packets=2 bytes=200 mark=0 zone=0 use=2
`

var tailnet = tailnetOnly([]netip.Prefix{netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("fd7a:115c:a1e0::/48")})

func TestParseConntrack(t *testing.T) {
	conns, saw, err := parseConntrack(strings.NewReader(sample), tailnet)
	require.NoError(t, err)
	assert.True(t, saw)
	require.Len(t, conns, 4, "the 192.168.1.5 -> 1.1.1.1 line is not tailnet traffic")

	ssh := conns[0]
	assert.Equal(t, 6, ssh.Proto)
	assert.Equal(t, "100.64.0.1", ssh.Src.String())
	assert.Equal(t, 22, ssh.DPort)
	assert.EqualValues(t, 2100, ssh.Bytes, "both directions summed")
	assert.EqualValues(t, 18, ssh.Packets)

	assert.Equal(t, 17, conns[1].Proto)
	assert.Equal(t, 1, conns[2].Proto, "icmp has no ports")
	assert.Equal(t, 0, conns[2].DPort)
	assert.Equal(t, "fd7a:115c:a1e0::2", conns[3].Dst.String())
}

func TestParseConntrackWithoutAccounting(t *testing.T) {
	line := "ipv4 2 tcp 6 431999 ESTABLISHED src=100.64.0.1 dst=100.64.0.2 sport=1 dport=22 src=100.64.0.2 dst=100.64.0.1 sport=22 dport=1 mark=0 zone=0 use=2\n"
	conns, saw, err := parseConntrack(strings.NewReader(line), tailnet)
	require.NoError(t, err)
	assert.False(t, saw, "must tell the caller accounting is off")
	assert.Len(t, conns, 1)
}

func mk(bytes, packets int64, dport int) conn {
	return conn{Proto: 6, Src: netip.MustParseAddr("100.64.0.1"), Dst: netip.MustParseAddr("100.64.0.2"), SPort: 4000, DPort: dport, Bytes: bytes, Packets: packets}
}

func TestTrackerBaselineThenDeltas(t *testing.T) {
	tr := newTracker()

	// connections that exist when the agent starts are baseline only
	tr.observe([]conn{mk(1_000_000, 900, 22)})
	assert.Empty(t, tr.snapshot(), "pre-existing traffic must not be charged to the first interval")

	// the same connection moves 500 bytes
	tr.observe([]conn{mk(1_000_500, 905, 22)})
	got := tr.snapshot()
	require.Len(t, got, 1)
	assert.EqualValues(t, 500, got[0].Bytes)
	assert.EqualValues(t, 5, got[0].Packets)
	assert.EqualValues(t, 0, got[0].Conns, "not a new connection")

	// a brand new connection counts from zero and as one connection
	tr.observe([]conn{mk(1_000_500, 905, 22), {Proto: 6, Src: netip.MustParseAddr("100.64.0.1"), Dst: netip.MustParseAddr("100.64.0.2"), SPort: 4001, DPort: 22, Bytes: 80, Packets: 2}})
	got = tr.snapshot()
	require.Len(t, got, 1, "both connections go to the same service so they merge")
	assert.EqualValues(t, 580, got[0].Bytes)
	assert.EqualValues(t, 1, got[0].Conns)
}

func TestTrackerDrainAndRetry(t *testing.T) {
	tr := newTracker()
	tr.observe(nil)
	tr.observe([]conn{mk(100, 1, 80)})
	tr.observe([]conn{mk(150, 2, 80)})

	// a failed upload: snapshot() does not clear, so the next report carries everything
	first := tr.snapshot()
	require.Len(t, first, 1)
	assert.EqualValues(t, 150, first[0].Bytes)

	tr.observe([]conn{mk(170, 3, 80)})
	assert.EqualValues(t, 170, tr.snapshot()[0].Bytes)

	// after a successful upload it starts over
	assert.Len(t, tr.drain(), 1)
	assert.Empty(t, tr.snapshot())
}

func TestTrackerCounterResetCountsFromZero(t *testing.T) {
	tr := newTracker()
	tr.observe([]conn{mk(5000, 50, 22)})
	tr.observe([]conn{mk(70, 1, 22)}) // entry reused: counters went backwards

	got := tr.snapshot()
	require.Len(t, got, 1)
	assert.EqualValues(t, 70, got[0].Bytes)
}

func TestParseMetrics(t *testing.T) {
	text := `# HELP tailscaled_inbound_bytes_total x
# TYPE tailscaled_inbound_bytes_total counter
tailscaled_inbound_bytes_total{path="direct_ipv4"} 1000
tailscaled_inbound_bytes_total{path="derp"} 250
tailscaled_outbound_bytes_total{path="direct_ipv4"} 400
tailscaled_outbound_bytes_total{path="derp"} 100
tailscaled_inbound_packets_total{path="derp"} 9
`
	c, ok := parseMetrics(text)
	require.True(t, ok)
	assert.EqualValues(t, 1250, c.RxBytes)
	assert.EqualValues(t, 500, c.TxBytes)

	_, ok = parseMetrics("nothing relevant 1\n")
	assert.False(t, ok)
}
