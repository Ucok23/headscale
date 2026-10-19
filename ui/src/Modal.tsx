import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

type Props = { title: string; onClose: () => void; children: ReactNode; wide?: boolean }

/** Centered dialog. Escape or a click on the backdrop closes it. */
export function Modal({ title, onClose, children, wide }: Props) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mhead"><h2>{title}</h2><button className="x" onClick={onClose} aria-label="Close">×</button></div>
        {children}
      </div>
    </div>
  )
}

type FormProps = {
  title: string
  onClose: () => void
  /** Return an error message to keep the dialog open, or nothing on success. */
  onSubmit: () => Promise<string | void>
  submit: string
  danger?: boolean
  disabled?: boolean
  children: ReactNode
}

/** A dialog with a form: submit shows progress and any server error inline. */
export function FormModal({ title, onClose, onSubmit, submit, danger, disabled, children }: FormProps) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr('')
    const msg = await onSubmit()
    setBusy(false)
    if (msg) setErr(msg)
    else onClose()
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={go} className="mform">
        {children}
        {err && <div className="banner err">{err}</div>}
        <div className="mfoot">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className={danger ? 'danger' : ''} disabled={busy || disabled}>{busy ? 'Working…' : submit}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Destructive confirmation: the user must type the name of the thing being deleted. */
export function ConfirmDelete({ title, name, body, onClose, onConfirm, label = 'Delete' }: {
  title: string; name: string; body: ReactNode; onClose: () => void; onConfirm: () => Promise<string | void>; label?: string
}) {
  const [typed, setTyped] = useState('')
  return (
    <FormModal title={title} onClose={onClose} onSubmit={onConfirm} submit={label} danger disabled={typed !== name}>
      <div className="mbody">{body}</div>
      <label className="fld">Type <code>{name}</code> to confirm
        <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
    </FormModal>
  )
}

/** One-shot toast notices, shown by <Toasts /> in the shell. */
type Toast = { id: number; text: string; kind: 'ok' | 'err' }
let toasts: Toast[] = []
const listeners = new Set<() => void>()
export function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  const t = { id: Date.now() + Math.random(), text, kind }
  toasts = [...toasts, t]
  listeners.forEach((l) => l())
  setTimeout(() => { toasts = toasts.filter((x) => x !== t); listeners.forEach((l) => l()) }, 4000)
}
export function Toasts() {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
}
