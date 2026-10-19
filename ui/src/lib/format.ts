export function bytes(n: number): string {
  if (n < 1000) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1000, i = 0
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++ }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`
}

export function proto(n: number): string {
  return ({ 6: 'tcp', 17: 'udp', 1: 'icmp', 58: 'icmp' } as Record<number, string>)[n] ?? String(n)
}

export function clock(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === today.toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`
}
