import { useMemo, useState, type ReactNode } from 'react'
import { Chip, ChipInput } from './Chips'
import {
  appendTo, getNote, joinDst, removeAt, renameKey, setAt, setNote, swapItems,
  type Grant, type Path, type Policy, type Rule,
} from './lib/policy'

type Props = {
  text: string
  policy: Policy
  users: string[]
  onText: (text: string) => void
}

const SPECIAL = ['*', 'autogroup:member', 'autogroup:internet', 'autogroup:self', 'autogroup:tagged']

export function VisualEditor({ text, policy, users, onText }: Props) {
  const groups = policy.groups ?? {}
  const tagOwners = policy.tagOwners ?? {}
  const hosts = policy.hosts ?? {}
  const rules = (policy.acls ?? []) as Rule[]
  const grants = (policy.grants ?? []) as Grant[]

  const userNames = users.map((u) => `${u}@`)
  const tagNames = Object.keys(tagOwners)
  const targets = useMemo(
    () => [...SPECIAL, ...userNames, ...Object.keys(groups), ...tagNames, ...Object.keys(hosts)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users, policy.groups, policy.tagOwners, policy.hosts],
  )
  const owners = [...userNames, ...Object.keys(groups), ...tagNames]

  // Every edit patches the original text, so comments and layout are kept.
  const set = (path: Path, v: unknown) => onText(setAt(text, path, v))
  const add = (path: Path, v: unknown) => onText(appendTo(text, path, v))
  const del = (path: Path) => onText(removeAt(text, path))
  const note = (path: Path, n: string) => onText(setNote(text, path, n))
  const swap = (arr: Path, i: number, j: number) => onText(swapItems(text, arr, i, j))
  const fresh = (o: object, base: string) => {
    let k = base, i = 2
    while (k in o) k = `${base}${i++}`
    return k
  }

  const noRules = policy.acls === undefined && policy.grants === undefined
  const emptyRules = !noRules && rules.length + grants.length === 0

  return (
    <div className="visual">
      {noRules && <div className="banner warn">No rules defined: Headscale allows <b>all</b> traffic between nodes. Add a rule to start restricting.</div>}
      {emptyRules && <div className="banner warn">The rule lists are empty: <b>all</b> traffic is denied.</div>}

      <Section title="Grants" badge="recommended"
        hint="Who may reach what, and how. Replaces ACLs; use these for new rules.">
        {grants.map((g, i) => (
          <Card key={i} index={i} badge="Grant" note={getNote(text, ['grants', i])} onNote={(n) => note(['grants', i], n)}
            onUp={i > 0 ? () => swap(['grants'], i, i - 1) : undefined}
            onDown={i < grants.length - 1 ? () => swap(['grants'], i, i + 1) : undefined}
            onDelete={() => del(['grants', i])}
            warn={!g.src?.length || !g.dst?.length || (!g.ip?.length && !g.app) ? 'A grant needs a source, a destination, and access (IP/ports or app capabilities).' : ''}>
            <div className="rule-body">
              <Field label="From">
                <ChipInput values={g.src ?? []} suggestions={targets} placeholder="who? user, group, tag, *"
                  onChange={(v) => set(['grants', i, 'src'], v)} />
              </Field>
              <div className="to">→</div>
              <Field label="To">
                <ChipInput values={g.dst ?? []} suggestions={targets} placeholder="what? tag, host, user, *"
                  onChange={(v) => set(['grants', i, 'dst'], v)} />
              </Field>
            </div>
            <Field label="Access" hint="protocol and ports">
              <IpAccess values={g.ip ?? []} onChange={(v) => set(['grants', i, 'ip'], v)} />
            </Field>
            <Advanced grant={g} tags={tagNames} onVia={(v) => set(['grants', i, 'via'], v)}
              onApp={(v) => set(['grants', i, 'app'], v)} />
          </Card>
        ))}
        <button type="button" className="ghost add"
          onClick={() => add(['grants'], { src: [], dst: [], ip: ['*'] })}>+ Add grant</button>
      </Section>

      <Section title="ACL rules" badge="legacy" hint="The older format. Still supported, and can sit next to grants.">
        {rules.map((r, i) => (
          <AclCard key={i} index={i} rule={r} targets={targets} note={getNote(text, ['acls', i])}
            onNote={(n) => note(['acls', i], n)}
            onChange={(k, v) => set(['acls', i, k], v)}
            onUp={i > 0 ? () => swap(['acls'], i, i - 1) : undefined}
            onDown={i < rules.length - 1 ? () => swap(['acls'], i, i + 1) : undefined}
            onDelete={() => del(['acls', i])} />
        ))}
        <button type="button" className="ghost add"
          onClick={() => add(['acls'], { action: 'accept', src: [], dst: [] })}>+ Add ACL rule</button>
      </Section>

      <Section title="Groups" hint="Name a set of users once, then use the group in rules.">
        {Object.entries(groups).map(([name, members]) => (
          <Row key={name} path={['groups', name]} text={text} onNote={note}
            label={<NameInput value={name} prefix="group:" onCommit={(n) => onText(renameKey(text, ['groups', name], n))} />}
            onDelete={() => del(['groups', name])}>
            <ChipInput values={members} suggestions={userNames} placeholder="add users, e.g. alice@"
              onChange={(v) => set(['groups', name], v)} />
          </Row>
        ))}
        <button type="button" className="ghost add" onClick={() => set(['groups', fresh(groups, 'group:new')], [])}>+ Add group</button>
      </Section>

      <Section title="Tags" hint="A tag marks servers or services. Owners decide who may put the tag on a machine.">
        {Object.entries(tagOwners).map(([name, own]) => (
          <Row key={name} path={['tagOwners', name]} text={text} onNote={note}
            label={<NameInput value={name} prefix="tag:" onCommit={(n) => onText(renameKey(text, ['tagOwners', name], n))} />}
            onDelete={() => del(['tagOwners', name])}>
            <ChipInput values={own} suggestions={owners} placeholder="owners"
              onChange={(v) => set(['tagOwners', name], v)} />
          </Row>
        ))}
        <button type="button" className="ghost add" onClick={() => set(['tagOwners', fresh(tagOwners, 'tag:new')], [])}>+ Add tag</button>
      </Section>

      <Section title="Hosts" hint="Friendly names for IPs or subnets.">
        {Object.entries(hosts).map(([name, ip]) => (
          <Row key={name} path={['hosts', name]} text={text} onNote={note}
            label={<NameInput value={name} onCommit={(n) => onText(renameKey(text, ['hosts', name], n))} />}
            onDelete={() => del(['hosts', name])}>
            <input className="plain" value={ip} placeholder="100.64.0.2 or 10.0.0.0/24"
              onChange={(e) => set(['hosts', name], e.target.value)} />
          </Row>
        ))}
        <button type="button" className="ghost add" onClick={() => set(['hosts', fresh(hosts, 'host')], '')}>+ Add host</button>
      </Section>

      <p className="hint">Edits change only what you touch: your comments and layout stay. Notes are saved as <code>//</code> comments above the item.</p>
    </div>
  )
}

/* ---------- ACL (legacy) card ---------- */

function AclCard(p: {
  index: number; rule: Rule; targets: string[]; note: string
  onNote: (n: string) => void; onChange: (key: 'src' | 'dst', v: string[]) => void
  onUp?: () => void; onDown?: () => void; onDelete: () => void
}) {
  const { rule } = p
  const [tgt, setTgt] = useState('')
  const [ports, setPorts] = useState('*')
  const addDst = () => {
    if (!tgt.trim()) return
    p.onChange('dst', [...rule.dst, joinDst(tgt.trim(), ports.trim())])
    setTgt(''); setPorts('*')
  }
  return (
    <Card index={p.index} badge="ACL" note={p.note} onNote={p.onNote} onUp={p.onUp} onDown={p.onDown} onDelete={p.onDelete}
      warn={!rule.src?.length || !rule.dst?.length ? 'A rule needs at least one source and one destination.' : ''}>
      <div className="rule-body">
        <Field label="From">
          <ChipInput values={rule.src ?? []} suggestions={p.targets} placeholder="who? user, group, tag, *"
            onChange={(v) => p.onChange('src', v)} />
        </Field>
        <div className="to">→</div>
        <Field label="To" hint="target : ports">
          <div className="dsts">
            {(rule.dst ?? []).map((d) => <Chip key={d} value={d} onRemove={() => p.onChange('dst', rule.dst.filter((x) => x !== d))} />)}
          </div>
          <div className="adddst">
            <input list={`t-${p.index}`} value={tgt} placeholder="what? tag, host, user, *" onChange={(e) => setTgt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDst())} />
            <datalist id={`t-${p.index}`}>{p.targets.map((t) => <option key={t} value={t} />)}</datalist>
            <input className="ports" value={ports} placeholder="ports" onChange={(e) => setPorts(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDst())} title="e.g. 22,80,8000-8100 or *" />
            <button type="button" className="ghost" disabled={!tgt.trim()} onClick={addDst}>Add</button>
          </div>
        </Field>
      </div>
    </Card>
  )
}

/* ---------- grant pieces ---------- */

const PROTOS = ['any', 'tcp', 'udp', 'icmp']

function IpAccess({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const [proto, setProto] = useState('any')
  const [ports, setPorts] = useState('*')
  const add = () => {
    const p = ports.trim() || '*'
    const v = proto === 'any' ? p : `${proto}:${p}`
    if (!values.includes(v)) onChange([...values, v])
  }
  return (
    <>
      <div className="dsts">
        {values.length === 0 && <span className="hint">No IP access yet.</span>}
        {values.map((v) => <Chip key={v} value={v === '*' ? '* (everything)' : v} onRemove={() => onChange(values.filter((x) => x !== v))} />)}
      </div>
      <div className="adddst">
        <select value={proto} onChange={(e) => setProto(e.target.value)}>{PROTOS.map((p) => <option key={p}>{p}</option>)}</select>
        <input className="ports wide" value={ports} placeholder="ports" title="e.g. 22,80,8000-8100 or *"
          onChange={(e) => setPorts(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
        <button type="button" className="ghost" onClick={add}>Add</button>
      </div>
    </>
  )
}

function Advanced({ grant, tags, onVia, onApp }: {
  grant: Grant; tags: string[]; onVia: (v: string[]) => void; onApp: (v: unknown) => void
}) {
  const appText = grant.app ? JSON.stringify(grant.app, null, 2) : ''
  const [err, setErr] = useState('')
  const active = !!grant.via?.length || !!grant.app
  return (
    <details className="adv" open={active}>
      <summary>Advanced <small>{active ? '· in use' : 'via, app capabilities'}</small></summary>
      <Field label="Via" hint="route this access through these exit or subnet-router tags">
        <ChipInput values={grant.via ?? []} suggestions={tags} placeholder="tag:router" onChange={onVia} />
      </Field>
      <Field label="App capabilities" hint="JSON, e.g. { &quot;tailscale.com/cap/relay&quot;: [] }">
        <textarea className="json" key={appText} defaultValue={appText} spellCheck={false} rows={appText ? Math.min(8, appText.split('\n').length) : 2}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (!v) { setErr(''); return grant.app && onApp(undefined) }
            try { const o = JSON.parse(v); setErr(''); onApp(o) } catch (x) { setErr(String(x)) }
          }} />
        {err && <p className="hint bad">{err}</p>}
      </Field>
    </details>
  )
}

/* ---------- shared bits ---------- */

function Card(p: {
  index: number; badge: string; note: string; warn?: string
  onNote: (n: string) => void; onUp?: () => void; onDown?: () => void; onDelete: () => void; children: ReactNode
}) {
  return (
    <div className={`rule ${p.warn ? 'incomplete' : ''}`}>
      <div className="rule-head">
        <span className="num">{p.index + 1}</span>
        <span className="allow">Allow</span>
        <span className="tagbadge">{p.badge}</span>
        <span className="spacer" />
        <button type="button" className="x" disabled={!p.onUp} onClick={p.onUp} aria-label="Move up">↑</button>
        <button type="button" className="x" disabled={!p.onDown} onClick={p.onDown} aria-label="Move down">↓</button>
        <button type="button" className="x" onClick={p.onDelete} aria-label="Delete">🗑</button>
      </div>
      <NoteField note={p.note} onCommit={p.onNote} />
      {p.children}
      {p.warn && <p className="hint bad">{p.warn}</p>}
    </div>
  )
}

/** Free text saved as `//` comment lines above the item. Commits on blur. */
function NoteField({ note, onCommit }: { note: string; onCommit: (n: string) => void }) {
  return (
    <textarea className="note" key={note} defaultValue={note} rows={Math.max(1, note.split('\n').length)}
      placeholder="Add a note (kept as a // comment)" spellCheck
      onBlur={(e) => e.target.value !== note && onCommit(e.target.value)} />
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="cap">{label} {hint && <small>({hint})</small>}</label>
      {children}
    </div>
  )
}

function Section({ title, badge, hint, children }: { title: string; badge?: string; hint: string; children: ReactNode }) {
  return (
    <section className="vsec">
      <h3>{title} {badge && <span className="tagbadge">{badge}</span>}</h3>
      <p className="hint">{hint}</p>
      {children}
    </section>
  )
}

function Row(p: {
  label: ReactNode; path: Path; text: string; children: ReactNode
  onNote: (path: Path, n: string) => void; onDelete: () => void
}) {
  return (
    <div className="vrowwrap">
      <div className="vrow">
        <div className="vlabel">{p.label}</div>
        <div className="vval">{p.children}</div>
        <button type="button" className="x" onClick={p.onDelete} aria-label="Delete">🗑</button>
      </div>
      <NoteField note={getNote(p.text, p.path)} onCommit={(n) => p.onNote(p.path, n)} />
    </div>
  )
}

/** Name field that commits on blur/Enter so renaming does not rebuild the row on every keystroke. */
function NameInput({ value, prefix, onCommit }: { value: string; prefix?: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  const commit = () => {
    let n = v.trim()
    if (prefix && n && !n.startsWith(prefix)) n = prefix + n
    if (n && n !== value) onCommit(n)
    else setV(value)
  }
  return <input className="plain name" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}
