import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useAuth } from '../context/AuthContext'
import {
  BOOKING_APPS,
  awardDeepLink,
  emptyAwardSearch,
  listAwardSearches,
  parseAwardPaste,
  saveAwardSearch,
  deleteAwardSearch,
} from '../lib/awards'
import type { AwardSearch } from '../lib/types'

export default function FlightsPage() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [searches, setSearches] = useState<AwardSearch[]>([])
  const [form, setForm] = useState<AwardSearch | null>(null)
  const [paste, setPaste] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const reload = async () => {
    if (!profile) return
    setSearches(await listAwardSearches(profile.id))
  }

  useEffect(() => {
    if (!profile) return
    setForm(emptyAwardSearch(profile.id))
    reload().catch(e => setErr(e.message))
  }, [profile?.id])

  if (!profile || !form) return null

  const set = <K extends keyof AwardSearch>(key: K, value: AwardSearch[K]) => {
    setForm(prev => (prev ? { ...prev, [key]: value } : prev))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setMsg('')
    if (!form.origin.trim() || !form.destination.trim()) {
      setErr('Origin and destination are required.')
      return
    }
    setSaving(true)
    try {
      const preferred = profile.preferred_booking_apps?.[0] || form.booking_app
      const saved = await saveAwardSearch({
        ...form,
        id: form.id || emptyAwardSearch(profile.id).id,
        user_id: profile.id,
        booking_app: preferred || form.booking_app,
        best_url: awardDeepLink(form.booking_app, form.origin, form.destination, form.date_start),
      })
      setForm(emptyAwardSearch(profile.id))
      setMsg('Search saved. Overnight monitoring runs when SEATS_AERO_API_KEY is configured on the server.')
      await reload()
      void saved
    } catch (x: any) {
      setErr(x.message)
    } finally {
      setSaving(false)
    }
  }

  const applyPaste = async (search: AwardSearch) => {
    const parsed = parseAwardPaste(paste)
    if (!parsed) { setErr('Paste award availability text first.'); return }
    try {
      await saveAwardSearch({
        ...search,
        best_summary: parsed.summary,
        best_points: parsed.points,
        best_url: awardDeepLink(search.booking_app, search.origin, search.destination, search.date_start),
        updated_at: new Date().toISOString(),
      })
      setPaste('')
      setMsg('Best result updated from paste.')
      await reload()
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const remove = async (id: string) => {
    await deleteAwardSearch(id)
    await reload()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <TopBar />
      <div className="flights-layout">
        <aside className="flights-search-panel panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <h1 style={{ margin: 0, fontSize: '1.35rem', color: 'var(--slate-800)' }}>Award Flights</h1>
            <button type="button" className="btn-ghost" onClick={() => nav('/')}>Main</button>
          </div>
          <p className="places-hint" style={{ marginTop: 0 }}>
            Save a search for overnight monitoring via Seats.aero (when the API key is set). Prefer Roame or Google Flights deep links to finish booking.
          </p>
          <form onSubmit={submit} className="flights-form">
            <label>Origin</label>
            <input value={form.origin} onChange={e => set('origin', e.target.value)} placeholder="SFO" required />
            <label>Destination</label>
            <input value={form.destination} onChange={e => set('destination', e.target.value)} placeholder="NRT" required />
            <div className="flights-row">
              <div>
                <label>Date from</label>
                <input type="date" value={form.date_start} onChange={e => set('date_start', e.target.value)} />
              </div>
              <div>
                <label>Date to</label>
                <input type="date" value={form.date_end} onChange={e => set('date_end', e.target.value)} />
              </div>
            </div>
            <label>Time preference</label>
            <select value={form.time_pref} onChange={e => set('time_pref', e.target.value)}>
              <option value="any">Any</option>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon</option>
              <option value="evening">Evening</option>
              <option value="overnight">Overnight</option>
            </select>
            <div className="flights-row">
              <div>
                <label>Points min</label>
                <input type="number" min={0} value={form.points_min} onChange={e => set('points_min', Number(e.target.value))} />
              </div>
              <div>
                <label>Points max</label>
                <input type="number" min={0} value={form.points_max} onChange={e => set('points_max', Number(e.target.value))} />
              </div>
            </div>
            <label>Preferred airline</label>
            <input value={form.preferred_airline} onChange={e => set('preferred_airline', e.target.value)} placeholder="Any" />
            <div className="flights-row">
              <div>
                <label>Cabin</label>
                <select value={form.cabin} onChange={e => set('cabin', e.target.value)}>
                  <option value="economy">Economy</option>
                  <option value="premium_economy">Premium economy</option>
                  <option value="business">Business</option>
                  <option value="first">First</option>
                </select>
              </div>
              <div>
                <label>Seats</label>
                <input type="number" min={1} max={9} value={form.seats} onChange={e => set('seats', Number(e.target.value))} />
              </div>
            </div>
            <label>Booking app</label>
            <select value={form.booking_app} onChange={e => set('booking_app', e.target.value)}>
              {BOOKING_APPS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <label className="places-toggle" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={form.notify} onChange={e => set('notify', e.target.checked)} />
              <span>Notify when a viable award appears</span>
            </label>
            <button type="submit" className="btn-orange" style={{ marginTop: 14 }} disabled={saving}>
              {saving ? 'Saving…' : 'Save search'}
            </button>
          </form>
          {msg && <div className="success" style={{ marginTop: 12 }}>{msg}</div>}
          {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
        </aside>

        <div className="flights-divider" aria-hidden />

        <section className="flights-results-panel">
          <h2 style={{ marginTop: 0, fontSize: '1.2rem', color: 'var(--slate-800)' }}>Current searches</h2>
          {searches.length === 0 ? (
            <p className="places-hint">No saved searches yet. Create one on the left.</p>
          ) : (
            <ul className="award-search-list">
              {searches.map(s => (
                <li key={s.id} className="panel award-search-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{s.origin} → {s.destination}</strong>
                    <span className="places-hint">{s.cabin} · {s.seats} seat{s.seats === 1 ? '' : 's'}</span>
                  </div>
                  <p className="places-hint" style={{ margin: '6px 0' }}>
                    {s.date_start}{s.date_end && s.date_end !== s.date_start ? ` – ${s.date_end}` : ''}
                    {s.preferred_airline ? ` · ${s.preferred_airline}` : ''}
                    {s.notify ? ' · alerts on' : ''}
                  </p>
                  <p style={{ margin: '8px 0', color: 'var(--slate-800)' }}>
                    {s.best_summary
                      ? <>Best so far: {s.best_summary}{s.best_points != null ? ` (${s.best_points.toLocaleString()} pts)` : ''}</>
                      : 'No overnight result yet — use deep links or paste availability below.'}
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <a className="btn-orange" style={{ textDecoration: 'none' }} href={awardDeepLink(s.booking_app, s.origin, s.destination, s.date_start)} target="_blank" rel="noreferrer">
                      Open {BOOKING_APPS.find(a => a.id === s.booking_app)?.label || 'booking app'}
                    </a>
                    <button type="button" className="btn-ghost" onClick={() => remove(s.id)}>Remove</button>
                  </div>
                  <label style={{ marginTop: 12 }}>Paste award result (no Seats.aero key needed)</label>
                  <textarea rows={2} value={paste} onChange={e => setPaste(e.target.value)} placeholder="e.g. UA 837 · 70,000 pts business · Apr 12" />
                  <button type="button" className="btn-ghost" style={{ marginTop: 8 }} onClick={() => applyPaste(s)}>Update best from paste</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
