export function rel(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const ms = new Date(iso).getTime() - Date.now()
  const s = Math.abs(ms) / 1000
  const n = s < 60 ? 'moments' : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`
  return ms > 0 ? `in ${n}` : s < 60 ? 'just now' : `${n} ago`
}

export const DURATIONS: { label: string; ms: number }[] = [
  { label: '1 hour', ms: 3600_000 },
  { label: '1 day', ms: 86400_000 },
  { label: '7 days', ms: 7 * 86400_000 },
  { label: '30 days', ms: 30 * 86400_000 },
  { label: '90 days', ms: 90 * 86400_000 },
  { label: '1 year', ms: 365 * 86400_000 },
]
