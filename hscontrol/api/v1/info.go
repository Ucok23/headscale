package apiv1

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/juanfont/headscale/hscontrol/types"
)

func init() {
	registrations = append(registrations, registerInfo)
}

// InfoResponseBody describes the server for UIs: what machines are called
// (MagicDNS) and where clients should log in.
type InfoResponseBody struct {
	Version    string `json:"version"`
	ServerURL  string `json:"serverUrl"`
	BaseDomain string `json:"baseDomain" doc:"MagicDNS suffix; a machine is reachable as <name>.<baseDomain>."`
	MagicDNS   bool   `json:"magicDns"`

	// DNS is read from the server's config file; it is not changeable through the API.
	OverrideLocalDNS bool                `json:"overrideLocalDns"`
	Nameservers      []string            `json:"nameservers" nullable:"false"`
	SplitDNS         map[string][]string `json:"splitDns" nullable:"false"`
	SearchDomains    []string            `json:"searchDomains" nullable:"false"`
	ExtraRecords     []InfoDNSRecord     `json:"extraRecords" nullable:"false"`
}

// InfoDNSRecord is one extra DNS record served by MagicDNS.
type InfoDNSRecord struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

type infoOutput struct {
	Body InfoResponseBody
}

func registerInfo(api huma.API, b Backend) {
	huma.Register(api, huma.Operation{
		OperationID: "getInfo",
		Method:      http.MethodGet,
		Path:        "/api/v1/info",
		Summary:     "Server information",
		Tags:        []string{"Health"},
		Security:    bearerAuth,
	}, func(_ context.Context, _ *struct{}) (*infoOutput, error) {
		out := &infoOutput{}
		out.Body.Version = types.GetVersionInfo().Version
		out.Body.ServerURL = b.Cfg.ServerURL
		out.Body.BaseDomain = b.Cfg.BaseDomain
		out.Body.MagicDNS = b.Cfg.DNSConfig.MagicDNS

		dns := b.Cfg.DNSConfig
		out.Body.OverrideLocalDNS = dns.OverrideLocalDNS
		out.Body.Nameservers = append([]string{}, dns.Nameservers.Global...)
		out.Body.SplitDNS = map[string][]string{}

		for domain, servers := range dns.Nameservers.Split {
			out.Body.SplitDNS[domain] = append([]string{}, servers...)
		}

		out.Body.SearchDomains = append([]string{}, dns.SearchDomains...)
		out.Body.ExtraRecords = []InfoDNSRecord{}

		for _, r := range dns.ExtraRecords {
			out.Body.ExtraRecords = append(out.Body.ExtraRecords, InfoDNSRecord{Name: r.Name, Type: r.Type, Value: r.Value})
		}

		return out, nil
	})
}
