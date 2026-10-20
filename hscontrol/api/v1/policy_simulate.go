package apiv1

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"slices"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	policyv2 "github.com/juanfont/headscale/hscontrol/policy/v2"
	"github.com/juanfont/headscale/hscontrol/types"
	"github.com/juanfont/headscale/hscontrol/util"
	"go4.org/netipx"
	"tailscale.com/tailcfg"
)

func init() {
	registrations = append(registrations, registerPolicySimulate)
}

// IP protocol numbers used by filter rules. A rule without IPProto applies to
// these four (tailscale's default).
const (
	protoICMP   = 1
	protoTCP    = 6
	protoUDP    = 17
	protoICMPv6 = 58
)

var defaultProtos = []int{protoICMP, protoTCP, protoUDP, protoICMPv6}

// SimNode identifies a node in simulation results.
type SimNode struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	User string   `json:"user"`
	Tags []string `json:"tags" nullable:"false"`
	IPs  []string `json:"ips" nullable:"false"`
}

// SimRule is the compiled filter rule that allowed a flow, as the destination
// node's packet filter sees it.
type SimRule struct {
	Index    int      `json:"index"`
	SrcIPs   []string `json:"srcIps" nullable:"false"`
	DstPorts []string `json:"dstPorts" nullable:"false"`
	IPProto  []int    `json:"ipProto" nullable:"false"`
}

// SimulateQuery asks "may src reach dst on port/proto?". Src and Dst are a
// node id, name or IP. A Dst IP inside an approved subnet route resolves to the
// advertising node.
type SimulateQuery struct {
	Src   string `json:"src"`
	Dst   string `json:"dst"`
	Port  uint16 `json:"port,omitempty"`
	Proto string `json:"proto,omitempty" doc:"tcp (default), udp or icmp"`
}

type SimulateResult struct {
	Query   SimulateQuery `json:"query"`
	Src     *SimNode      `json:"src,omitempty"`
	Dst     *SimNode      `json:"dst,omitempty"`
	DstIP   string        `json:"dstIp,omitempty"`
	Allowed bool          `json:"allowed"`
	Rule    *SimRule      `json:"rule,omitempty"`
	Error   string        `json:"error,omitempty"`
}

type SimulateRequestBody struct {
	Policy  string          `json:"policy,omitempty" doc:"Draft policy (HuJSON). Empty means the currently stored policy."`
	Queries []SimulateQuery `json:"queries" nullable:"false"`
}

type SimulateResponseBody struct {
	Results []SimulateResult `json:"results" nullable:"false"`
}

// ReachEdge summarises everything src may send to dst.
type ReachEdge struct {
	Src    string   `json:"src"`
	Dst    string   `json:"dst"`
	Access []string `json:"access" nullable:"false" doc:"e.g. tcp:22, tcp:80-90, any:*"`
}

type ReachabilityRequestBody struct {
	Policy string `json:"policy,omitempty"`
}

type ReachabilityResponseBody struct {
	Nodes []SimNode   `json:"nodes" nullable:"false"`
	Edges []ReachEdge `json:"edges" nullable:"false"`
}

type (
	simulateInput  struct{ Body SimulateRequestBody }
	simulateOutput struct{ Body SimulateResponseBody }

	reachabilityInput  struct{ Body ReachabilityRequestBody }
	reachabilityOutput struct{ Body ReachabilityResponseBody }
)

func registerPolicySimulate(api huma.API, b Backend) {
	huma.Register(api, huma.Operation{
		OperationID: "simulatePolicy",
		Method:      http.MethodPost,
		Path:        "/api/v1/policy/simulate",
		Summary:     "Simulate flows against a policy",
		Description: "Evaluates whether src may reach dst on a port using the packet filter headscale would " +
			"send to the destination node, for a draft policy and the live users and nodes. Nothing is persisted. " +
			"Covers network access (ACLs/grants), not Tailscale SSH rules.",
		Tags:     []string{"Policy"},
		Security: bearerAuth,
	}, func(_ context.Context, in *simulateInput) (*simulateOutput, error) {
		sim, err := newSimulator(b, in.Body.Policy)
		if err != nil {
			return nil, err
		}

		out := &simulateOutput{}
		out.Body.Results = make([]SimulateResult, 0, len(in.Body.Queries))

		for _, q := range in.Body.Queries {
			out.Body.Results = append(out.Body.Results, sim.run(q))
		}

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "policyReachability",
		Method:      http.MethodPost,
		Path:        "/api/v1/policy/reachability",
		Summary:     "Compute who can reach whom under a policy",
		Description: "For every ordered pair of nodes, lists what src may send to dst under a draft policy. " +
			"Pairs with no access are omitted.",
		Tags:     []string{"Policy"},
		Security: bearerAuth,
	}, func(_ context.Context, in *reachabilityInput) (*reachabilityOutput, error) {
		sim, err := newSimulator(b, in.Body.Policy)
		if err != nil {
			return nil, err
		}

		return &reachabilityOutput{Body: sim.reachability()}, nil
	})
}

type simulator struct {
	pm    *policyv2.PolicyManager
	nodes []types.NodeView
}

func newSimulator(b Backend, draft string) (*simulator, error) {
	if strings.TrimSpace(draft) == "" && b.Cfg.Policy.Mode == types.PolicyModeDB {
		if p, err := b.State.GetPolicy(); err == nil {
			draft = p.Data
		}
	}

	users, err := b.State.ListAllUsers()
	if err != nil {
		return nil, huma.Error500InternalServerError("loading users", err)
	}

	nodes := b.State.ListNodes()

	pm, err := policyv2.NewPolicyManager([]byte(draft), users, nodes)
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error(), err)
	}

	s := &simulator{pm: pm}
	for _, n := range nodes.All() {
		s.nodes = append(s.nodes, n)
	}

	return s, nil
}

func (s *simulator) simNode(n types.NodeView) *SimNode {
	ips := make([]string, 0, 2)
	for _, ip := range n.IPs() {
		ips = append(ips, ip.String())
	}

	return &SimNode{
		ID:   n.StringID(),
		Name: n.GivenName(),
		User: n.User().Name(),
		Tags: append([]string{}, n.Tags().AsSlice()...),
		IPs:  ips,
	}
}

// resolve finds a node by id, given name, hostname or IP. When ref is an IP
// that is not a node address, the node advertising an approved subnet route
// containing it is returned.
func (s *simulator) resolve(ref string) (types.NodeView, *netip.Addr, bool) {
	ref = strings.TrimSpace(ref)

	if ip, err := netip.ParseAddr(ref); err == nil {
		for _, n := range s.nodes {
			if slices.Contains(n.IPs(), ip) {
				return n, &ip, true
			}
		}

		for _, n := range s.nodes {
			for _, r := range n.SubnetRoutes() {
				if r.Contains(ip) {
					return n, &ip, true
				}
			}
		}

		return types.NodeView{}, nil, false
	}

	for _, n := range s.nodes {
		if n.StringID() == ref || n.GivenName() == ref || n.Hostname() == ref {
			return n, nil, true
		}
	}

	return types.NodeView{}, nil, false
}

func protoNumber(p string) (int, error) {
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "", "tcp":
		return protoTCP, nil
	case "udp":
		return protoUDP, nil
	case "icmp":
		return protoICMP, nil
	}

	return 0, fmt.Errorf("unsupported proto %q (use tcp, udp or icmp)", p)
}

func protoName(n int) string {
	switch n {
	case protoTCP:
		return "tcp"
	case protoUDP:
		return "udp"
	case protoICMP, protoICMPv6:
		return "icmp"
	}

	return strconv.Itoa(n)
}

// hit is one filter rule that lets src reach dstIP, with the destination
// entries (port ranges) that apply to dstIP.
type hit struct {
	index int
	rule  tailcfg.FilterRule
	dsts  []tailcfg.NetPortRange
}

func parseSet(entries []string) *netipx.IPSet {
	var b netipx.IPSetBuilder

	for _, e := range entries {
		if set, err := util.ParseIPSet(e, nil); err == nil {
			b.AddSet(set)
		}
	}

	set, _ := b.IPSet()

	return set
}

// hits returns the rules in dst's packet filter that admit traffic from any of
// srcIPs to dstIP.
func (s *simulator) hits(dst types.NodeView, srcIPs []netip.Addr, dstIP netip.Addr) []hit {
	rules, err := s.pm.FilterForNode(dst)
	if err != nil {
		return nil
	}

	var out []hit

	for i, rule := range rules {
		src := parseSet(rule.SrcIPs)
		if !slices.ContainsFunc(srcIPs, src.Contains) {
			continue
		}

		var dsts []tailcfg.NetPortRange

		for _, dp := range rule.DstPorts {
			if set, err := util.ParseIPSet(dp.IP, nil); err == nil && set.Contains(dstIP) {
				dsts = append(dsts, dp)
			}
		}

		if len(dsts) > 0 {
			out = append(out, hit{index: i, rule: rule, dsts: dsts})
		}
	}

	return out
}

func ruleProtos(r tailcfg.FilterRule) []int {
	if len(r.IPProto) == 0 {
		return defaultProtos
	}

	return r.IPProto
}

func (s *simulator) run(q SimulateQuery) SimulateResult {
	res := SimulateResult{Query: q}

	proto, err := protoNumber(q.Proto)
	if err != nil {
		res.Error = err.Error()

		return res
	}

	src, _, ok := s.resolve(q.Src)
	if !ok {
		res.Error = fmt.Sprintf("source %q is not a known node or node IP", q.Src)

		return res
	}

	dst, dstExplicit, ok := s.resolve(q.Dst)
	if !ok {
		res.Error = fmt.Sprintf("destination %q is not a known node, node IP or approved subnet route", q.Dst)

		return res
	}

	res.Src, res.Dst = s.simNode(src), s.simNode(dst)

	dstIPs := dst.IPs()
	if dstExplicit != nil {
		dstIPs = []netip.Addr{*dstExplicit}
	}

	for _, dstIP := range dstIPs {
		for _, h := range s.hits(dst, src.IPs(), dstIP) {
			if !slices.ContainsFunc(ruleProtos(h.rule), func(p int) bool {
				return p == proto || (proto == protoICMP && p == protoICMPv6)
			}) {
				continue
			}

			portOK := proto == protoICMP || slices.ContainsFunc(h.dsts, func(d tailcfg.NetPortRange) bool {
				return q.Port >= d.Ports.First && q.Port <= d.Ports.Last
			})
			if !portOK {
				continue
			}

			res.Allowed = true
			res.DstIP = dstIP.String()
			res.Rule = &SimRule{
				Index:    h.index,
				SrcIPs:   append([]string{}, h.rule.SrcIPs...),
				DstPorts: formatDsts(h.dsts),
				IPProto:  append([]int{}, h.rule.IPProto...),
			}

			return res
		}
	}

	if len(dstIPs) > 0 {
		res.DstIP = dstIPs[0].String()
	}

	return res
}

func formatPorts(p tailcfg.PortRange) string {
	switch {
	case p.First == 0 && p.Last == 65535:
		return "*"
	case p.First == p.Last:
		return strconv.Itoa(int(p.First))
	}

	return fmt.Sprintf("%d-%d", p.First, p.Last)
}

func formatDsts(dsts []tailcfg.NetPortRange) []string {
	out := make([]string, 0, len(dsts))
	for _, d := range dsts {
		out = append(out, d.IP+":"+formatPorts(d.Ports))
	}

	return out
}

func (s *simulator) reachability() ReachabilityResponseBody {
	out := ReachabilityResponseBody{Nodes: []SimNode{}, Edges: []ReachEdge{}}

	for _, n := range s.nodes {
		out.Nodes = append(out.Nodes, *s.simNode(n))
	}

	for _, src := range s.nodes {
		for _, dst := range s.nodes {
			if src.ID() == dst.ID() {
				continue
			}

			set := map[string]struct{}{}

			for _, dstIP := range dst.IPs() {
				for _, h := range s.hits(dst, src.IPs(), dstIP) {
					protos := ruleProtos(h.rule)

					label := "any"
					if len(h.rule.IPProto) > 0 {
						names := make([]string, 0, len(protos))
						for _, p := range protos {
							if n := protoName(p); !slices.Contains(names, n) {
								names = append(names, n)
							}
						}

						label = strings.Join(names, "+")
					}

					for _, d := range h.dsts {
						set[label+":"+formatPorts(d.Ports)] = struct{}{}
					}
				}
			}

			if len(set) == 0 {
				continue
			}

			access := make([]string, 0, len(set))
			for a := range set {
				access = append(access, a)
			}

			slices.Sort(access)

			out.Edges = append(out.Edges, ReachEdge{Src: src.StringID(), Dst: dst.StringID(), Access: access})
		}
	}

	return out
}
