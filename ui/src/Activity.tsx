import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, errMessage, type ActivityEvent } from './api/client'
import { clock } from './lib/format'

const GROUPS: { id: string; label: string; match: (t: string) => boolean }[] = [
  { id: 'nodes', label: 'Machines', match: (t) => t.startsWith('node.') },
  { id: 'policy', label: 'Policy', match: (t) => t.startsWith('policy.') },
  { id: 'access', label: 'Users & keys', match: (t) => t.startsWith('user.') || t.includes('key') },
]

const LABEL: Record<string, string> = {
  'node.online': 'came online', 'node.offline': 'went offline', 'node.registered': 'registered',
  'node.reauthenticated': 're-authenticated', 'node.expired': 'key expired', 'node.expiry': 'expiry changed',
  'node.deleted': 'deleted', 'node.renamed': 'renamed', 'node.tags': 'tags changed', 'node.routes': 'routes changed',
  'policy.updated': 'policy saved', 'user.created': 'user created', 'user.deleted': 'user deleted',
  'apikey.created': 'API key created', 'preauthkey.created': 'pre-auth key created',
}

function tone(t: string): string {
  if (t === 'node.online' || t === 'node.registered') return 'ok'
  if (t === 'node.offline' || t === 'node.expired') return 'idle'
  if (t === 'node.deleted' || t === 'user.deleted') return 'bad'
  if (t.startsWith('policy.') || t.includes('key')) return 'warn'
  return 'info'
}

export function Activity() {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [error, setError] = useState('')
  const [win, setWin] = useState('24h')
  const [on, setOn] = useState<Record<string, boolean>>({ nodes: true, policy: true, access: true })
  const [q, setQ] = useState('')
  const [live, setLive] = useState(true)
  const [more, setMore] = useState(true)

  const load = useCallback(async () => {
    const { data, error } = await api.GET('/api/v1/events', { params: { query: { window: win, limit: 200 } } })
    if (error) return setError(errMessage(error))
    setError('')
    setEvents(data.events)
    setMore(data.events.length === 200)
  }, [win])

  useEffect(() => {
    load()
    if (!live) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load, live])

  const loadMore = async () => {
    const last = events[events.length - 1]
    if (!last) return
    const { data } = await api.GET('/api/v1/events', { params: { query: { window: win, limit: 200, before: last.id } } })
    if (data) { setEvents([...events, ...data.events]); setMore(data.events.length === 200) }
  }

  const rows = useMemo(() => events.filter((e) => {
    const g = GROUPS.find((x) => x.match(e.type))
    if (g && !on[g.id]) return false
    const hay = `${e.type} ${LABEL[e.type] ?? ''} ${e.nodeName} ${e.user} ${e.detail}`.toLowerCase()
    return hay.includes(q.toLowerCase())
  }), [events, on, q])

  return (
    <div className="app">
      <header>
        <h1>Activity</h1>
        <div className="seg">
          {GROUPS.map((g) => (
            <button key={g.id} className={on[g.id] ? 'on' : ''} onClick={() => setOn({ ...on, [g.id]: !on[g.id] })}>{g.label}</button>
          ))}
        </div>
        <span className="spacer" />
        <input className="search" placeholder="Search machine, user, detail" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={win} onChange={(e) => setWin(e.target.value)}>
          <option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
        </select>
        <label className="live"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live</label>
      </header>
      {error && <div className="banner err">{error}</div>}
      {rows.length === 0 ? <p className="hint">No events in this window.</p> : (
        <div className="panel tablewrap">
          <table className="machines">
            <thead><tr><th>Time</th><th>Event</th><th>Machine</th><th>Owner</th><th>Detail</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="mono nowrap">{clock(e.time)}</td>
                  <td><span className={`ev ${tone(e.type)}`}>{LABEL[e.type] ?? e.type}</span></td>
                  <td>{e.nodeName ? <strong>{e.nodeName}</strong> : <span className="sub">—</span>}</td>
                  <td>{e.user || <span className="sub">—</span>}</td>
                  <td className="sub">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && events.length > 0 && <p><button className="ghost" onClick={loadMore}>Load older</button></p>}
    </div>
  )
}
