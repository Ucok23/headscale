import { useEffect, useState, type ReactNode } from 'react'
import { Toasts } from './Modal'

export type Page = 'machines' | 'network' | 'activity' | 'policy' | 'users' | 'keys' | 'settings'
const PAGES: { id: Page; label: string }[] = [
  { id: 'machines', label: 'Machines' },
  { id: 'network', label: 'Network' },
  { id: 'activity', label: 'Activity' },
  { id: 'policy', label: 'Policy' },
  { id: 'users', label: 'Users' },
  { id: 'keys', label: 'Keys' },
  { id: 'settings', label: 'Settings' },
]

export type Route = { page: Page; id?: string }

/** `#/machines/3` is the machine page for node 3. */
const fromHash = (): Route => {
  const [h, id] = window.location.hash.replace(/^#\/?/, '').split('/')
  return PAGES.some((p) => p.id === h) ? { page: h as Page, id: id || undefined } : { page: 'machines' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(fromHash)
  useEffect(() => {
    const on = () => setRoute(fromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export function Shell({ page, onLogout, children }: { page: Page; onLogout: () => void; children: ReactNode }) {
  return (
    <>
      <nav className="topnav">
        <strong>Headscale</strong>
        {PAGES.map((p) => (
          <a key={p.id} href={`#/${p.id}`} className={page === p.id ? 'on' : ''}>{p.label}</a>
        ))}
        <span className="spacer" />
        <button className="ghost" onClick={onLogout}>Sign out</button>
      </nav>
      {children}
      <Toasts />
    </>
  )
}
