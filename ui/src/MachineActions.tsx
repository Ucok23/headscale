import { useState } from 'react'
import { api, errMessage, type Node } from './api/client'
import { ChipInput } from './Chips'
import { ConfirmDelete, FormModal, toast } from './Modal'

type Common = { node: Node; onClose: () => void; onDone: () => void }
const idOf = (n: Node) => ({ nodeId: n.id })

export function RenameDialog({ node, onClose, onDone }: Common) {
  const [name, setName] = useState(node.givenName || node.name)
  const clean = name.trim().toLowerCase()
  return (
    <FormModal title="Rename machine" onClose={onClose} submit="Rename" disabled={!clean || clean === node.givenName}
      onSubmit={async () => {
        const { error } = await api.POST('/api/v1/node/{nodeId}/rename/{newName}', { params: { path: { ...idOf(node), newName: clean } } })
        if (error) return errMessage(error)
        toast(`Renamed to ${clean}`); onDone()
      }}>
      <label className="fld">New name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="hint">Lowercase letters, digits and dashes. This is also the machine's MagicDNS name.</p>
    </FormModal>
  )
}

export function TagsDialog({ node, onClose, onDone, known }: Common & { known: string[] }) {
  const [tags, setTags] = useState<string[]>(node.tags)
  return (
    <FormModal title="Edit tags" onClose={onClose} submit="Save tags" disabled={tags.length === 0}
      onSubmit={async () => {
        const { error } = await api.POST('/api/v1/node/{nodeId}/tags', { params: { path: idOf(node) }, body: { tags } })
        if (error) return errMessage(error)
        toast('Tags updated'); onDone()
      }}>
      <ChipInput values={tags} onChange={setTags} suggestions={known} placeholder="tag:server" />
      <p className="hint">
        Tags must be defined under <code>tagOwners</code> in the policy. A tagged machine is owned by its tags instead of
        a user, and must keep at least one tag.
      </p>
    </FormModal>
  )
}

type Mode = 'never' | 'now' | 'date'

export function ExpiryDialog({ node, onClose, onDone }: Common) {
  const [mode, setMode] = useState<Mode>(node.expiry ? 'date' : 'never')
  const [date, setDate] = useState(() => {
    const d = node.expiry ? new Date(node.expiry) : new Date(Date.now() + 180 * 86400000)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  })
  return (
    <FormModal title="Key expiry" onClose={onClose} submit="Apply" danger={mode === 'now'}
      onSubmit={async () => {
        const body = mode === 'never' ? { disableExpiry: true } : mode === 'date' ? { expiry: new Date(date).toISOString() } : {}
        const { error } = await api.POST('/api/v1/node/{nodeId}/expire', { params: { path: idOf(node) }, body })
        if (error) return errMessage(error)
        toast(mode === 'now' ? 'Key expired' : 'Key expiry updated'); onDone()
      }}>
      <label className="fld inline"><input type="radio" checked={mode === 'never'} onChange={() => setMode('never')} /> Never expire (disable key expiry)</label>
      <label className="fld inline"><input type="radio" checked={mode === 'date'} onChange={() => setMode('date')} /> Expire on</label>
      {mode === 'date' && <input className="plain" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />}
      <label className="fld inline"><input type="radio" checked={mode === 'now'} onChange={() => setMode('now')} /> Expire the key now</label>
      {mode === 'now' && <p className="once">The machine will drop off the network until someone logs in on it again.</p>}
    </FormModal>
  )
}

export function DeleteDialog({ node, onClose, onDone }: Common) {
  const name = node.givenName || node.name
  return (
    <ConfirmDelete title="Delete machine" name={name} onClose={onClose} label="Delete machine"
      body={<>This removes <b>{name}</b> from the tailnet. It frees its IP addresses and cannot be undone. The device can register again, but it will get a new identity.</>}
      onConfirm={async () => {
        const { error } = await api.DELETE('/api/v1/node/{nodeId}', { params: { path: idOf(node) } })
        if (error) return errMessage(error)
        toast(`Deleted ${name}`)
        onDone()
      }} />
  )
}

/** Approve or withdraw the routes a machine advertises. */
export function RouteTable({ node, onDone }: { node: Node; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const isExit = (r: string) => r === '0.0.0.0/0' || r === '::/0'

  const toggle = async (route: string) => {
    // The server sets the whole approved list; an exit route implies both families.
    const group = isExit(route) ? ['0.0.0.0/0', '::/0'] : [route]
    const on = node.approvedRoutes.includes(route)
    const next = on ? node.approvedRoutes.filter((r) => !group.includes(r)) : [...new Set([...node.approvedRoutes, ...group])]
    setBusy(true)
    const { error } = await api.POST('/api/v1/node/{nodeId}/approve_routes', { params: { path: idOf(node) }, body: { routes: next } })
    setBusy(false)
    if (error) return toast(errMessage(error), 'err')
    toast(on ? `Withdrew ${route}` : `Approved ${route}`); onDone()
  }

  if (node.availableRoutes.length === 0) {
    return <p className="hint">This machine does not advertise any subnet or exit routes. Run <code>tailscale up --advertise-routes=10.0.0.0/24</code> or <code>--advertise-exit-node</code> on it.</p>
  }
  return (
    <table className="mini-table"><tbody>
      {node.availableRoutes.map((r) => {
        const on = node.approvedRoutes.includes(r)
        return (
          <tr key={r}>
            <td className="mono">{r}{isExit(r) ? <span className="sub"> exit node</span> : ''}</td>
            <td><span className={`ev ${on ? 'ok' : 'warn'}`}>{on ? 'approved' : 'pending'}</span></td>
            <td className="r"><button className={on ? 'ghost small' : 'small'} disabled={busy} onClick={() => toggle(r)}>{on ? 'Withdraw' : 'Approve'}</button></td>
          </tr>
        )
      })}
    </tbody></table>
  )
}
