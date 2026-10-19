import {
  applyEdits, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode,
  type JSONPath, type Node, type ParseError,
} from 'jsonc-parser'

export type Rule = { action?: string; src: string[]; dst: string[]; [k: string]: unknown }
export type Grant = { src: string[]; dst: string[]; ip?: string[]; via?: string[]; app?: Record<string, unknown>; [k: string]: unknown }
export type Policy = {
  groups?: Record<string, string[]>
  tagOwners?: Record<string, string[]>
  hosts?: Record<string, string>
  acls?: Rule[]
  grants?: Grant[]
  [k: string]: unknown
}

export type Parsed = { ok: true; value: Policy } | { ok: false; error: string }

/** Parse HuJSON (comments and trailing commas allowed). */
export function parsePolicy(text: string): Parsed {
  if (!text.trim()) return { ok: true, value: {} }
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return { ok: false, error: printParseErrorCode(errors[0].error) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Policy must be an object' }
  return { ok: true, value: value as Policy }
}

/* ---------- text edits: change the document in place so comments and layout survive ---------- */

export type Path = JSONPath
const FMT = { insertSpaces: true, tabSize: 2 }
const base = (t: string) => (t.trim() ? t : '{}\n')
const tree = (t: string) => parseTree(t, [], { allowTrailingComma: true })

export function setAt(text: string, path: Path, value: unknown): string {
  const t = base(text)
  return applyEdits(t, modify(t, path, value, { formattingOptions: FMT }))
}

export function appendTo(text: string, path: Path, value: unknown): string {
  const t = base(text)
  const root = tree(t)
  const arr = root && findNodeAtLocation(root, path)
  if (!arr || arr.type !== 'array') return setAt(t, path, [value])
  const n = arr.children?.length ?? 0
  return applyEdits(t, modify(t, [...path, n], value, { formattingOptions: FMT, isArrayInsertion: true }))
}

/**
 * Remove a value together with the comment above it. The edit helper also
 * swallows the comment of the *next* sibling (it lies between the two), so that
 * one is captured first and put back afterwards.
 */
export function removeAt(text: string, path: Path): string {
  const last = path[path.length - 1]
  const parentPath = path.slice(0, -1)
  const root = tree(text)
  const parent = root && findNodeAtLocation(root, parentPath)
  let nextPath: Path | undefined
  if (typeof last === 'number' && parent?.children?.[last + 1]) nextPath = [...parentPath, last]
  if (typeof last === 'string' && parent?.children) {
    const at = parent.children.findIndex((p) => p.children?.[0].value === last)
    const next = parent.children[at + 1]
    if (next?.children) nextPath = [...parentPath, next.children[0].value as string]
  }
  // Where the next sibling's note is read from now vs. where it lives after removal.
  const nextNow = typeof last === 'number' ? [...parentPath, last + 1] : nextPath
  const keep = nextNow ? getNote(text, nextNow) : ''

  let t = setNote(text, path, '')
  t = applyEdits(t, modify(t, path, undefined, { formattingOptions: FMT }))
  return nextPath && keep ? setNote(t, nextPath, keep) : t
}

/** Rename an object key without touching its value or comments. */
export function renameKey(text: string, path: Path, newKey: string): string {
  const root = tree(text)
  const node = root && findNodeAtLocation(root, path)
  const prop = node?.parent
  if (!prop || prop.type !== 'property' || !prop.children) return text
  const parentObj = prop.parent
  if (parentObj?.children?.some((p) => p !== prop && p.children?.[0].value === newKey)) return text
  const key = prop.children[0]
  return text.slice(0, key.offset) + JSON.stringify(newKey) + text.slice(key.offset + key.length)
}

type Lead = { inline: boolean; start: number; lineStart: number; indent: string; lines: string[] }

function anchorOf(root: Node | undefined, path: Path): Node | undefined {
  const node = root && findNodeAtLocation(root, path)
  return node?.parent?.type === 'property' ? node.parent : node
}

/** Comment lines (`// ...`) directly above the node, if it starts its own line. */
function leadOf(text: string, offset: number): Lead {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const indent = text.slice(lineStart, offset)
  if (indent.trim() !== '') return { inline: true, start: offset, lineStart, indent, lines: [] }
  let start = lineStart
  const lines: string[] = []
  while (start > 0) {
    const prevEnd = start - 1
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1
    const line = text.slice(prevStart, prevEnd)
    if (!/^\s*\/\//.test(line)) break
    lines.unshift(line.replace(/^\s*\/\/ ?/, '').replace(/\r$/, ''))
    start = prevStart
  }
  return { inline: false, start, lineStart, indent, lines }
}

export function getNote(text: string, path: Path): string {
  const a = anchorOf(tree(text) ?? undefined, path)
  return a ? leadOf(text, a.offset).lines.join('\n') : ''
}

/** Set (or clear, with '') the `//` comment above a rule, group, tag or host. */
export function setNote(text: string, path: Path, note: string): string {
  const a = anchorOf(tree(text) ?? undefined, path)
  if (!a) return text
  const lead = leadOf(text, a.offset)
  if (lead.inline) return text
  const body = note.trim()
    ? note.trim().split('\n').map((l) => `${lead.indent}// ${l}`.trimEnd()).join('\n') + '\n'
    : ''
  return text.slice(0, lead.start) + body + text.slice(lead.lineStart)
}

/** Swap two neighbouring array items, each carried together with its comment. */
export function swapItems(text: string, arrPath: Path, i: number, j: number): string {
  if (Math.abs(i - j) !== 1) return text
  const root = tree(text)
  const arr = root && findNodeAtLocation(root, arrPath)
  const kids = arr?.children
  if (!kids || !kids[i] || !kids[j]) return text
  const [a, b] = i < j ? [kids[i], kids[j]] : [kids[j], kids[i]]
  const aStart = leadOf(text, a.offset).start
  const aEnd = a.offset + a.length
  const bStart = leadOf(text, b.offset).start
  const bEnd = b.offset + b.length
  return text.slice(0, aStart) + text.slice(bStart, bEnd) + text.slice(aEnd, bStart) + text.slice(aStart, aEnd) + text.slice(bEnd)
}

/* ---------- classification helpers ---------- */

export type Kind = 'any' | 'user' | 'group' | 'tag' | 'auto' | 'host' | 'ip'

export function kindOf(s: string): Kind {
  if (s === '*') return 'any'
  if (s.startsWith('group:')) return 'group'
  if (s.startsWith('tag:')) return 'tag'
  if (s.startsWith('autogroup:')) return 'auto'
  if (s.includes('@')) return 'user'
  if (/^[0-9a-f:.]+(\/\d+)?$/i.test(s) && /[.:]/.test(s)) return 'ip'
  return 'host'
}

/** Split an ACL destination "target:ports" at the last colon (tag and IPv6 targets contain colons). */
export function splitDst(d: string): { target: string; ports: string } {
  const i = d.lastIndexOf(':')
  if (i < 0) return { target: d, ports: '*' }
  const ports = d.slice(i + 1)
  if (!/^[\d,*-]+$/.test(ports)) return { target: d, ports: '*' }
  return { target: d.slice(0, i), ports }
}

export const joinDst = (target: string, ports: string) => `${target}:${ports || '*'}`
