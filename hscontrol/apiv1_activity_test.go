package hscontrol

import (
	"encoding/json"
	"net/http"
	"net/netip"
	"testing"
	"time"

	"github.com/juanfont/headscale/hscontrol/mapper"
	"github.com/juanfont/headscale/hscontrol/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// createAppWithIPs is createTestApp plus IP prefixes: the simulator reasons about
// addresses, and the plain test app registers nodes without allocating any.
func createAppWithIPs(t *testing.T) *Headscale {
	t.Helper()

	tmpDir := t.TempDir()
	v4 := netip.MustParsePrefix("100.64.0.0/10")
	v6 := netip.MustParsePrefix("fd7a:115c:a1e0::/48")

	cfg := types.Config{
		ServerURL:           "http://localhost:8080",
		NoisePrivateKeyPath: tmpDir + "/noise_private.key",
		PrefixV4:            &v4,
		PrefixV6:            &v6,
		IPAllocation:        types.IPAllocationStrategySequential,
		Database: types.DatabaseConfig{
			Type:   "sqlite3",
			Sqlite: types.SqliteConfig{Path: tmpDir + "/headscale_test.db"},
		},
		Policy: types.PolicyConfig{Mode: types.PolicyModeDB},
		Tuning: types.Tuning{BatchChangeDelay: 100 * time.Millisecond, BatcherWorkers: 1},
	}

	app, err := NewHeadscale(&cfg)
	require.NoError(t, err)

	app.mapBatcher = mapper.NewBatcherAndMapper(&cfg, app.state)
	app.mapBatcher.Start()
	t.Cleanup(app.mapBatcher.Close)

	return app
}

type simResult struct {
	Allowed bool   `json:"allowed"`
	Error   string `json:"error"`
	DstIP   string `json:"dstIp"`
	Rule    *struct {
		DstPorts []string `json:"dstPorts"`
	} `json:"rule"`
}

func (h *apiV1Harness) post(t *testing.T, path string, v any) httpResult {
	t.Helper()

	b, err := json.Marshal(v)
	require.NoError(t, err)

	return h.callHuma(http.MethodPost, path, b)
}

// simEnv has alice's laptop, ops's server and bob's phone, with ips by name.
func simEnv(t *testing.T) (*apiV1Harness, map[string]string) {
	t.Helper()

	app := createAppWithIPs(t)
	h := &apiV1Harness{app: app, huma: newHumaTestHandler(app)}
	seedNodes(
		newNodeSeed("alice", "laptop"),
		newNodeSeed("ops", "server"),
		newNodeSeed("bob", "phone"),
	)(t, h.app)

	ips := map[string]string{}

	for _, n := range h.app.state.ListNodes().All() {
		ips[n.GivenName()] = n.IPs()[0].String()
	}

	require.Len(t, ips, 3)

	return h, ips
}

func policyFor(ips map[string]string) string {
	return `{
	  "groups": {"group:alice": ["alice@"], "group:bob": ["bob@"]},
	  "hosts": {"srv": "` + ips["server"] + `"},
	  "grants": [
	    {"src": ["group:alice"], "dst": ["srv"], "ip": ["tcp:22", "tcp:8000-8100"]},
	    {"src": ["group:bob"], "dst": ["srv"], "ip": ["9443"]}
	  ]
	}`
}

func TestAPIV1PolicySimulate(t *testing.T) {
	h, ips := simEnv(t)
	pol := policyFor(ips)

	run := func(t *testing.T, policy string, q ...map[string]any) []simResult {
		t.Helper()

		res := h.post(t, "/api/v1/policy/simulate", map[string]any{"policy": policy, "queries": q})
		require.Equal(t, http.StatusOK, res.status, string(res.body))

		var out struct {
			Results []simResult `json:"results"`
		}
		require.NoError(t, json.Unmarshal(res.body, &out))
		require.Len(t, out.Results, len(q))

		return out.Results
	}

	t.Run("allows exactly what the policy grants", func(t *testing.T) {
		r := run(t, pol,
			map[string]any{"src": "laptop", "dst": "server", "port": 22},
			map[string]any{"src": "laptop", "dst": "server", "port": 8085},
			map[string]any{"src": "laptop", "dst": "server", "port": 9443},
			map[string]any{"src": "phone", "dst": "server", "port": 9443},
			map[string]any{"src": "phone", "dst": "server", "port": 22},
			map[string]any{"src": "phone", "dst": "laptop", "port": 22},
			map[string]any{"src": "laptop", "dst": "server", "port": 53, "proto": "udp"},
		)

		want := []bool{true, true, false, true, false, false, false}
		for i, w := range want {
			assert.Equal(t, w, r[i].Allowed, "query %d", i)
		}

		require.NotNil(t, r[0].Rule)
		assert.Contains(t, r[0].Rule.DstPorts[0], ips["server"])
	})

	t.Run("accepts nodes by IP as well as by name", func(t *testing.T) {
		r := run(t, pol, map[string]any{"src": ips["laptop"], "dst": ips["server"], "port": 22})
		assert.True(t, r[0].Allowed)
	})

	t.Run("unknown nodes and protocols are reported, not 500s", func(t *testing.T) {
		r := run(t, pol,
			map[string]any{"src": "nobody", "dst": "server", "port": 22},
			map[string]any{"src": "laptop", "dst": "server", "port": 22, "proto": "sctp"},
		)
		assert.False(t, r[0].Allowed)
		assert.Contains(t, r[0].Error, "nobody")
		assert.Contains(t, r[1].Error, "proto")
	})

	t.Run("an invalid draft is a 400 and nothing is stored", func(t *testing.T) {
		res := h.post(t, "/api/v1/policy/simulate", map[string]any{
			"policy":  `{"grants":[{"src":["group:nope"],"dst":["*"],"ip":["*"]}]}`,
			"queries": []map[string]any{{"src": "laptop", "dst": "server", "port": 22}},
		})
		assert.Equal(t, http.StatusBadRequest, res.status)
		assert.Contains(t, string(res.body), "group:nope")
	})

	t.Run("an empty policy means allow all", func(t *testing.T) {
		r := run(t, "", map[string]any{"src": "phone", "dst": "laptop", "port": 22})
		assert.True(t, r[0].Allowed)
	})

	t.Run("reachability lists only permitted pairs", func(t *testing.T) {
		res := h.post(t, "/api/v1/policy/reachability", map[string]any{"policy": pol})
		require.Equal(t, http.StatusOK, res.status, string(res.body))

		var out struct {
			Nodes []struct{ ID, Name string } `json:"nodes"`
			Edges []struct {
				Src, Dst string
				Access   []string
			} `json:"edges"`
		}
		require.NoError(t, json.Unmarshal(res.body, &out))

		name := map[string]string{}
		for _, n := range out.Nodes {
			name[n.ID] = n.Name
		}

		got := map[string][]string{}
		for _, e := range out.Edges {
			got[name[e.Src]+">"+name[e.Dst]] = e.Access
		}

		assert.Len(t, got, 2, "laptop>server and phone>server only")
		assert.ElementsMatch(t, []string{"tcp:22", "tcp:8000-8100"}, got["laptop>server"])
		assert.Equal(t, []string{"any:9443"}, got["phone>server"])
	})
}

func TestAPIV1EventsAndTraffic(t *testing.T) {
	h, ips := simEnv(t)

	t.Run("registration is logged", func(t *testing.T) {
		res := h.callHuma(http.MethodGet, "/api/v1/events?type=node.registered", nil)
		require.Equal(t, http.StatusOK, res.status, string(res.body))

		var out struct {
			Events []struct {
				Type     string `json:"type"`
				NodeName string `json:"nodeName"`
				User     string `json:"user"`
			} `json:"events"`
		}
		require.NoError(t, json.Unmarshal(res.body, &out))
		require.Len(t, out.Events, 3)

		names := map[string]string{}
		for _, e := range out.Events {
			names[e.NodeName] = e.User
		}

		assert.Equal(t, map[string]string{"laptop": "alice", "server": "ops", "phone": "bob"}, names)
	})

	t.Run("a policy change is logged", func(t *testing.T) {
		res := h.callHuma(http.MethodPut, "/api/v1/policy", mustJSON(t, map[string]any{"policy": policyFor(ips)}))
		require.Equal(t, http.StatusOK, res.status, string(res.body))

		ev := h.callHuma(http.MethodGet, "/api/v1/events?type=policy.updated", nil)
		assert.Contains(t, string(ev.body), "policy.updated")
	})

	t.Run("bad windows are a 400", func(t *testing.T) {
		assert.Equal(t, http.StatusBadRequest, h.callHuma(http.MethodGet, "/api/v1/events?window=soon", nil).status)
		assert.Equal(t, http.StatusBadRequest, h.callHuma(http.MethodGet, "/api/v1/traffic?window=-5m", nil).status)
	})

	t.Run("reported flows show up as traffic", func(t *testing.T) {
		flow := func(bytes int) map[string]any {
			return map[string]any{"src": ips["laptop"], "dst": ips["server"], "proto": 6, "dport": 22, "bytes": bytes, "packets": 3, "conns": 1}
		}

		// both ends report the same connection; it must not be counted twice
		for _, reporter := range []string{ips["laptop"], ips["server"]} {
			res := h.post(t, "/api/v1/flows", map[string]any{
				"reporter": reporter,
				"flows":    []map[string]any{flow(1000)},
				"counters": map[string]any{"rxBytes": 10, "txBytes": 20},
			})
			require.Equal(t, http.StatusOK, res.status, string(res.body))
		}

		res := h.callHuma(http.MethodGet, "/api/v1/traffic?window=1h", nil)
		require.Equal(t, http.StatusOK, res.status, string(res.body))

		var out struct {
			Window string `json:"window"`
			Edges  []struct {
				Src, Dst string
				Bytes    int64
			} `json:"edges"`
			Services []struct {
				DPort int64 `json:"dport"`
			} `json:"services"`
			Nodes []struct{ Node string } `json:"nodes"`
		}
		require.NoError(t, json.Unmarshal(res.body, &out))

		assert.Equal(t, "1h0m0s", out.Window)
		require.Len(t, out.Edges, 1)
		assert.EqualValues(t, 1000, out.Edges[0].Bytes, "reported by both ends, counted once")
		require.Len(t, out.Services, 1)
		assert.EqualValues(t, 22, out.Services[0].DPort)
		assert.Len(t, out.Nodes, 2, "client counters kept per reporting node")
	})
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()

	b, err := json.Marshal(v)
	require.NoError(t, err)

	return b
}
