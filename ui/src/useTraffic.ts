import { useEffect, useState } from 'react'
import { api, type Traffic } from './api/client'

/** Poll /traffic for a window such as 15m, 1h or 24h. */
export function useTraffic(window: string, intervalMs = 5000) {
  const [t, setT] = useState<Traffic | null>(null)
  useEffect(() => {
    let stop = false
    const load = () => api.GET('/api/v1/traffic', { params: { query: { window } } }).then(({ data }) => { if (!stop && data) setT(data) })
    load()
    const id = setInterval(load, intervalMs)
    return () => { stop = true; clearInterval(id) }
  }, [window, intervalMs])
  return t
}
