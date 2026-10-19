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

/** Pull a human message out of a problem+json error body. */
export function errMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { detail?: string; title?: string }
    return o.detail ?? o.title ?? JSON.stringify(e)
  }
  return String(e)
}
