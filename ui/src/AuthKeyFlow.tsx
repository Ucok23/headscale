import { useState } from 'react'
import { api, errMessage, type Info, type PreAuthKey, type User } from './api/client'
import { ChipInput } from './Chips'
import { Copyable } from './Copy'
import { DURATIONS } from './lib/time'

type Props = { users: User[]; info: Info | null; onDone: (key: PreAuthKey) => void; defaultUser?: string }

/** Create a pre-auth key, then show it once together with ready-to-paste login commands. */
export function AuthKeyFlow({ users, info, onDone, defaultUser }: Props) {
  const [user, setUser] = useState(defaultUser ?? users[0]?.id ?? '')
  const [reusable, setReusable] = useState(false)
  const [ephemeral, setEphemeral] = useState(false)
  const [dur, setDur] = useState(DURATIONS[2].ms)
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [made, setMade] = useState<PreAuthKey | null>(null)

  if (made) return <KeyResult k={made} info={info} />

  const create = async () => {
    setBusy(true); setErr('')
    const { data, error } = await api.POST('/api/v1/preauthkey', {
      body: { user, reusable, ephemeral, aclTags: tags.length ? tags : undefined, expiration: new Date(Date.now() + dur).toISOString() },
    })
    setBusy(false)
    if (error) return setErr(errMessage(error))
    setMade(data.preAuthKey); onDone(data.preAuthKey)
  }

  return (
    <div className="mform">
      {users.length === 0 ? <div className="banner warn">Create a user first (Users page): every machine belongs to a user.</div> : (
        <label className="fld">Owner
          <select value={user} onChange={(e) => setUser(e.target.value)}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        </label>
      )}
      <label className="fld">Key is valid for
        <select value={dur} onChange={(e) => setDur(Number(e.target.value))}>{DURATIONS.map((d) => <option key={d.ms} value={d.ms}>{d.label}</option>)}</select>
      </label>
      <label className="fld inline"><input type="checkbox" checked={reusable} onChange={(e) => setReusable(e.target.checked)} /> Reusable: more than one machine may use it</label>
      <label className="fld inline"><input type="checkbox" checked={ephemeral} onChange={(e) => setEphemeral(e.target.checked)} /> Ephemeral: machines are removed after they go offline</label>
      <div className="fld">Tags (optional)
        <ChipInput values={tags} onChange={setTags} suggestions={[]} placeholder="tag:server" />
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="mfoot"><button disabled={busy || !user} onClick={create}>{busy ? 'Creating…' : 'Generate key'}</button></div>
    </div>
  )
}

function KeyResult({ k, info }: { k: PreAuthKey; info: Info | null }) {
  const server = info?.serverUrl ?? window.location.origin
  const up = `tailscale up --login-server ${server} --authkey ${k.key}`
  const docker = `docker run -d --name=tailscale --cap-add=NET_ADMIN --device=/dev/net/tun -e TS_AUTHKEY=${k.key} -e TS_EXTRA_ARGS=--login-server=${server} -v tailscale-state:/var/lib/tailscale tailscale/tailscale`
  return (
    <div className="mform">
      <div className="once">Copy this key now. It is shown only once and cannot be retrieved later.</div>
      <div className="fld">Auth key<div className="cmd"><Copyable value={k.key} /></div></div>
      <div className="fld">Install the Tailscale client, then run (Linux, macOS, Windows)
        <div className="cmd"><Copyable value={up} /></div></div>
      <div className="fld">Or with Docker
        <div className="cmd"><Copyable value={docker} /></div></div>
      <p className="hint">
        {k.reusable ? 'Reusable' : 'Single use'}{k.ephemeral ? ', ephemeral' : ''}, expires {new Date(k.expiration).toLocaleString()}.
        {k.aclTags.length ? ` Machines get ${k.aclTags.join(', ')}.` : ''}
      </p>
    </div>
  )
}
