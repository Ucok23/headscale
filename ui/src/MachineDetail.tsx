import { useEffect, useMemo, useState } from 'react'
import { api, errMessage, type ActivityEvent, type Info, type Node, type ReachEdge, type SimNode } from './api/client'
import { Copyable } from './Copy'
import { DeleteDialog, ExpiryDialog, RenameDialog, RouteTable, TagsDialog } from './MachineActions'
import { bytes, clock } from './lib/format'
import { useTraffic } from './useTraffic'

const EVENT: Record<string, string> = {
  'node.online': 'came online', 'node.offline': 'went offline', 'node.registered': 'registered',
  'node.reauthenticated': 're-authenticated', 'node.expired': 'key expired', 'node.expiry': 'expiry changed',
  'node.renamed': 'renamed', 'node.tags': 'tags changed', 'node.routes': 'routes changed',
}

function rel(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const ms = new Date(iso).getTime() - Date.now()
  const s = Math.abs(ms) / 1000
  const n = s < 60 ? 'moments' : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`
  return ms > 0 ? `in ${n}` : s < 60 ? 'just now' : `${n} ago`
}

const when = (iso: string | null | undefined) => (iso ? `${new Date(iso).toLocaleString()} (${rel(iso)})` : '—')

export function MachineDetail({ id }: { id: string }) {
  const [node, setNode] = useState<Node | null>(null)
  const [info, setInfo] = useState<Info | null>(null)
  const [err, setErr] = useState('')
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [nodes, setNodes] = useState<SimNode[]>([])
  const [edges, setEdges] = useState<ReachEdge[]>([])
  const traffic = useTraffic('1h', 15000)
  const [dialog, setDialog] = useState<'rename' | 'tags' | 'expiry' | 'delete' | null>(null)
  const [tick, setTick] = useState(0)
  const [tagNames, setTagNames] = useState<string[]>([])

  useEffect(() => {
    let stop = false
    const load = async () => {
      const { data, error, response } = await api.GET('/api/v1/node/{nodeId}', { params: { path: { nodeId: id } } })
      if (stop) return
      if (error) return setErr(response.status === 404 ? 'This machine does not exist (any more).' : errMessage(error))
      setErr(''); setNode(data.node)
    }
    load()
    const t = setInterval(load, 10000)
    return () => { stop = true; clearInterval(t) }
  }, [id, tick])

  useEffect(() => {
    api.GET('/api/v1/info').then(({ data }) => data && setInfo(data))
    api.GET('/api/v1/policy').then(({ data }) => {
      if (!data) return
      const m = [...data.policy.matchAll(/"(tag:[A-Za-z0-9_-]+)"\s*:/g)].map((x) => x[1])
      setTagNames([...new Set(m)])
    })
    api.POST('/api/v1/policy/reachability', { body: { policy: '' } }).then(({ data }) => {
      if (data) { setNodes(data.nodes); setEdges(data.edges) }
    })
  }, [id])

  useEffect(() => {
    api.GET('/api/v1/events', { params: { query: { node: Number(id), window: '30d', limit: 8 } } }).then(({ data }) => data && setEvents(data.events))
  }, [id, node?.online])

  const fqdn = node && info?.baseDomain ? `${node.givenName || node.name}.${info.baseDomain}` : ''
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const outs = edges.filter((e) => e.src === id)
  const ins = edges.filter((e) => e.dst === id)
  const counters = node ? traffic?.nodes.find((c) => node.ipAddresses.includes(c.node)) : undefined

  if (err) return <div className="app"><header><a className="back" href="#/machines">← Machines</a></header><div className="banner err">{err}</div></div>
  if (!node) return <div className="app"><p className="hint">Loading…</p></div>

  const v4 = node.ipAddresses.find((a) => !a.includes(':'))
  const v6 = node.ipAddresses.find((a) => a.includes(':'))
  const expired = node.expiry && new Date(node.expiry) < new Date()
  const name = node.givenName || node.name

  return (
    <div className="app detail">
      <header>
        <a className="back" href="#/machines">← Machines</a>
      </header>
      <div className="dhead">
        <h1>{name}</h1>
        <span className={`badge ${node.online ? 'ok' : 'idle'}`}>{node.online ? 'Online' : `Seen ${rel(node.lastSeen)}`}</span>
        {expired && <span className="badge warn">Key expired</span>}
        {node.tags.map((t) => <span key={t} className="pchip k-tag">{t}</span>)}
        <span className="sub">{node.tags.length ? 'Tagged machine' : `Owned by ${node.user.name}`}</span>
        <div className="actions">
          <button className="ghost" onClick={() => setDialog('rename')}>Rename</button>
          <button className="ghost" onClick={() => setDialog('tags')}>Edit tags</button>
          <button className="ghost" onClick={() => setDialog('expiry')}>Key expiry</button>
          <button className="ghost danger-text" onClick={() => setDialog('delete')}>Delete</button>
        </div>
      </div>
      {dialog === 'rename' && <RenameDialog node={node} onClose={() => setDialog(null)} onDone={() => setTick(tick + 1)} />}
      {dialog === 'tags' && <TagsDialog node={node} known={tagNames} onClose={() => setDialog(null)} onDone={() => setTick(tick + 1)} />}
      {dialog === 'expiry' && <ExpiryDialog node={node} onClose={() => setDialog(null)} onDone={() => setTick(tick + 1)} />}
      {dialog === 'delete' && <DeleteDialog node={node} onClose={() => setDialog(null)} onDone={() => { window.location.hash = '#/machines' }} />}

      <div className="grid2">
        <section className="panel">
          <h2>Addresses</h2>
          <dl className="kv">
            {v4 && <><dt>Tailscale IPv4</dt><dd><Copyable value={v4} /></dd></>}
            {v6 && <><dt>Tailscale IPv6</dt><dd><Copyable value={v6} /></dd></>}
            {fqdn && <><dt>MagicDNS name</dt><dd><Copyable value={fqdn} /></dd></>}
            <dt>Short name</dt><dd><Copyable value={name} /></dd>
            {v4 && <><dt>SSH</dt><dd><Copyable value={`ssh ${fqdn || v4}`} /></dd></>}
          </dl>
          {info && !info.magicDns && <p className="hint">MagicDNS is off on this server, so the name above will not resolve.</p>}
        </section>

        <section className="panel">
          <h2>Machine</h2>
          <dl className="kv">
            <dt>OS</dt><dd>{node.os ? `${node.os} ${node.osVersion}` : <span className="sub">not reported yet</span>}</dd>
            <dt>Client</dt><dd>{node.clientVersion || <span className="sub">—</span>}</dd>
            <dt>Hostname</dt><dd className="mono">{node.name}</dd>
            <dt>Registered</dt><dd>{when(node.createdAt)} <span className="sub">via {node.registerMethod.replace('REGISTER_METHOD_', '').toLowerCase()}</span></dd>
            <dt>Last seen</dt><dd>{node.online ? 'now' : when(node.lastSeen)}</dd>
            <dt>Key expiry</dt><dd className={expired ? 'bad' : ''}>{node.expiry ? when(node.expiry) : 'No expiry'}</dd>
            <dt>ID</dt><dd className="mono">{node.id}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>Access <small>from the stored policy</small></h2>
          <h3 className="mini">Can reach</h3>
          {outs.length ? outs.map((e) => <Peer key={e.dst} node={byId.get(e.dst)} acc={e.access} />) : <p className="hint">No machines.</p>}
          <h3 className="mini">Reachable from</h3>
          {ins.length ? ins.map((e) => <Peer key={e.src} node={byId.get(e.src)} acc={e.access} />) : <p className="hint">No machines.</p>}
        </section>

        <section className="panel">
          <h2>Routes</h2>
          <RouteTable node={node} onDone={() => setTick(tick + 1)} />
        </section>

        <section className="panel">
          <h2>Keys & endpoints</h2>
          <dl className="kv">
            <dt>Node key</dt><dd><Copyable value={node.nodeKey} /></dd>
            <dt>Machine key</dt><dd><Copyable value={node.machineKey} /></dd>
            <dt>Disco key</dt><dd><Copyable value={node.discoKey} /></dd>
            <dt>Endpoints</dt>
            <dd>{node.endpoints.length ? node.endpoints.map((e) => <div key={e}><Copyable value={e} /></div>) : <span className="sub">none reported</span>}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>Recent activity</h2>
          {events.length === 0 ? <p className="hint">Nothing recorded yet.</p> : (
            <ul className="tl">
              {events.map((e) => (
                <li key={e.id}><span className="mono sub">{clock(e.time)}</span> {EVENT[e.type] ?? e.type}{e.detail ? <span className="sub"> · {e.detail}</span> : null}</li>
              ))}
            </ul>
          )}
          {counters && (
            <>
              <h3 className="mini">Traffic, last hour</h3>
              <div className="line"><strong>↓ {bytes(counters.rxBytes)}</strong><strong>↑ {bytes(counters.txBytes)}</strong></div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function Peer({ node, acc }: { node?: SimNode; acc: string[] }) {
  if (!node) return null
  return (
    <div className="line">
      <a href={`#/machines/${node.id}`}><strong>{node.name}</strong></a>
      {acc.map((a) => <span key={a} className="chip">{a.replace(/^any:/, '')}</span>)}
    </div>
  )
}
