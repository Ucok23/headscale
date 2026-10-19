import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, errMessage, type Info, type Node } from './api/client'
import { AddDevice } from './AddDevice'
import { useUsers } from './Users'
import { Copyable } from './Copy'
import { bytes } from './lib/format'
import { useTraffic } from './useTraffic'

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export function useNodes(intervalMs = 10000) {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const { data, error } = await api.GET('/api/v1/node')
    if (error) setError(errMessage(error))
    else { setError(''); setNodes(data.nodes) }
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, intervalMs)
    return () => clearInterval(t)
  }, [load, intervalMs])
  return { nodes, error, reload: load }
}

export function Machines() {
  const { nodes, error, reload } = useNodes()
  const traffic = useTraffic('1h', 15000)
  const counters = (n: Node) => traffic?.nodes.find((c) => n.ipAddresses.includes(c.node))
  const [q, setQ] = useState('')
  const [only, setOnly] = useState<'all' | 'online' | 'offline'>('all')
  const [adding, setAdding] = useState(false)
  const [info, setInfo] = useState<Info | null>(null)
  const { users } = useUsers()
  useEffect(() => { api.GET('/api/v1/info').then(({ data }) => data && setInfo(data)) }, [])

  const rows = useMemo(() => (nodes ?? []).filter((n) => {
    if (only === 'online' && !n.online) return false
    if (only === 'offline' && n.online) return false
    const hay = [n.givenName, n.name, n.user.name, ...n.ipAddresses, ...n.tags].join(' ').toLowerCase()
    return hay.includes(q.toLowerCase())
  }), [nodes, q, only])

  const online = (nodes ?? []).filter((n) => n.online).length

  return (
    <div className="app">
      <header>
        <h1>Machines</h1>
        {nodes && <span className="badge ok">{online} online</span>}
        {nodes && <span className="badge idle">{nodes.length - online} offline</span>}
        <span className="spacer" />
        <input className="search" placeholder="Search name, user, IP, tag" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
          <option value="all">All</option><option value="online">Online</option><option value="offline">Offline</option>
        </select>
        <button className="ghost" onClick={reload}>Refresh</button>
        <button onClick={() => setAdding(true)}>Add device</button>
      </header>
      {adding && <AddDevice users={users ?? []} info={info} onClose={() => setAdding(false)} onAdded={reload} />}
      {error && <div className="banner err">{error}</div>}
      {!nodes ? <p className="hint">Loading…</p> : rows.length === 0 ? (
        <p className="hint">{nodes.length ? 'No machines match.' : 'No machines registered yet. Run tailscale up --login-server … on a device.'}</p>
      ) : (
        <div className="panel tablewrap">
          <table className="machines">
            <thead>
              <tr><th>Machine</th><th>Owner</th><th>Addresses</th><th>Tags</th><th>Routes</th><th>Status</th><th>Traffic (1h)</th><th>Expires</th></tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id}>
                  <td><a className="mlink" href={`#/machines/${n.id}`}><strong>{n.givenName || n.name}</strong></a><div className="sub">#{n.id} · {n.registerMethod.replace('REGISTER_METHOD_', '').toLowerCase()}</div></td>
                  <td>{n.tags.length ? <span className="sub">tagged</span> : n.user.name}</td>
                  <td>{n.ipAddresses.map((ip) => <div key={ip}><Copyable value={ip} /></div>)}</td>
                  <td>{n.tags.map((t) => <span key={t} className="pchip k-tag">{t}</span>)}</td>
                  <td className="mono">
                    {n.availableRoutes.map((r) => (
                      <div key={r} className={n.approvedRoutes.includes(r) ? '' : 'sub'}>{r}{n.approvedRoutes.includes(r) ? '' : ' (pending)'}</div>
                    ))}
                  </td>
                  <td><span className={`dot ${n.online ? 'on' : ''}`} />{n.online ? 'Online' : `Seen ${ago(n.lastSeen)}`}</td>
                  <td className="mono">{(() => { const c = counters(n); return c ? <><div>↓ {bytes(c.rxBytes)}</div><div>↑ {bytes(c.txBytes)}</div></> : <span className="sub">no agent</span> })()}</td>
                  <td className="sub">{n.expiry ? ago(n.expiry).replace(' ago', '') + (new Date(n.expiry) < new Date() ? ' (expired)' : '') : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
