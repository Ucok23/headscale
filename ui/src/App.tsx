import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api, clearKey, errMessage, getKey, setKey,
  type ReachEdge, type SimNode, type SimulateQuery, type SimulateResult,
} from './api/client'
import { useDebounced, useStored } from './lib/hooks'
import { Matrix } from './Matrix'
import { Playground } from './Playground'
import { Scenarios, type Scenario } from './Scenarios'
import { VisualEditor } from './VisualEditor'
import { parsePolicy } from './lib/policy'
import { Activity } from './Activity'
import { Keys } from './Keys'
import { Machines } from './Machines'
import { NetworkMap } from './NetworkMap'
import { MachineDetail } from './MachineDetail'
import { Settings } from './Settings'
import { Shell, useRoute } from './Shell'
import { Users } from './Users'
import './App.css'

const STARTER = `{
  // Groups, tags and hosts are optional. Edit and watch the simulator react.
  "acls": [
    { "action": "accept", "src": ["*"], "dst": ["*:*"] }
  ]
}
`

type Check = { state: 'idle' | 'checking' | 'ok' } | { state: 'error'; message: string }

export default function App() {
  const [authed, setAuthed] = useState(() => getKey() !== '')
  if (!authed) return <KeyGate onDone={() => setAuthed(true)} />
  return <Pages onLogout={() => { clearKey(); setAuthed(false) }} />
}

function Pages({ onLogout }: { onLogout: () => void }) {
  const { page, id } = useRoute()
  return (
    <Shell page={page} onLogout={onLogout}>
      {page === 'machines' ? (id ? <MachineDetail key={id} id={id} /> : <Machines />) : page === 'network' ? <NetworkMap /> : page === 'activity' ? <Activity /> : page === 'users' ? <Users /> : page === 'keys' ? <Keys /> : page === 'settings' ? <Settings /> : <Workbench onLogout={onLogout} />}
    </Shell>
  )
}

function KeyGate({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState('')
  return (
    <main className="gate">
      <h1>Headscale admin</h1>
      <p>Paste an API key. Create one with <code>headscale apikeys create</code>.</p>
      <form onSubmit={(e) => { e.preventDefault(); setKey(v.trim()); onDone() }}>
        <input type="password" autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="API key" />
        <button disabled={!v.trim()}>Continue</button>
      </form>
    </main>
  )
}

function Workbench({ onLogout }: { onLogout: () => void }) {
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [nodes, setNodes] = useState<SimNode[]>([])
  const [edges, setEdges] = useState<ReachEdge[]>([])
  const [scenarios, setScenarios] = useStored<Scenario[]>('headscale.scenarios', [])
  const [play, setPlay] = useState<SimulateQuery>({ src: '', dst: '', port: 22, proto: 'tcp' })
  const [results, setResults] = useState<SimulateResult[]>([])
  const [saveMsg, setSaveMsg] = useState('')
  const [tab, setTab] = useStored<'visual' | 'code'>('headscale.tab', 'visual')
  const [users, setUsers] = useState<string[]>([])

  // Load the stored policy. Database mode answers 500 until one has been set.
  useEffect(() => {
    api.GET('/api/v1/policy').then(({ data, error, response }) => {
      if (response.status === 401) return onLogout()
      const text = data?.policy ?? ''
      if (error && !/not found/i.test(errMessage(error))) setLoadErr(errMessage(error))
      setSaved(text)
      setDraft(text || STARTER)
    })
  }, [onLogout])

  useEffect(() => {
    api.GET('/api/v1/user').then(({ data }) => setUsers((data?.users ?? []).map((u) => u.name)))
  }, [])

  const parsed = useMemo(() => parsePolicy(draft), [draft])
  const dirty = saved !== null && draft !== saved
  const dDraft = useDebounced(draft)

  // Validate the draft against live users and nodes.
  useEffect(() => {
    if (saved === null) return
    let stale = false
    setCheck({ state: 'checking' })
    api.POST('/api/v1/policy/check', { body: { policy: dDraft } }).then(({ error }) => {
      if (!stale) setCheck(error ? { state: 'error', message: errMessage(error) } : { state: 'ok' })
    })
    return () => { stale = true }
  }, [dDraft, saved])

  const valid = check.state === 'ok'

  // Recompute who-can-reach-whom for a valid draft.
  useEffect(() => {
    if (!valid) return
    let stale = false
    api.POST('/api/v1/policy/reachability', { body: { policy: dDraft } }).then(({ data }) => {
      if (stale || !data) return
      setNodes(data.nodes)
      setEdges(data.edges)
      setPlay((p) => (p.src ? p : { ...p, src: data.nodes[0]?.name ?? '', dst: data.nodes[1]?.name ?? data.nodes[0]?.name ?? '' }))
    })
    return () => { stale = true }
  }, [valid, dDraft])

  // Run the playground query plus every saved scenario against the draft.
  const dPlay = useDebounced(play, 150)
  useEffect(() => {
    if (!valid || !dPlay.src || !dPlay.dst) return
    let stale = false
    const queries = [dPlay, ...scenarios.map(({ src, dst, port, proto }) => ({ src, dst, port, proto }))]
    api.POST('/api/v1/policy/simulate', { body: { policy: dDraft, queries } }).then(({ data }) => {
      if (!stale && data) setResults(data.results)
    })
    return () => { stale = true }
  }, [valid, dDraft, dPlay, scenarios])

  const save = useCallback(async () => {
    const { data, error } = await api.PUT('/api/v1/policy', { body: { policy: draft } })
    if (error) return setSaveMsg(errMessage(error))
    setSaved(data.policy)
    setSaveMsg('Saved and applied.')
    setTimeout(() => setSaveMsg(''), 3000)
  }, [draft])

  const scenarioResults = useMemo(() => results.slice(1), [results])

  if (saved === null) return <main className="gate">Loading…</main>

  return (
    <div className="app">
      <header>
        <h1>Policy</h1>
        <span className={`badge ${dirty ? 'warn' : 'ok'}`}>{dirty ? 'unsaved changes' : 'in sync'}</span>
        <span className="spacer" />
        {saveMsg && <span className="note">{saveMsg}</span>}
        <button className="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>Revert</button>
        <button disabled={!dirty || !valid} onClick={save}>Save &amp; apply</button>
      </header>

      {loadErr && <div className="banner err">{loadErr}</div>}

      <div className="cols">
        <section className="panel editor">
          <div className="tabs">
            <button className={tab === 'visual' ? 'on' : ''} onClick={() => setTab('visual')}>Visual</button>
            <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>Code <small>HuJSON</small></button>
          </div>
          {tab === 'code' ? (
            <textarea spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
          ) : parsed.ok ? (
            <VisualEditor text={draft} policy={parsed.value} users={users} onText={setDraft} />
          ) : (
            <div className="banner err">Can't show the visual editor: {parsed.error}. Fix the JSON in the Code tab.</div>
          )}
          <div className={`status ${check.state}`}>
            {check.state === 'ok' && '✓ Valid against current users and nodes'}
            {check.state === 'checking' && 'Checking…'}
            {check.state === 'error' && `✗ ${check.message}`}
          </div>
        </section>

        <div className="stack">
          <section className="panel">
            <h2>Playground <small>can A reach B?</small></h2>
            <Playground
              nodes={nodes}
              query={play}
              onChange={setPlay}
              result={valid ? results[0] : undefined}
              disabled={!valid}
              onPin={(expect) => setScenarios([...scenarios, { id: crypto.randomUUID(), src: play.src, dst: play.dst, port: play.port ?? 0, proto: play.proto ?? 'tcp', expect }])}
            />
          </section>

          <section className="panel">
            <h2>Scenarios <small>checked on every edit</small></h2>
            <Scenarios
              scenarios={scenarios}
              results={scenarioResults}
              onRemove={(id) => setScenarios(scenarios.filter((s) => s.id !== id))}
              onLoad={(s) => setPlay({ src: s.src, dst: s.dst, port: s.port, proto: s.proto })}
            />
          </section>

          <section className="panel">
            <h2>Access matrix <small>click a cell to try it</small></h2>
            <Matrix
              nodes={nodes}
              edges={edges}
              selected={play}
              onPick={(src, dst) => setPlay({ ...play, src, dst })}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
