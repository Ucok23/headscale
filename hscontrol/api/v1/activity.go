package apiv1

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/juanfont/headscale/hscontrol/activity"
)

func init() {
	registrations = append(registrations, registerActivity)
}

// maxFlowBatch bounds one agent report so a misbehaving agent cannot make a
// single request arbitrarily expensive.
const maxFlowBatch = 5000

// parseWindow understands Go durations ("90m", "24h") plus "Nd" for days.
func parseWindow(s string, def time.Duration) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return def, nil
	}

	if days, ok := strings.CutSuffix(s, "d"); ok {
		n, err := strconv.Atoi(days)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("invalid window %q", s)
		}

		return time.Duration(n) * 24 * time.Hour, nil
	}

	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("invalid window %q (use e.g. 15m, 24h, 7d)", s)
	}

	return d, nil
}

type (
	listEventsInput struct {
		Type   []string `query:"type" doc:"Only these event types (repeatable), e.g. node.online."`
		Node   uint64   `query:"node" doc:"Only events about this node id."`
		Window string   `query:"window" doc:"How far back, e.g. 1h, 24h, 7d. Default 24h."`
		Before int64    `query:"before" doc:"Return events with an id lower than this, for paging."`
		Limit  int      `query:"limit" doc:"Max events (default 200, max 1000)."`
	}
	listEventsOutput struct {
		Body struct {
			Events []activity.Event `json:"events" nullable:"false"`
		}
	}

	FlowReport struct {
		Reporter string             `json:"reporter" doc:"The reporting node's tailnet IP."`
		Time     int64              `json:"time,omitempty" doc:"Unix seconds the sample was taken. Defaults to now."`
		Flows    []activity.Flow    `json:"flows" nullable:"false" doc:"Traffic since the previous report (deltas, not totals)."`
		Counters *activity.Counters `json:"counters,omitempty" doc:"Cumulative client byte counters."`
	}
	postFlowsInput struct {
		Body FlowReport
	}
	postFlowsOutput struct {
		Body struct {
			Accepted int `json:"accepted"`
		}
	}

	trafficInput struct {
		Window string `query:"window" doc:"How far back, e.g. 15m, 1h, 24h, 7d. Default 1h."`
	}
	trafficOutput struct {
		Body struct {
			Window   string                 `json:"window"`
			Edges    []activity.Edge        `json:"edges" nullable:"false"`
			Services []activity.Service     `json:"services" nullable:"false"`
			Series   []activity.Point       `json:"series" nullable:"false"`
			Nodes    []activity.NodeTraffic `json:"nodes" nullable:"false"`
		}
	}
)

func registerActivity(api huma.API, b Backend) {
	huma.Register(api, huma.Operation{
		OperationID: "listEvents",
		Method:      http.MethodGet,
		Path:        "/api/v1/events",
		Summary:     "List activity events",
		Description: "Control-plane events: nodes coming online or going offline, registrations, expiry, " +
			"renames, tag and route changes, policy updates, user and key changes. Newest first.",
		Tags:     []string{"Activity"},
		Security: bearerAuth,
	}, func(_ context.Context, in *listEventsInput) (*listEventsOutput, error) {
		win, err := parseWindow(in.Window, 24*time.Hour)
		if err != nil {
			return nil, huma.Error400BadRequest(err.Error(), err)
		}

		events, err := b.State.Activity.Events(activity.EventFilter{
			Types:  in.Type,
			NodeID: in.Node,
			Since:  time.Now().Add(-win).UnixMilli(),
			Before: in.Before,
			Limit:  in.Limit,
		})
		if err != nil {
			return nil, huma.Error500InternalServerError("listing events", err)
		}

		out := &listEventsOutput{}
		out.Body.Events = events

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "reportFlows",
		Method:      http.MethodPost,
		Path:        "/api/v1/flows",
		Summary:     "Report network flows",
		Description: "Used by the flow agent running on a node. Send the traffic seen since the previous " +
			"report as deltas. Flows reported by both ends of a connection are not double counted.",
		Tags:     []string{"Activity"},
		Security: bearerAuth,
	}, func(_ context.Context, in *postFlowsInput) (*postFlowsOutput, error) {
		if len(in.Body.Flows) > maxFlowBatch {
			return nil, huma.Error400BadRequest(fmt.Sprintf("at most %d flows per report", maxFlowBatch))
		}

		at := time.Now()
		if in.Body.Time > 0 {
			at = time.Unix(in.Body.Time, 0)
			// Agents have their own clocks; refuse samples far from ours.
			if d := time.Since(at); d > time.Hour || d < -5*time.Minute {
				return nil, huma.Error400BadRequest("report time is too far from the server's clock")
			}
		}

		err := b.State.Activity.Ingest(in.Body.Reporter, at, in.Body.Flows, in.Body.Counters)
		if err != nil {
			return nil, huma.Error400BadRequest(err.Error(), err)
		}

		out := &postFlowsOutput{}
		out.Body.Accepted = len(in.Body.Flows)

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getTraffic",
		Method:      http.MethodGet,
		Path:        "/api/v1/traffic",
		Summary:     "Summarise network traffic",
		Description: "Traffic between nodes over a window, from agent reports: per node pair, per " +
			"destination port, as a time series, and per node totals from client counters.",
		Tags:     []string{"Activity"},
		Security: bearerAuth,
	}, func(_ context.Context, in *trafficInput) (*trafficOutput, error) {
		win, err := parseWindow(in.Window, time.Hour)
		if err != nil {
			return nil, huma.Error400BadRequest(err.Error(), err)
		}

		since := time.Now().Add(-win)

		t, err := b.State.Activity.Traffic(since)
		if err != nil {
			return nil, huma.Error500InternalServerError("aggregating traffic", err)
		}

		nodes, err := b.State.Activity.NodeTraffic(since)
		if err != nil {
			return nil, huma.Error500InternalServerError("aggregating node traffic", err)
		}

		out := &trafficOutput{}
		out.Body.Window = win.String()
		out.Body.Edges, out.Body.Services, out.Body.Series, out.Body.Nodes = t.Edges, t.Services, t.Series, nodes

		return out, nil
	})
}
