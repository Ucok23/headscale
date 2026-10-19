import { useCallback, useEffect, useState } from 'react'
import { api, errMessage, type User } from './api/client'
import { ConfirmDelete, FormModal, toast } from './Modal'
import { rel } from './lib/time'
import { useNodes } from './Machines'

export function useUsers() {
  const [users, setUsers] = useState<User[] | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    const { data, error } = await api.GET('/api/v1/user')
    if (error) setError(errMessage(error)); else { setError(''); setUsers(data.users) }
  }, [])
  useEffect(() => { reload() }, [reload])
  return { users, error, reload }
}

export function Users() {
  const { users, error, reload } = useUsers()
  const { nodes } = useNodes(15000)
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'rename' | 'delete'; user: User } | null>(null)
  const count = (u: User) => (nodes ?? []).filter((n) => !n.tags.length && n.user.id === u.id).length

  return (
    <div className="app">
      <header>
        <h1>Users</h1>
        <span className="hint">Every machine is owned by a user, or by tags.</span>
        <span className="spacer" />
        <button onClick={() => setDlg({ kind: 'new' })}>Add user</button>
      </header>
      {error && <div className="banner err">{error}</div>}
      {!users ? <p className="hint">Loading…</p> : users.length === 0 ? <p className="hint">No users yet.</p> : (
        <div className="panel tablewrap">
          <table className="machines">
            <thead><tr><th>User</th><th>Email</th><th>Login</th><th>Machines</th><th>Created</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.name}</strong>{u.displayName && <div className="sub">{u.displayName}</div>}</td>
                  <td>{u.email || <span className="sub">—</span>}</td>
                  <td className="sub">{u.provider || 'local'}</td>
                  <td>{nodes ? count(u) : '…'}</td>
                  <td className="sub">{rel(u.createdAt)}</td>
                  <td className="r nowrap">
                    <button className="ghost small" onClick={() => setDlg({ kind: 'rename', user: u })}>Rename</button>{' '}
                    <button className="ghost small danger-text" onClick={() => setDlg({ kind: 'delete', user: u })}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dlg?.kind === 'new' && <NewUser onClose={() => setDlg(null)} onDone={reload} />}
      {dlg?.kind === 'rename' && <RenameUser user={dlg.user} onClose={() => setDlg(null)} onDone={reload} />}
      {dlg?.kind === 'delete' && (
        <ConfirmDelete title="Delete user" name={dlg.user.name} onClose={() => setDlg(null)} label="Delete user"
          body={<>Deleting <b>{dlg.user.name}</b> removes the user. Headscale refuses while the user still owns machines or keys, so remove those first.</>}
          onConfirm={async () => {
            const { error } = await api.DELETE('/api/v1/user/{id}', { params: { path: { id: dlg.user.id } } })
            if (error) return errMessage(error)
            toast(`Deleted ${dlg.user.name}`); reload()
          }} />
      )}
    </div>
  )
}

function NewUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  return (
    <FormModal title="Add user" onClose={onClose} submit="Create user" disabled={!name.trim()}
      onSubmit={async () => {
        const { error } = await api.POST('/api/v1/user', { body: { name: name.trim(), displayName, email } })
        if (error) return errMessage(error)
        toast(`Created ${name.trim()}`); onDone()
      }}>
      <label className="fld">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="alice" /></label>
      <label className="fld">Display name (optional)<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
      <label className="fld">Email (optional)<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    </FormModal>
  )
}

function RenameUser({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(user.name)
  return (
    <FormModal title={`Rename ${user.name}`} onClose={onClose} submit="Rename" disabled={!name.trim() || name === user.name}
      onSubmit={async () => {
        const { error } = await api.POST('/api/v1/user/{oldId}/rename/{newName}', { params: { path: { oldId: user.id, newName: name.trim() } } })
        if (error) return errMessage(error)
        toast(`Renamed to ${name.trim()}`); onDone()
      }}>
      <label className="fld">New name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      <p className="hint">Policy rules that mention <code>{user.name}@</code> will need updating.</p>
    </FormModal>
  )
}
