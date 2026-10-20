import { useId, useState } from 'react'
import { kindOf, splitDst } from './lib/policy'

export function Chip({ value, onRemove }: { value: string; onRemove?: () => void }) {
  const { target, ports } = value.includes(':') && !/^(group|tag|autogroup):[^:]*$/.test(value) ? splitDst(value) : { target: value, ports: '' }
  return (
    <span className={`pchip k-${kindOf(target)}`}>
      <span>{target}</span>
      {ports && <span className="ports">{ports}</span>}
      {onRemove && <button type="button" aria-label={`Remove ${value}`} onClick={onRemove}>×</button>}
    </span>
  )
}

type Props = { values: string[]; onChange: (v: string[]) => void; suggestions: string[]; placeholder?: string }

/** Token input: type or pick a suggestion, Enter/comma adds, Backspace on empty removes the last. */
export function ChipInput({ values, onChange, suggestions, placeholder }: Props) {
  const [text, setText] = useState('')
  const id = useId()
  const add = (raw: string) => {
    const v = raw.trim().replace(/,$/, '')
    if (v && !values.includes(v)) onChange([...values, v])
    setText('')
  }
  return (
    <div className="chipinput">
      {values.map((v) => <Chip key={v} value={v} onRemove={() => onChange(values.filter((x) => x !== v))} />)}
      <input
        list={id}
        value={text}
        placeholder={values.length ? '' : placeholder}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(text) }
          if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1))
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id={id}>{suggestions.filter((s) => !values.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>
    </div>
  )
}
