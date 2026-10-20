package apiv1

import (
	"net/netip"
	"testing"

	"github.com/juanfont/headscale/hscontrol/types"
	"github.com/stretchr/testify/assert"
	"tailscale.com/tailcfg"
)

func TestNodeFromViewIncludesClientInfo(t *testing.T) {
	n := types.Node{
		ID:        1,
		GivenName: "laptop",
		Hostinfo:  &tailcfg.Hostinfo{OS: "linux", OSVersion: "6.12", IPNVersion: "1.84.0"},
		Endpoints: []netip.AddrPort{netip.MustParseAddrPort("203.0.113.5:41641")},
	}

	got := nodeFromView(n.View())

	assert.Equal(t, "linux", got.OS)
	assert.Equal(t, "6.12", got.OSVersion)
	assert.Equal(t, "1.84.0", got.ClientVersion)
	assert.Equal(t, []string{"203.0.113.5:41641"}, got.Endpoints)
}

func TestNodeFromViewWithoutHostinfo(t *testing.T) {
	// A node that registered but never sent a map request has no Hostinfo yet.
	got := nodeFromView((&types.Node{ID: 2, GivenName: "new"}).View())

	assert.Empty(t, got.OS)
	assert.Empty(t, got.ClientVersion)
	assert.NotNil(t, got.Endpoints, "must serialise as [] not null")
}
