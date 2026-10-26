import { useEffect, useId, useRef, useState } from 'react'

export interface ComboboxOption {
  value: string
  label: string
  sublabel?: string
}

interface Props {
  label?: string
  value: string
  displayValue?: string
  placeholder?: string
  options: ComboboxOption[]
  onQueryChange: (query: string) => void
  onSelect: (option: ComboboxOption) => void
  required?: boolean
  emptyMessage?: string
}

/** Type-to-filter dropdown; select sets a stable value (e.g. IATA) while showing a label. */
export default function SearchableCombobox({
  label,
  value,
  displayValue,
  placeholder,
  options,
  onQueryChange,
  onSelect,
  required,
  emptyMessage = 'No matches',
}: Props) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(displayValue || value || '')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setText(displayValue || value || '')
  }, [value, displayValue])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="combobox" ref={wrapRef}>
      {label && <label htmlFor={id}>{label}</label>}
      <input
        id={id}
        value={text}
        placeholder={placeholder}
        required={required && !value}
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open}
        onFocus={() => {
          setOpen(true)
          onQueryChange(text)
        }}
        onChange={e => {
          const q = e.target.value
          setText(q)
          setOpen(true)
          onQueryChange(q)
        }}
        onKeyDown={e => {
          if (e.key === 'Escape') setOpen(false)
          if (e.key === 'Enter' && open && options[0]) {
            e.preventDefault()
            onSelect(options[0])
            setText(options[0].label)
            setOpen(false)
          }
        }}
      />
      {open && (
        <ul className="combobox-list" role="listbox">
          {options.length === 0 && <li className="combobox-empty">{emptyMessage}</li>}
          {options.map(opt => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={opt.value === value}
                className={opt.value === value ? 'selected' : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  onSelect(opt)
                  setText(opt.label)
                  setOpen(false)
                }}
              >
                <span className="combobox-label">{opt.label}</span>
                {opt.sublabel && <span className="combobox-sub">{opt.sublabel}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
