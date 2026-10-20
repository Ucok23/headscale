// Command hs-flow-agent reports a node's tailnet traffic to a headscale server.
//
// Run it as root on each node (it reads the kernel's connection tracking
// table). It sends per-connection traffic seen on the tailnet plus the
// client's own byte counters, which headscale shows as network flow and
// per-node traffic.
//
//	hs-flow-agent --server https://headscale.example.com --key-file /etc/hs-flow-agent.key
//
// Use an OAuth client limited to the `flows` scope as the key (create one on the
// Keys page of the admin UI). An admin API key also works but is all-access.
//
// Byte counts need conntrack accounting: sysctl -w net.netfilter.nf_conntrack_acct=1
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type report struct {
	Reporter string      `json:"reporter"`
	Time     int64       `json:"time"`
	Flows    []flowDelta `json:"flows"`
	Counters *counters   `json:"counters,omitempty"`
}

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

func main() {
	var prefixes listFlag

	server := flag.String("server", "", "headscale base URL, e.g. https://headscale.example.com")
	keyFlag := flag.String("key", "", "credential: an OAuth client secret (hskey-client-…) or an API key; prefer --key-file or HEADSCALE_KEY, flags show up in `ps`")
	keyFile := flag.String("key-file", "", "file containing the credential (use with systemd LoadCredential or mode 600)")
	self := flag.String("self", "", "this node's tailnet IP (default: from `tailscale ip -4`)")
	interval := flag.Duration("interval", 15*time.Second, "how often to report")
	source := flag.String("source", "/proc/net/nf_conntrack", "conntrack table to read")
	tsBin := flag.String("tailscale", "tailscale", "tailscale CLI, for client byte counters")
	tsSocket := flag.String("tailscale-socket", "", "tailscaled socket (default: the CLI's default)")
	noMetrics := flag.Bool("no-metrics", false, "do not report client byte counters")
	once := flag.Bool("once", false, "take two samples one interval apart, print the report, and exit (no upload)")
	flag.Var(&prefixes, "prefix", "tailnet prefix to keep (repeatable; default 100.64.0.0/10 and fd7a:115c:a1e0::/48)")
	flag.Parse()

	secret := *keyFlag
	if *keyFile != "" {
		k, err := readKeyFile(*keyFile, func(m string) { fmt.Fprintln(os.Stderr, "warning:", m) })
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}

		secret = k
	}

	if secret == "" {
		secret = firstNonEmpty(os.Getenv("HEADSCALE_KEY"), os.Getenv("HEADSCALE_API_KEY"))
	}

	if !*once && (*server == "" || secret == "") {
		fmt.Fprintln(os.Stderr, "need --server and a credential (--key-file, HEADSCALE_KEY or --key); or use --once to try it out")
		os.Exit(2)
	}

	cred := newCredential(*server, secret)

	if secret != "" && !cred.isOAuth() {
		fmt.Fprintln(os.Stderr, "warning: using an API key, which has full admin access. Prefer an OAuth client limited to the `flows` scope.")
	}

	if len(prefixes) == 0 {
		prefixes = listFlag{"100.64.0.0/10", "fd7a:115c:a1e0::/48"}
	}

	var pfx []netip.Prefix

	for _, p := range prefixes {
		pp, err := netip.ParsePrefix(p)
		if err != nil {
			fmt.Fprintf(os.Stderr, "bad --prefix %q: %v\n", p, err)
			os.Exit(2)
		}

		pfx = append(pfx, pp)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	reporter := *self
	if reporter == "" {
		out, err := exec.CommandContext(ctx, *tsBin, "ip", "-4").Output()
		if err != nil {
			fmt.Fprintln(os.Stderr, "cannot find this node's tailnet IP; pass --self:", err)
			os.Exit(1)
		}

		reporter = strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	}

	tr := newTracker()
	keep := tailnetOnly(pfx)
	warned := false
	tick := time.NewTicker(*interval)

	defer tick.Stop()

	poll := func() {
		f, err := os.Open(*source)
		if err != nil {
			fmt.Fprintln(os.Stderr, "reading conntrack:", err)

			return
		}
		defer f.Close()

		conns, sawCounters, err := parseConntrack(f, keep)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)

			return
		}

		if len(conns) > 0 && !sawCounters && !warned {
			warned = true

			fmt.Fprintln(os.Stderr, "conntrack has no byte counters; enable with: sysctl -w net.netfilter.nf_conntrack_acct=1")
		}

		tr.observe(conns)
	}

	buildReport := func(flows []flowDelta) report {
		r := report{Reporter: reporter, Time: time.Now().Unix(), Flows: flows}
		if !*noMetrics {
			if c, ok := readMetrics(ctx, *tsBin, *tsSocket); ok {
				r.Counters = &c
			}
		}

		return r
	}

	poll() // baseline

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}

		poll()

		if *once {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			_ = enc.Encode(buildReport(tr.snapshot()))

			return
		}

		rep := buildReport(tr.snapshot())
		if len(rep.Flows) == 0 && rep.Counters == nil {
			continue
		}

		if err := send(ctx, cred, rep); err != nil {
			fmt.Fprintln(os.Stderr, "report failed, will retry with the next interval:", err)

			continue
		}

		tr.drain()
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}

	return ""
}

func send(ctx context.Context, cred *credential, r report) error {
	body, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("encoding report: %w", err)
	}

	// One retry: a cached OAuth token may have been revoked or expired early.
	for attempt := 0; ; attempt++ {
		status, err := post(ctx, cred, body)
		if err != nil {
			return err
		}

		if status == http.StatusUnauthorized && attempt == 0 && cred.isOAuth() {
			cred.forget()

			continue
		}

		if status/100 != 2 {
			return fmt.Errorf("server answered HTTP %d", status)
		}

		return nil
	}
}

func post(ctx context.Context, cred *credential, body []byte) (int, error) {
	token, err := cred.bearer(ctx)
	if err != nil {
		return 0, err
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cred.flowsURL(), bytes.NewReader(body))
	if err != nil {
		return 0, fmt.Errorf("building request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("sending: %w", err)
	}
	defer resp.Body.Close()

	return resp.StatusCode, nil
}
