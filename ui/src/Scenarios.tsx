import type { SimulateResult } from './api/client'

export type Scenario = { id: string; src: string; dst: string; port: number; proto: string; expect: boolean }

type Props = {
  scenarios: Scenario[]
  results: SimulateResult[]
  onRemove: (id: string) => void
  onLoad: (s: Scenario) => void
}

export function Scenarios({ scenarios, results, onRemove, onLoad }: Props) {
  if (!scenarios.length) return <p className="hint">None yet. Try a flow in the playground and pin it.</p>

  const failing = scenarios.filter((s, i) => results[i] && !results[i].error && results[i].allowed !== s.expect).length

  return (
    <>
      <p className={`hint ${failing ? 'bad' : 'good'}`}>
        {failing ? `${failing} of ${scenarios.length} scenarios would break` : `All ${scenarios.length} scenarios hold`}
      </p>
      <ul className="scen">
        {scenarios.map((s, i) => {
          const r = results[i]
          const pass = r && !r.error && r.allowed === s.expect
          const cls = !r ? 'idle' : r.error ? 'idle' : pass ? 'pass' : 'fail'
          return (
            <li key={s.id} className={cls}>
              <button className="link" onClick={() => onLoad(s)}>
                {s.src} → {s.dst}{s.proto === 'icmp' ? '' : `:${s.port}`}/{s.proto}
              </button>
              <span className="exp">must {s.expect ? 'allow' : 'deny'}</span>
              <span className="res">{!r ? '…' : r.error ? r.error : pass ? '✓' : `✗ is ${r.allowed ? 'allowed' : 'denied'}`}</span>
              <button className="x" aria-label="Remove" onClick={() => onRemove(s.id)}>×</button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
