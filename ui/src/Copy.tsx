import { useRef, useState, type ReactNode } from 'react'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs a secure context; fall back for plain http on a LAN.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { return document.execCommand('copy') } catch { return false } finally { ta.remove() }
  }
}

/** Small icon button that copies `value` and briefly confirms. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<number>(undefined)
  const click = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setState((await copyText(value)) ? 'ok' : 'fail')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1300)
  }
  return (
    <button type="button" className={`copybtn ${state}`} onClick={click} title={`${label}: ${value}`} aria-label={`${label} ${value}`}>
      {state === 'ok' ? '✓' : state === 'fail' ? '!' : <CopyIcon />}
      <span className="sr">{state === 'ok' ? 'Copied' : label}</span>
    </button>
  )
}

/** A value with a copy button next to it. */
export function Copyable({ value, children, mono = true }: { value: string; children?: ReactNode; mono?: boolean }) {
  return (
    <span className={`copyable ${mono ? 'mono' : ''}`}>
      <span className="cv">{children ?? value}</span>
      <CopyButton value={value} />
    </span>
  )
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
    </svg>
  )
}
