import type { SimNode, SimulateQuery, SimulateResult } from './api/client'

type Props = {
  nodes: SimNode[]
  query: SimulateQuery
  onChange: (q: SimulateQuery) => void
  result?: SimulateResult
  disabled: boolean
  onPin: (expect: boolean) => void
}

export function Playground({ nodes, query, onChange, result, disabled, onPin }: Props) {
  const set = (patch: Partial<SimulateQuery>) => onChange({ ...query, ...patch })
  const opts = nodes.map((n) => (
    <option key={n.id} value={n.name}>{n.name} ({n.user}{n.tags.length ? ` ${n.tags.join(',')}` : ''})</option>
  ))
  const icmp = query.proto === 'icmp'

  return (
    <div className="play">
      <div className="row">
        <label>From<select value={query.src} onChange={(e) => set({ src: e.target.value })}>{opts}</select></label>
        <span className="arrow">→</span>
        <label>To<select value={query.dst} onChange={(e) => set({ dst: e.target.value })}>{opts}</select></label>
        <label>Proto
          <select value={query.proto ?? 'tcp'} onChange={(e) => set({ proto: e.target.value })}>
            <option>tcp</option><option>udp</option><option>icmp</option>
          </select>
        </label>
        <label>Port
          <input type="number" min={0} max={65535} disabled={icmp} value={icmp ? '' : query.port ?? 0}
            onChange={(e) => set({ port: Number(e.target.value) })} />
        </label>
      </div>

      {disabled ? (
        <div className="verdict idle">Fix the policy to simulate.</div>
      ) : !result ? (
        <div className="verdict idle">…</div>
      ) : result.error ? (
        <div className="verdict idle">{result.error}</div>
      ) : (
        <div className={`verdict ${result.allowed ? 'allow' : 'deny'}`}>
          <strong>{result.allowed ? 'ALLOWED' : 'DENIED'}</strong>
          <span>
            {result.src?.name} → {result.dst?.name}
            {result.dstIp ? ` (${result.dstIp})` : ''}
            {!icmp && `:${query.port}`}/{query.proto ?? 'tcp'}
          </span>
          {result.rule ? (
            <code>rule #{result.rule.index}: {result.rule.srcIps.join(', ')} → {result.rule.dstPorts.join(', ')}</code>
          ) : (
            <em>No rule in the destination's packet filter matches this flow (default deny).</em>
          )}
        </div>
      )}

      <div className="row end">
        <span className="hint">Pin as a scenario to keep checking it:</span>
        <button className="ghost" disabled={disabled || !!result?.error} onClick={() => onPin(true)}>Must allow</button>
        <button className="ghost" disabled={disabled || !!result?.error} onClick={() => onPin(false)}>Must deny</button>
      </div>
    </div>
  )
}
