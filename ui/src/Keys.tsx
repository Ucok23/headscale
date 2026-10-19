import { useCallback, useEffect, useState } from 'react'
import { api, errMessage, type ApiKey, type Info, type PreAuthKey } from './api/client'
import { AuthKeyFlow } from './AuthKeyFlow'
import { Copyable } from './Copy'
import { rel, DURATIONS } from './lib/time'
import { ConfirmDelete, FormModal, Modal, toast } from './Modal'
import { useUsers } from './Users'

export function Keys() {
  const [tab, setTab] = useState<'auth' | 'api'>('auth')
  return (
    <div className="app">
      <header>
        <h1>Keys</h1>
        <div className="seg">
          <button className={tab === 'auth' ? 'on' : ''} onClick={() => setTab('auth')}>Auth keys</button>
          <button className={tab === 'api' ? 'on' : ''} onClick={() => setTab('api')}>API keys</button>
        </div>
        <span className="hint">{tab === 'auth' ? 'Let machines join without an interactive login.' : 'Let tools and this UI talk to the server.'}</span>
      </header>
      {tab === 'auth' ? <AuthKeys /> : <ApiKeys />}
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
                    <td className="mono">hskey-api-{k.prefix}…</td>
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
          <p className="mbody">Anything using <code>hskey-api-{dlg.key.prefix}…</code> stops working. <b>If this is the key you are signed in with, you will be signed out.</b></p>
        </FormModal>
      )}
      {typeof dlg === 'object' && dlg?.kind === 'delete' && (
        <ConfirmDelete title="Delete API key" name={dlg.key.prefix} label="Delete key" onClose={() => setDlg(null)}
          body={<>Delete <code>hskey-api-{dlg.key.prefix}…</code>? If it is the key you are signed in with, you will be signed out.</>}
          onConfirm={async () => {
            const { error } = await api.DELETE('/api/v1/apikey/{prefix}', { params: { path: { prefix: dlg.key.prefix } } })
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
