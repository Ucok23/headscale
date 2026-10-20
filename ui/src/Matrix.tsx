import type { ReachEdge, SimNode, SimulateQuery } from './api/client'

type Props = {
  nodes: SimNode[]
  edges: ReachEdge[]
  selected: SimulateQuery
  onPick: (src: string, dst: string) => void
}

export function Matrix({ nodes, edges, selected, onPick }: Props) {
  if (!nodes.length) return <p className="hint">No nodes registered yet.</p>

  const cell = new Map(edges.map((e) => [`${e.src}>${e.dst}`, e.access]))

  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr><th className="corner">from ↓ / to →</th>{nodes.map((n) => <th key={n.id}>{n.name}</th>)}</tr>
        </thead>
        <tbody>
          {nodes.map((s) => (
            <tr key={s.id}>
              <th>{s.name}</th>
              {nodes.map((d) => {
                if (s.id === d.id) return <td key={d.id} className="self">·</td>
                const acc = cell.get(`${s.id}>${d.id}`)
                const sel = selected.src === s.name && selected.dst === d.name
                return (
                  <td key={d.id} className={`${acc ? 'yes' : 'no'} ${sel ? 'sel' : ''}`}>
                    <button onClick={() => onPick(s.name, d.name)}>
                      {acc ? acc.map((a) => <span key={a} className="chip">{a.replace(/^any:/, '')}</span>) : '—'}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
