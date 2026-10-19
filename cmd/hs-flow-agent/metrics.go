package main

import (
	"bufio"
	"context"
	"os/exec"
	"strconv"
	"strings"
)

// counters are cumulative client byte counters.
type counters struct {
	RxBytes int64 `json:"rxBytes"`
	TxBytes int64 `json:"txBytes"`
}

// parseMetrics sums tailscaled's inbound/outbound byte counters over all
// paths (direct, DERP, peer relay). ok is false when neither was present.
func parseMetrics(text string) (c counters, ok bool) {
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		name, rest, found := strings.Cut(line, "{")
		if !found {
			name, rest, _ = strings.Cut(line, " ")
		}

		var val string
		if i := strings.LastIndex(rest, " "); i >= 0 {
			val = rest[i+1:]
		}

		n, err := strconv.ParseFloat(val, 64)
		if err != nil {
			continue
		}

		switch name {
		case "tailscaled_inbound_bytes_total":
			c.RxBytes += int64(n)
			ok = true
		case "tailscaled_outbound_bytes_total":
			c.TxBytes += int64(n)
			ok = true
		}
	}

	return c, ok
}

// readMetrics runs `tailscale metrics print`.
func readMetrics(ctx context.Context, tailscaleBin, socket string) (counters, bool) {
	args := []string{}
	if socket != "" {
		args = append(args, "--socket="+socket)
	}

	args = append(args, "metrics", "print")

	out, err := exec.CommandContext(ctx, tailscaleBin, args...).Output()
	if err != nil {
		return counters{}, false
	}

	return parseMetrics(string(out))
}
