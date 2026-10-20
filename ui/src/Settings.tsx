import { useEffect, useState } from 'react'
import { api, errMessage, type Info } from './api/client'
import { Copyable } from './Copy'

export function Settings() {
  const [info, setInfo] = useState<Info | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.GET('/api/v1/info').then(({ data, error }) => (error ? setErr(errMessage(error)) : setInfo(data)))
  }, [])

  if (err) return <div className="app"><div className="banner err">{err}</div></div>
  if (!info) return <div className="app"><p className="hint">Loading…</p></div>

  const split = Object.entries(info.splitDns)

  return (
    <div className="app">
      <header><h1>Settings</h1></header>
      <div className="grid2">
        <section className="panel">
          <h2>Server</h2>
          <dl className="kv">
            <dt>Version</dt><dd className="mono">{info.version}</dd>
            <dt>Login server</dt><dd><Copyable value={info.serverUrl} /></dd>
            <dt>Client command</dt><dd><Copyable value={`tailscale up --login-server ${info.serverUrl}`} /></dd>
          </dl>
        </section>

        <section className="panel">
          <h2>DNS <small>read-only</small></h2>
          <dl className="kv">
            <dt>MagicDNS</dt><dd><span className={`ev ${info.magicDns ? 'ok' : 'idle'}`}>{info.magicDns ? 'enabled' : 'disabled'}</span></dd>
            <dt>Base domain</dt><dd>{info.baseDomain ? <Copyable value={info.baseDomain} /> : <span className="sub">—</span>}</dd>
            <dt>Override local DNS</dt><dd>{info.overrideLocalDns ? 'yes' : 'no'}</dd>
            <dt>Nameservers</dt>
            <dd>{info.nameservers.length ? info.nameservers.map((n) => <div key={n}><Copyable value={n} /></div>) : <span className="sub">none</span>}</dd>
            <dt>Split DNS</dt>
            <dd>{split.length ? split.map(([d, s]) => <div key={d} className="mono">{d} → {(s ?? []).join(', ')}</div>) : <span className="sub">none</span>}</dd>
            <dt>Search domains</dt>
            <dd>{info.searchDomains.length ? info.searchDomains.map((d) => <div key={d} className="mono">{d}</div>) : <span className="sub">none</span>}</dd>
            <dt>Extra records</dt>
            <dd>{info.extraRecords.length ? info.extraRecords.map((r) => <div key={r.name + r.value} className="mono">{r.name} {r.type || 'A'} {r.value}</div>) : <span className="sub">none</span>}</dd>
          </dl>
          <p className="hint">
            Headscale reads DNS settings from its configuration file, so they cannot be changed from here. Edit the
            <code> dns:</code> section of <code>config.yaml</code> and restart the server.
          </p>
        </section>
      </div>
    </div>
  )
}
