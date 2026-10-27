import { useEffect, useRef, useState } from 'react'
import type { Stop } from '../lib/types'
import { searchPlaces } from '../lib/geocoding'

export default function MajorStopsInput({
  value,
  onChange,
  placeholder,
  near,
}: {
  value: Stop[]
  onChange: (stops: Stop[]) => void
  placeholder?: string
  /** Bias geocoding toward trip destination. */
  near?: { lat: number; lng: number } | null
}) {
  const toText = (stops: Stop[]) => stops.map(s => s.name).join(', ')
  const [text, setText] = useState(() => toText(value))
  const [geocoding, setGeocoding] = useState(false)
  const focused = useRef(false)
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => { if (!focused.current) setText(toText(value)) }, [value])

  const parse = (t: string): Stop[] => {
    const prev = new Map(valueRef.current.map(s => [s.name.toLowerCase(), s]))
    return t.split(',').map(s => s.trim()).filter(Boolean).map(name => prev.get(name.toLowerCase()) ?? { name })
  }

  const commit = async (raw: string) => {
    const stops = parse(raw)
    setText(toText(stops))
    const needGeo = stops.filter(s => s.lat == null || s.lng == null)
    if (!needGeo.length) {
      onChange(stops)
      return
    }
    setGeocoding(true)
    try {
      const next = [...stops]
      for (let i = 0; i < next.length; i++) {
        const s = next[i]
        if (s.lat != null && s.lng != null) continue
        const hits = await searchPlaces(s.name, { near: near || undefined, limit: 1 })
        if (hits[0]) next[i] = { ...s, lat: hits[0].lat, lng: hits[0].lng }
      }
      onChange(next)
      setText(toText(next))
    } finally {
      setGeocoding(false)
    }
  }

  return (
    <div>
      <input
        value={text}
        placeholder={placeholder ?? 'Stop 1, Stop 2'}
        onFocus={() => { focused.current = true }}
        onBlur={() => {
          focused.current = false
          void commit(text)
        }}
        onChange={e => {
          setText(e.target.value)
          onChange(parse(e.target.value))
        }}
      />
      {geocoding && <p className="places-hint" style={{ margin: '4px 0 0' }}>Locating stops on the map…</p>}
    </div>
  )
}
