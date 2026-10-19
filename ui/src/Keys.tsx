import { useCallback, useEffect, useState } from 'react'
import { api, errMessage, v2, type ApiKey, type Info, type PreAuthKey, type V2Key } from './api/client'
import { AuthKeyFlow } from './AuthKeyFlow'
import { Copyable } from './Copy'
import { rel, DURATIONS } from './lib/time'
import { ConfirmDelete, FormModal, Modal, toast } from './Modal'
import { useUsers } from './Users'

export function Keys() {
  const [tab, setTab] = useState<'auth' | 'api' | 'agent'>('auth')
  return (
    <div className="app">
      <header>
        <h1>Keys</h1>
        <div className="seg">
          <button className={tab === 'auth' ? 'on' : ''} onClick={() => setTab('auth')}>Auth keys</button>
          <button className={tab === 'api' ? 'on' : ''} onClick={() => setTab('api')}>API keys</button>
          <button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}>Agent keys</button>
        </div>
        <span className="hint">
          {tab === 'auth' ? 'Let machines join without an interactive login.' : tab === 'api' ? 'Let tools and this UI talk to the server. Full admin access.' : 'Let flow agents report traffic and nothing else.'}
        </span>
      </header>
      {tab === 'auth' ? <AuthKeys /> : tab === 'api' ? <ApiKeys /> : <AgentKeys />}
    </div>
  )
}

const status = (exp: string | null | undefined, used?: boolean, reusable?: boolean) =>
  exp && new Date(exp) < new Date() ? { t: 'expired', c: 'idle' } : used && !reusable ? { t: 'used', c: 'idle' } : { t: 'active', c: 'ok' }

function AuthKeys() {
  const { users } = useUsers()
  const [keys, setKeys] = useState<PreAuthKey[] | null>(null)
  const [info, setInfo] = useState<Info | null>(null)
  const [err, setErr] = useState('')
  const [dlg, setDlg] = useState<'new' | { kind: 'expire' | 'delete'; key: PreAuthKey } | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await api.GET('/api/v1/preauthkey')
    if (error) setErr(errMessage(error)); else { setErr(''); setKeys(data.preAuthKeys) }
  }, [])
  useEffect(() => { load(); api.GET('/api/v1/info').then(({ data }) => data && setInfo(data)) }, [load])

  return (
    <>
      <p><button onClick={() => setDlg('new')}>Generate auth key</button></p>
      {err && <div className="banner err">{err}</div>}
      {!keys ? <p className="hint">Loading…</p> : keys.length === 0 ? <p className="hint">No auth keys yet.</p> : (
        <div className="panel tablewrap">
          <table className="machines">
            <thead><tr><th>Key</th><th>Owner</th><th>Type</th><th>Tags</th><th>Status</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => {
                const st = status(k.expiration, k.used, k.reusable)
                return (
                  <tr key={k.id}>
                    <td className="mono">{k.key}<div className="sub">#{k.id}</div></td>
                    <td>{k.user?.name ?? <span className="sub">—</span>}</td>
                    <td className="sub">{k.reusable ? 'reusable' : 'single use'}{k.ephemeral ? ', ephemeral' : ''}</td>
                    <td>{k.aclTags.map((t) => <span key={t} className="pchip k-tag">{t}</span>)}</td>
                    <td><span className={`ev ${st.c}`}>{st.t}</span></td>
                    <td className="sub">{rel(k.expiration)}</td>
                    <td className="r nowrap">
                      <button className="ghost small" disabled={st.t === 'expired'} onClick={() => setDlg({ kind: 'expire', key: k })}>Revoke</button>{' '}
                      <button className="ghost small danger-text" onClick={() => setDlg({ kind: 'delete', key: k })}>Delete</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {dlg === 'new' && <Modal title="Generate auth key" onClose={() => { setDlg(null); load() }} wide><AuthKeyFlow users={users ?? []} info={info} onDone={load} /></Modal>}
      {typeof dlg === 'object' && dlg?.kind === 'expire' && (
        <FormModal title="Revoke key" onClose={() => setDlg(null)} submit="Revoke" danger
          onSubmit={async () => {
            const { error } = await api.POST('/api/v1/preauthkey/expire', { body: { id: dlg.key.id } })
            if (error) return errMessage(error)
            toast('Key revoked'); load()
          }}>
          <p className="mbody">Revoking stops the key from registering new machines. Machines that already joined are not affected.</p>
        </FormModal>
      )}
      {typeof dlg === 'object' && dlg?.kind === 'delete' && (
        <FormModal title="Delete key" onClose={() => setDlg(null)} submit="Delete" danger
          onSubmit={async () => {
            const { error } = await api.DELETE('/api/v1/preauthkey', { params: { query: { id: dlg.key.id } } })
            if (error) return errMessage(error)
            toast('Key deleted'); load()
          }}>
          <p className="mbody">Delete key <code>{dlg.key.key}</code>? This cannot be undone.</p>
        </FormModal>
      )}
    </>
  )
}

/** The API reports a masked display string ("hskey-api-<id>-***"); deleting needs the bare id part. */
const barePrefix = (masked: string) => masked.replace(/^hskey-api-/, '').replace(/-\*+$/, '')

function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [err, setErr] = useState('')
  const [dlg, setDlg] = useState<'new' | { kind: 'expire' | 'delete'; key: ApiKey } | null>(null)
  const [created, setCreated] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await api.GET('/api/v1/apikey')
    if (error) setErr(errMessage(error)); else { setErr(''); setKeys(data.apiKeys) }
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <>
      <p><button onClick={() => setDlg('new')}>Create API key</button></p>
      {err && <div className="banner err">{err}</div>}
      {!keys ? <p className="hint">Loading…</p> : (
        <div className="panel tablewrap">
          <table className="machines">
            <thead><tr><th>Key</th><th>Created</th><th>Last used</th><th>Status</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => {
                const st = status(k.expiration)
                return (
                  <tr key={k.id}>
                    <td className="mono">{k.prefix}</td>
                    <td className="sub">{rel(k.createdAt)}</td>
                    <td className="sub">{rel(k.lastSeen)}</td>
                    <td><span className={`ev ${st.c}`}>{st.t}</span></td>
                    <td className="sub">{rel(k.expiration)}</td>
                    <td className="r nowrap">
                      <button className="ghost small" disabled={st.t === 'expired'} onClick={() => setDlg({ kind: 'expire', key: k })}>Expire</button>{' '}
                      <button className="ghost small danger-text" onClick={() => setDlg({ kind: 'delete', key: k })}>Delete</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {dlg === 'new' && <NewApiKey onClose={() => setDlg(null)} onCreated={(k) => { setCreated(k); load() }} />}
      {created && (
        <Modal title="API key created" onClose={() => setCreated('')}>
          <div className="mform">
            <div className="once">Copy this key now. It is shown only once.</div>
            <div className="cmd"><Copyable value={created} /></div>
          </div>
        </Modal>
      )}
      {typeof dlg === 'object' && dlg?.kind === 'expire' && (
        <FormModal title="Expire API key" onClose={() => setDlg(null)} submit="Expire" danger
          onSubmit={async () => {
            const { error } = await api.POST('/api/v1/apikey/expire', { body: { id: dlg.key.id } })
            if (error) return errMessage(error)
            toast('Key expired'); load()
          }}>
          <p className="mbody">Anything using <code>{dlg.key.prefix}</code> stops working. <b>If this is the key you are signed in with, you will be signed out.</b></p>
        </FormModal>
      )}
      {typeof dlg === 'object' && dlg?.kind === 'delete' && (
        <ConfirmDelete title="Delete API key" name={barePrefix(dlg.key.prefix)} label="Delete key" onClose={() => setDlg(null)}
          body={<>Delete <code>{dlg.key.prefix}</code>? If it is the key you are signed in with, you will be signed out.</>}
          onConfirm={async () => {
            const { error } = await api.DELETE('/api/v1/apikey/{prefix}', { params: { path: { prefix: barePrefix(dlg.key.prefix) } } })
            if (error) return errMessage(error)
            toast('Key deleted'); load()
          }} />
      )}
    </>
  )
}

function NewApiKey({ onClose, onCreated }: { onClose: () => void; onCreated: (k: string) => void }) {
  const [dur, setDur] = useState(DURATIONS[3].ms)
  return (
    <FormModal title="Create API key" onClose={onClose} submit="Create key"
      onSubmit={async () => {
        const { data, error } = await api.POST('/api/v1/apikey', { body: { expiration: new Date(Date.now() + dur).toISOString() } })
        if (error) return errMessage(error)
        onCreated(data.apiKey)
      }}>
      <label className="fld">Valid for
        <select value={dur} onChange={(e) => setDur(Number(e.target.value))}>{DURATIONS.map((d) => <option key={d.ms} value={d.ms}>{d.label}</option>)}</select>
      </label>
      <p className="hint">API keys have full admin access. Give each tool its own key so you can revoke it separately.</p>
    </FormModal>
  )
}

/** OAuth clients limited to the `flows` scope, for hs-flow-agent. */
function AgentKeys() {
  const [keys, setKeys] = useState<V2Key[] | null>(null)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState<Info | null>(null)
  const [dlg, setDlg] = useState<'new' | { kind: 'delete'; key: V2Key } | null>(null)
  const [made, setMade] = useState<V2Key | null>(null)

  const load = useCallback(async () => {
    const r = await v2<{ keys: V2Key[] }>('/api/v2/tailnet/-/keys')
    if (!r.ok) return setErr(r.error)
    setErr('')
    setKeys(r.data.keys.filter((k) => k.keyType === 'client' && k.scopes?.includes('flows')))
  }, [])
  useEffect(() => { load(); api.GET('/api/v1/info').then(({ data }) => data && setInfo(data)) }, [load])

  return (
    <>
      <p><button onClick={() => setDlg('new')}>Create agent key</button></p>
      <p className="hint">
        An agent key is an OAuth client that can only report network flows. Unlike an API key it cannot read the policy,
        change machines or create other keys, so it is safe to put on every machine.
      </p>
      {err && <div className="banner err">{err}</div>}
      {!keys ? <p className="hint">Loading…</p> : keys.length === 0 ? <p className="hint">No agent keys yet.</p> : (
        <div className="panel tablewrap">
          <table className="machines">
            <thead><tr><th>Name</th><th>Client</th><th>Scope</th><th>Created</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td><strong>{k.description || 'flow agent'}</strong></td>
                  <td className="mono">hskey-client-{k.id}-…</td>
                  <td>{k.scopes?.map((s) => <span key={s} className="pchip k-host">{s}</span>)}</td>
                  <td className="sub">{rel(k.created)}</td>
                  <td className="r nowrap"><button className="ghost small danger-text" onClick={() => setDlg({ kind: 'delete', key: k })}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dlg === 'new' && <NewAgentKey onClose={() => setDlg(null)} onCreated={(k) => { setMade(k); load() }} />}
      {made && <AgentKeyResult k={made} info={info} onClose={() => setMade(null)} />}
      {typeof dlg === 'object' && dlg?.kind === 'delete' && (
        <ConfirmDelete title="Delete agent key" name={dlg.key.description || dlg.key.id} label="Delete key" onClose={() => setDlg(null)}
          body={<>Agents using this key stop reporting immediately. Machines are not affected.</>}
          onConfirm={async () => {
            const r = await v2(`/api/v2/tailnet/-/keys/${dlg.key.id}`, { method: 'DELETE' })
            if (!r.ok) return r.error
            toast('Agent key deleted'); load()
          }} />
      )}
    </>
  )
}

function NewAgentKey({ onClose, onCreated }: { onClose: () => void; onCreated: (k: V2Key) => void }) {
  const [name, setName] = useState('flow agent')
  return (
    <FormModal title="Create agent key" onClose={onClose} submit="Create key"
      onSubmit={async () => {
        const r = await v2<V2Key>('/api/v2/tailnet/-/keys', { method: 'POST', body: JSON.stringify({ keyType: 'client', scopes: ['flows'], description: name.trim() }) })
        if (!r.ok) return r.error
        onCreated(r.data)
      }}>
      <label className="fld">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="flow agent" /></label>
      <p className="hint">One key can be used on every machine, or make one per machine to revoke them separately.</p>
    </FormModal>
  )
}

function AgentKeyResult({ k, info, onClose }: { k: V2Key; info: Info | null; onClose: () => void }) {
  const server = info?.serverUrl ?? window.location.origin
  const secret = k.key ?? ''
  const save = `echo '${secret}' | sudo install -m 600 /dev/stdin /etc/hs-flow-agent.key`
  const run = `sudo hs-flow-agent --server ${server} --key-file /etc/hs-flow-agent.key`
  return (
    <Modal title="Agent key created" onClose={onClose} wide>
      <div className="mform">
        <div className="once">Copy this key now. It is shown only once.</div>
        <div className="fld">Key<div className="cmd"><Copyable value={secret} /></div></div>
        <div className="fld">On each machine, save it so only root can read it
          <div className="cmd"><Copyable value={save} /></div></div>
        <div className="fld">Then run the agent (root is needed to read the connection table)
          <div className="cmd"><Copyable value={run} /></div></div>
        <p className="hint">Byte counts need <code>sudo sysctl -w net.netfilter.nf_conntrack_acct=1</code>. To keep the agent running, see docs/ref/flow-agent.md.</p>
      </div>
    </Modal>
  )
}
