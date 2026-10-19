package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// credential authenticates the agent to headscale.
//
// Two kinds are accepted. An OAuth client secret (hskey-client-…) limited to
// the `flows` scope is the one to use: it is exchanged for a one-hour token and
// can do nothing but report flows. An admin API key (hskey-api-…) also works,
// but is all-access, so a stolen one controls the whole tailnet.
type credential struct {
	server string
	secret string
	client *http.Client

	mu      sync.Mutex
	token   string
	expires time.Time
}

const oauthPrefix = "hskey-client-"

func newCredential(server, secret string) *credential {
	return &credential{server: strings.TrimRight(server, "/"), secret: secret, client: &http.Client{Timeout: 10 * time.Second}}
}

func (c *credential) isOAuth() bool { return strings.HasPrefix(c.secret, oauthPrefix) }

// flowsURL is where reports go: the v2 endpoint for OAuth, v1 for an API key.
func (c *credential) flowsURL() string {
	if c.isOAuth() {
		return c.server + "/api/v2/tailnet/-/flows"
	}

	return c.server + "/api/v1/flows"
}

// bearer returns a token to send, exchanging the OAuth secret when needed.
func (c *credential) bearer(ctx context.Context) (string, error) {
	if !c.isOAuth() {
		return c.secret, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Refresh a minute early so a token never expires mid-request.
	if c.token != "" && time.Now().Before(c.expires.Add(-time.Minute)) {
		return c.token, nil
	}

	form := url.Values{"grant_type": {"client_credentials"}, "client_secret": {c.secret}}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.server+"/api/v2/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("building token request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("requesting token: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint answered %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tr); err != nil || tr.AccessToken == "" {
		return "", errors.New("token endpoint returned no access token")
	}

	c.token = tr.AccessToken
	c.expires = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)

	return c.token, nil
}

// forget drops a cached token, e.g. after the server rejected it.
func (c *credential) forget() {
	c.mu.Lock()
	c.token = ""
	c.mu.Unlock()
}

// readKeyFile reads a credential from a file. Surrounding whitespace is ignored.
// warn is called when other users can read the file.
func readKeyFile(path string, warn func(string)) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading key file: %w", err)
	}

	if st, err := os.Stat(path); err == nil && st.Mode().Perm()&0o077 != 0 {
		warn(fmt.Sprintf("%s is readable by other users (mode %o); run: chmod 600 %s", path, st.Mode().Perm(), path))
	}

	key := strings.TrimSpace(string(data))
	if key == "" {
		return "", fmt.Errorf("key file %s is empty", path)
	}

	return key, nil
}
