import createClient from 'openapi-fetch'
import type { components, paths } from './schema'

export type Node = components['schemas']['Node']
export type ActivityEvent = components['schemas']['ListEventsOutputBody']['events'][number]
export type Traffic = components['schemas']['TrafficOutputBody']
export type Info = components['schemas']['InfoResponseBody']
export type User = components['schemas']['User']
export type PreAuthKey = components['schemas']['PreAuthKey']
export type ApiKey = components['schemas']['ApiKey']
export type SimNode = components['schemas']['SimNode']
export type SimulateQuery = components['schemas']['SimulateQuery']
export type SimulateResult = components['schemas']['SimulateResult']
export type ReachEdge = components['schemas']['ReachEdge']

const KEY = 'headscale.apikey'

export const getKey = () => localStorage.getItem(KEY) ?? ''
export const setKey = (k: string) => localStorage.setItem(KEY, k)
export const clearKey = () => localStorage.removeItem(KEY)

export const api = createClient<paths>({
  baseUrl: window.location.origin,
  fetch: (req) => {
    req.headers.set('Authorization', `Bearer ${getKey()}`)
    return fetch(req)
  },
})

/**
 * Pull a human message out of a problem+json error body. The useful reason is
 * usually in errors[].message while `detail` only names the action
 * ("deleting user"), so show both: "deleting user: user not empty: …".
 */
export function errMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { detail?: string; title?: string; errors?: { message?: string }[] }
    const reasons = (o.errors ?? []).map((x) => x.message).filter((m): m is string => !!m && m !== o.detail)
    const head = o.detail ?? o.title
    if (head && reasons.length) return `${head}: ${reasons.join('; ')}`
    return head ?? reasons.join('; ') ?? JSON.stringify(e)
  }
  return String(e)
}

/** The v2 API (Tailscale-shaped) is not part of the generated schema; call it directly. */
export async function v2<T = unknown>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T; error: string }> {
  const res = await fetch(window.location.origin + path, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${getKey()}`, ...init.headers },
  })
  const text = await res.text()
  let data: unknown = {}
  try { data = text ? JSON.parse(text) : {} } catch { /* not JSON */ }
  const o = data as { message?: string; detail?: string; error_description?: string }
  return { ok: res.ok, status: res.status, data: data as T, error: res.ok ? '' : o.message ?? o.detail ?? o.error_description ?? `HTTP ${res.status}` }
}

export type V2Key = { id: string; keyType: string; description?: string; created?: string; expires?: string; invalid?: boolean; scopes?: string[]; key?: string }
