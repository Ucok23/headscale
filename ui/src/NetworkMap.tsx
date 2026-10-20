import { useEffect, useMemo, useState } from 'react'
import { api, type ReachEdge, type SimNode } from './api/client'
import { bytes, proto } from './lib/format'
import { useNodes } from './Machines'
import { useTraffic } from './useTraffic'

const W = 900, H = 560, R = 34

function hue(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

type Mode = 'policy' | 'traffic'

export function NetworkMap() {
  const { nodes: live } = useNodes(5000)
  const [nodes, setNodes] = useState<SimNode[]>([])
  const [edges, setEdges] = useState<ReachEdge[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<Mode>('policy')
  const [win, setWin] = useState('1h')
  const traffic = useTraffic(win)

  // Access is computed from the policy currently stored on the server.
  useEffect(() => {
    api.POST('/api/v1/policy/reachability', { body: { policy: '' } }).then(({ data, error }) => {
      if (error || !data) return setErr('Could not compute access from the stored policy.')
      setNodes(data.nodes); setEdges(data.edges)
    })
  }, [live?.length])

  const online = useMemo(() => new Map((live ?? []).map((n) => [n.id, n.online])), [live])
  const idByIp = useMemo(() => new Map(nodes.flatMap((n) => n.ips.map((ip) => [ip, n.id] as const))), [nodes])
  const nameOf = (ip: string) => nodes.find((n) => n.ips.includes(ip))?.name ?? ip

  // Traffic edges, keyed by node ids (a node has several IPs, so merge them).
  const flows = useMemo(() => {
    const m = new Map<string, { src: string; dst: string; bytes: number; conns: number }>()
    for (const e of traffic?.edges ?? []) {
      const s = idByIp.get(e.src), d = idByIp.get(e.dst)
      if (!s || !d || s === d) continue
      const k = `${s}>${d}`
      const cur = m.get(k) ?? { src: s, dst: d, bytes: 0, conns: 0 }
      cur.bytes += e.bytes; cur.conns += e.conns
      m.set(k, cur)
    }
    return [...m.values()]
  }, [traffic, idByIp])
  const maxBytes = Math.max(1, ...flows.map((f) => f.bytes))
  const allowed = useMemo(() => new Set(edges.map((e) => `${e.src}>${e.dst}`)), [edges])

  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    // Group by owner so machines of the same user sit next to each other.
    const sorted = [...nodes].sort((a, b) => (a.tags.length ? 'zz' : a.user).localeCompare(b.tags.length ? 'zz' : b.user) || a.name.localeCompare(b.name))
    sorted.forEach((n, i) => {
      const a = (i / Math.max(1, sorted.length)) * Math.PI * 2 - Math.PI / 2
      m.set(n.id, { x: W / 2 + Math.cos(a) * (W / 2 - 130), y: H / 2 + Math.sin(a) * (H / 2 - 80) })
    })
    return m
  }, [nodes])

  const focus = hover ?? sel
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // Unified edge list for drawing, depending on the mode.
  type Draw = { src: string; dst: string; label: string; width: number; bad?: boolean }
  const draw: Draw[] = mode === 'policy'
    ? edges.map((e) => ({ src: e.src, dst: e.dst, label: e.access.map((x) => x.replace(/^any:/, '')).join(' · '), width: 1.4 }))
    : flows.map((f) => ({
        src: f.src, dst: f.dst, label: bytes(f.bytes),
        width: 1.6 + 7 * Math.sqrt(f.bytes / maxBytes),
        bad: !allowed.has(`${f.src}>${f.dst}`),
      }))
  const pairs = new Set(draw.map((e) => `${e.src}>${e.dst}`))
  const related = (e: Draw) => !focus || e.src === focus || e.dst === focus
  const outs = focus ? draw.filter((e) => e.src === focus) : []
  const ins = focus ? draw.filter((e) => e.dst === focus) : []

  const svc = (traffic?.services ?? []).filter((s) => {
    if (!focus) return true
    const id = (ip: string) => idByIp.get(ip)
    return id(s.src) === focus || id(s.dst) === focus
  }).slice(0, 8)
  const counters = focus ? traffic?.nodes.find((n) => byId.get(focus)?.ips.includes(n.node)) : undefined
  const total = (traffic?.edges ?? []).reduce((a, e) => a + e.bytes, 0)

  if (!nodes.length) return <div className="app"><header><h1>Network</h1></header><p className="hint">{err || 'No machines yet.'}</p></div>

  return (
    <div className="app">
      <header>
        <h1>Network</h1>
        <div className="seg">
          <button className={mode === 'policy' ? 'on' : ''} onClick={() => setMode('policy')}>Allowed</button>
          <button className={mode === 'traffic' ? 'on' : ''} onClick={() => setMode('traffic')}>Traffic</button>
        </div>
        {mode === 'traffic' && (
          <select value={win} onChange={(e) => setWin(e.target.value)}>
            <option value="5m">Last 5 min</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
          </select>
        )}
        <span className="hint">
          {mode === 'policy' ? 'Arrows show what the stored policy allows.' : `Arrow width is the data sent over the window. ${bytes(total)} in total.`}
        </span>
      </header>
      {err && <div className="banner err">{err}</div>}
      {mode === 'traffic' && traffic && traffic.edges.length === 0 && (
        <div className="banner warn">No traffic reported in this window. Run <code>hs-flow-agent</code> on your machines to see real flows.</div>
      )}
      <div className="cols map">
        <section className="panel">
          <svg viewBox={`0 0 ${W} ${H}`} className="netsvg" onClick={() => setSel(null)}>
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="currentColor" />
              </marker>
            </defs>
            {draw.map((e) => {
              const a = pos.get(e.src), b = pos.get(e.dst)
              if (!a || !b) return null
              const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
              const ux = dx / len, uy = dy / len
              // bend each direction to its own side so A→B and B→A do not overlap
              const bend = pairs.has(`${e.dst}>${e.src}`) ? 26 : 8
              const sx = a.x + ux * R, sy = a.y + uy * R, ex = b.x - ux * (R + 8), ey = b.y - uy * (R + 8)
              const cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend
              const hot = !!focus && related(e)
              const showLabel = mode === 'traffic' ? !focus || hot : hot
              return (
                <g key={`${e.src}-${e.dst}`} className={`edge ${e.bad ? 'bad' : ''} ${focus ? (hot ? 'hot' : 'dim') : ''}`}>
                  <path d={`M${sx},${sy} Q${cx},${cy} ${ex},${ey}`} fill="none" stroke="currentColor" strokeWidth={hot ? e.width + 0.8 : e.width}
                    strokeDasharray={e.bad ? '6 4' : undefined} markerEnd="url(#arr)" />
                  {showLabel && <text x={cx} y={cy - 4} textAnchor="middle">{e.label}</text>}
                </g>
              )
            })}
            {nodes.map((n) => {
              const p = pos.get(n.id)!
              const up = online.get(n.id)
              const dim = focus && focus !== n.id && !draw.some((e) => (e.src === focus && e.dst === n.id) || (e.dst === focus && e.src === n.id))
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`node ${dim ? 'dim' : ''} ${sel === n.id ? 'sel' : ''}`}
                  onClick={(ev) => { ev.stopPropagation(); setSel(sel === n.id ? null : n.id) }}
                  onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                  <circle r={R} fill={`hsl(${n.tags.length ? 38 : hue(n.user)} 55% 45% / .28)`} stroke={`hsl(${n.tags.length ? 38 : hue(n.user)} 65% 55%)`} strokeWidth="2" />
                  <circle cx={R - 6} cy={-R + 6} r="6" className={up ? 'led on' : 'led'} />
                  <text className="nm" textAnchor="middle" y="4">{n.name}</text>
                  <text className="ow" textAnchor="middle" y={R + 16}>{n.tags.length ? n.tags.join(' ') : n.user}</text>
                  <text className="ip" textAnchor="middle" y={R + 30}>{n.ips[0]}</text>
                </g>
              )
            })}
          </svg>
          {mode === 'traffic' && traffic && <Spark series={traffic.series} />}
        </section>
        <section className="panel">
          <h2>{focus ? byId.get(focus)?.name : mode === 'traffic' ? 'All traffic' : 'Nothing selected'}</h2>
          {mode === 'policy' && !focus && <p className="hint">Hover or click a machine to see what it can reach and who can reach it.</p>}
          {focus && (
            <>
              <h3 className="mini">{mode === 'policy' ? 'Can reach' : 'Sent to'}</h3>
              {outs.length ? outs.map((e) => <Line key={e.dst} who={byId.get(e.dst)?.name ?? e.dst} text={e.label} bad={e.bad} />) : <p className="hint">Nothing.</p>}
              <h3 className="mini">{mode === 'policy' ? 'Reachable from' : 'Received from'}</h3>
              {ins.length ? ins.map((e) => <Line key={e.src} who={byId.get(e.src)?.name ?? e.src} text={e.label} bad={e.bad} />) : <p className="hint">Nothing.</p>}
            </>
          )}
          {mode === 'traffic' && (
            <>
              {counters && (
                <>
                  <h3 className="mini">Client counters</h3>
                  <div className="line"><strong>↓ {bytes(counters.rxBytes)}</strong><strong>↑ {bytes(counters.txBytes)}</strong><span className="sub">all peers, incl. relays</span></div>
                </>
              )}
              <h3 className="mini">Top services</h3>
              {svc.length === 0 ? <p className="hint">No traffic.</p> : (
                <table className="mini-table">
                  <tbody>
                    {svc.map((s, i) => (
                      <tr key={i}>
                        <td>{nameOf(s.src)} → {nameOf(s.dst)}</td>
                        <td className="mono">{proto(s.proto)}{s.proto === 6 || s.proto === 17 ? `:${s.dport}` : ''}</td>
                        <td className="mono r">{bytes(s.bytes)}</td>
                        <td className="sub r">{s.conns ? `${s.conns} conn` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {flows.some((f) => !allowed.has(`${f.src}>${f.dst}`)) && (
                <p className="hint bad">Dashed arrows are traffic the stored policy does not allow. Policy may have changed after it happened.</p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function Line({ who, text, bad }: { who: string; text: string; bad?: boolean }) {
  return <div className="line"><strong>{who}</strong><span className={`chip ${bad ? 'bad' : ''}`}>{text}</span></div>
}

/** Bytes per minute over the window. */
function Spark({ series }: { series: { time: number; bytes: number }[] }) {
  if (series.length < 2) return <p className="hint">Collecting data…</p>
  const w = 600, h = 56
  const t0 = series[0].time, t1 = series[series.length - 1].time || t0 + 1
  const max = Math.max(1, ...series.map((p) => p.bytes))
  const pts = series.map((p) => `${((p.time - t0) / Math.max(1, t1 - t0)) * w},${h - 4 - (p.bytes / max) * (h - 10)}`).join(' ')
  return (
    <div className="spark">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>
      <span className="sub">traffic over time · peak {bytes(max)}/min</span>
    </div>
  )
}
