package apiv2

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/juanfont/headscale/hscontrol/activity"
	"github.com/juanfont/headscale/hscontrol/scope"
)

func init() {
	registrations = append(registrations, registerFlows)
}

type reportFlowsInput struct {
	Tailnet string `path:"tailnet"`
	Body    activity.Report
}

type reportFlowsOutput struct {
	Body struct {
		Accepted int `json:"accepted"`
	}
}

// registerFlows is headscale-native (Tailscale has no such endpoint). It exists
// so a node's flow agent can run with an OAuth client limited to the `flows`
// scope instead of an all-access admin API key: if the agent's machine is
// compromised, the credential can report traffic and do nothing else.
func registerFlows(api huma.API, b Backend) {
	huma.Register(api, requireScope(huma.Operation{
		OperationID: "reportFlows",
		Method:      http.MethodPost,
		Path:        "/api/v2/tailnet/{tailnet}/flows",
		Summary:     "Report network flows",
		Description: "Used by hs-flow-agent. Send the traffic seen since the previous report as deltas. " +
			"Flows reported by both ends of a connection are not double counted.",
		Tags:     []string{"Activity"},
		Security: security,
		Errors:   []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound},
	}, scope.Flows), func(_ context.Context, in *reportFlowsInput) (*reportFlowsOutput, error) {
		err := requireDefaultTailnet(in.Tailnet)
		if err != nil {
			return nil, err
		}

		n, err := b.State.Activity.IngestReport(in.Body)
		if err != nil {
			return nil, huma.Error400BadRequest(err.Error(), err)
		}

		out := &reportFlowsOutput{}
		out.Body.Accepted = n

		return out, nil
	})
}
