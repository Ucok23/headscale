package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAPIKeyGoesToV1(t *testing.T) {
	c := newCredential("http://h.example/", "hskey-api-abc")
	assert.False(t, c.isOAuth())
	assert.Equal(t, "http://h.example/api/v1/flows", c.flowsURL())

	tok, err := c.bearer(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "hskey-api-abc", tok)
}

func TestOAuthClientExchangesAndCachesToken(t *testing.T) {
	var exchanges atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/v2/oauth/token", r.URL.Path)
		require.NoError(t, r.ParseForm())
		assert.Equal(t, "hskey-client-id-secret", r.PostForm.Get("client_secret"))
		assert.Equal(t, "client_credentials", r.PostForm.Get("grant_type"))
		exchanges.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"hskey-oauthtok-1","token_type":"Bearer","expires_in":3600}`))
	}))
	defer srv.Close()

	c := newCredential(srv.URL, "hskey-client-id-secret")
	assert.True(t, c.isOAuth())
	assert.Equal(t, srv.URL+"/api/v2/tailnet/-/flows", c.flowsURL())

	for range 3 {
		tok, err := c.bearer(context.Background())
		require.NoError(t, err)
		assert.Equal(t, "hskey-oauthtok-1", tok)
	}

	assert.EqualValues(t, 1, exchanges.Load(), "the token is reused until shortly before it expires")

	c.forget()
	_, err := c.bearer(context.Background())
	require.NoError(t, err)
	assert.EqualValues(t, 2, exchanges.Load(), "forgetting forces a new exchange")
}

func TestOAuthRejectedClientSurfacesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_client"}`))
	}))
	defer srv.Close()

	_, err := newCredential(srv.URL, "hskey-client-x-y").bearer(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid_client")
}

func TestSendRetriesOnceWithFreshToken(t *testing.T) {
	var tokens, posts atomic.Int32

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v2/oauth/token", func(w http.ResponseWriter, _ *http.Request) {
		n := tokens.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"tok` + string(rune('0'+n)) + `","expires_in":3600}`))
	})
	mux.HandleFunc("/api/v2/tailnet/-/flows", func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		// the first token was revoked server-side; only the second works
		if r.Header.Get("Authorization") != "Bearer tok2" {
			w.WriteHeader(http.StatusUnauthorized)

			return
		}

		_, _ = w.Write([]byte(`{"accepted":0}`))
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	require.NoError(t, send(context.Background(), newCredential(srv.URL, "hskey-client-a-b"), report{Reporter: "100.64.0.1"}))
	assert.EqualValues(t, 2, tokens.Load())
	assert.EqualValues(t, 2, posts.Load())
}

func TestSendDoesNotRetryAPIKeys(t *testing.T) {
	var posts atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		posts.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	err := send(context.Background(), newCredential(srv.URL, "hskey-api-x"), report{Reporter: "r"})
	require.Error(t, err)
	assert.EqualValues(t, 1, posts.Load())
}

func TestReadKeyFile(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good")
	require.NoError(t, os.WriteFile(good, []byte("  hskey-client-a-b\n"), 0o600))

	var warned []string

	key, err := readKeyFile(good, func(m string) { warned = append(warned, m) })
	require.NoError(t, err)
	assert.Equal(t, "hskey-client-a-b", key, "whitespace is trimmed")
	assert.Empty(t, warned)

	open := filepath.Join(dir, "open")
	require.NoError(t, os.WriteFile(open, []byte("k"), 0o644)) //nolint:gosec // the point of the test
	_, err = readKeyFile(open, func(m string) { warned = append(warned, m) })
	require.NoError(t, err)
	require.Len(t, warned, 1, "a world-readable key file is flagged")
	assert.Contains(t, warned[0], "chmod 600")

	empty := filepath.Join(dir, "empty")
	require.NoError(t, os.WriteFile(empty, []byte("\n"), 0o600))
	_, err = readKeyFile(empty, func(string) {})
	assert.Error(t, err)

	_, err = readKeyFile(filepath.Join(dir, "missing"), func(string) {})
	assert.Error(t, err)
}
