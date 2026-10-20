import { useState } from 'react'
import { api, errMessage, type Info, type User } from './api/client'
import { AuthKeyFlow } from './AuthKeyFlow'
import { Modal, toast } from './Modal'

type Props = { users: User[]; info: Info | null; onClose: () => void; onAdded: () => void }

export function AddDevice({ users, info, onClose, onAdded }: Props) {
  const [tab, setTab] = useState<'key' | 'approve'>('key')
  return (
    <Modal title="Add a device" onClose={onClose} wide>
      <div className="tabs">
        <button className={tab === 'key' ? 'on' : ''} onClick={() => setTab('key')}>With an auth key</button>
        <button className={tab === 'approve' ? 'on' : ''} onClick={() => setTab('approve')}>Approve a login</button>
      </div>
      {tab === 'key' ? <AuthKeyFlow users={users} info={info} onDone={() => undefined} /> : <Approve users={users} onClose={onClose} onAdded={onAdded} />}
    </Modal>
  )
}

/** The device ran `tailscale up --login-server …`; paste the registration key it printed. */
function Approve({ users, onClose, onAdded }: { users: User[]; onClose: () => void; onAdded: () => void }) {
  const [raw, setRaw] = useState('')
  const [user, setUser] = useState(users[0]?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Accept the whole URL from the client ("…/register/abc") or just the key.
  const key = raw.trim().split('/').filter(Boolean).pop() ?? ''

  const go = async () => {
    setBusy(true); setErr('')
    const { data, error } = await api.POST('/api/v1/node/register', { params: { query: { user, key } } })
    setBusy(false)
    if (error) return setErr(errMessage(error))
    toast(`Registered ${data.node.givenName || data.node.name}`); onAdded(); onClose()
  }

  return (
    <div className="mform">
      <p className="hint">On the device run <code>tailscale up --login-server …</code>. It prints a URL ending in a key. Paste it here.</p>
      <label className="fld">Registration URL or key
        <input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="https://…/register/mkey-abc…" />
      </label>
      <label className="fld">Owner
        <select value={user} onChange={(e) => setUser(e.target.value)}>{users.map((u) => <option key={u.id}>{u.name}</option>)}</select>
      </label>
      {err && <div className="banner err">{err}</div>}
      <div className="mfoot"><button disabled={busy || !key || !user} onClick={go}>{busy ? 'Registering…' : 'Register device'}</button></div>
    </div>
  )
}
