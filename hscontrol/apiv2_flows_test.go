package hscontrol

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAPIv2Flows_ScopeEnforcement(t *testing.T) {
	app, base, admin := newOAuthTestServer(t)

	_, flowsSecret := createClient(t, base, admin, []string{"flows"}, nil)
	_, readSecret := createClient(t, base, admin, []string{"flows:read"}, nil)
	_, otherSecret := createClient(t, base, admin, []string{"devices:core:read"}, nil)

	url := base + "/api/v2/tailnet/-/flows"
	report := map[string]any{
		"reporter": "100.64.0.1",
		"flows": []map[string]any{
			{"src": "100.64.0.1", "dst": "100.64.0.2", "proto": 6, "dport": 22, "bytes": 4096, "packets": 12, "conns": 1},
		},
	}

	t.Run("a flows-scoped token may report", func(t *testing.T) {
		status, body := apiPost(t, url, tokenFor(t, base, flowsSecret), report)
		require.Equal(t, 200, status, string(body))
		assert.Contains(t, string(body), `"accepted":1`)

		tr, err := app.state.Activity.Traffic(time.Now().Add(-time.Hour))
		require.NoError(t, err)
		require.Len(t, tr.Edges, 1)
		assert.EqualValues(t, 4096, tr.Edges[0].Bytes)
	})

	t.Run("an admin API key may report", func(t *testing.T) {
		status, _ := apiPost(t, url, admin, report)
		assert.Equal(t, 200, status)
	})

	t.Run("the read scope cannot write", func(t *testing.T) {
		status, _ := apiPost(t, url, tokenFor(t, base, readSecret), report)
		assert.Equal(t, 403, status)
	})

	t.Run("an unrelated scope cannot write", func(t *testing.T) {
		status, _ := apiPost(t, url, tokenFor(t, base, otherSecret), report)
		assert.Equal(t, 403, status)
	})

	t.Run("no credential", func(t *testing.T) {
		status, _ := apiPost(t, url, "", report)
		assert.Equal(t, 401, status)
	})

	t.Run("a flows token can do nothing else", func(t *testing.T) {
		tok := tokenFor(t, base, flowsSecret)
		assert.Equal(t, 403, apiGet(t, base+"/api/v2/tailnet/-/acl", tok))
		assert.Equal(t, 403, apiGet(t, base+"/api/v2/tailnet/-/devices", tok))

		// Listing keys is filtered by scope rather than refused, so it shows nothing
		// but must not be a way to mint credentials.
		status, _ := apiPost(t, base+"/api/v2/tailnet/-/keys", tok, map[string]any{"keyType": "client", "scopes": []string{"all"}})
		assert.Equal(t, 403, status, "a flows token must not be able to create an all-access client")
	})

	t.Run("only the default tailnet exists", func(t *testing.T) {
		status, _ := apiPost(t, base+"/api/v2/tailnet/other/flows", admin, report)
		assert.Equal(t, 404, status)
	})

	t.Run("an invalid flow is a 400", func(t *testing.T) {
		bad := map[string]any{"reporter": "r", "flows": []map[string]any{
			{"src": "a", "dst": "b", "proto": 6, "dport": 1, "bytes": -1, "packets": 0, "conns": 0},
		}}
		status, _ := apiPost(t, url, admin, bad)
		assert.Equal(t, 400, status)
	})

	t.Run("a malformed body is rejected by the schema", func(t *testing.T) {
		status, _ := apiPost(t, url, admin, map[string]any{"flows": "nope"})
		assert.Equal(t, 422, status)
	})
}
