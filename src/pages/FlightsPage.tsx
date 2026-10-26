import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../components/TopBar'
import SearchableCombobox, { type ComboboxOption } from '../components/SearchableCombobox'
import { useAuth } from '../context/AuthContext'
import {
  BOOKING_APPS,
  awardDeepLink,
  bookingAppHasHandoff,
  emptyAwardSearch,
  listAwardSearches,
  saveAwardSearch,
  deleteAwardSearch,
  seatsAeroUrl,
} from '../lib/awards'
import { airportByIata, formatAirportOption, searchAirports } from '../lib/airports'
import { AIRLINES, formatAirlineOption, searchAirlines } from '../lib/airlines'
import type { AwardSearch } from '../lib/types'

export default function FlightsPage() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [searches, setSearches] = useState<AwardSearch[]>([])
  const [form, setForm] = useState<AwardSearch | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [originQ, setOriginQ] = useState('')
  const [destQ, setDestQ] = useState('')
  const [airlineQ, setAirlineQ] = useState('')

  const reload = async () => {
    if (!profile) return
    setSearches(await listAwardSearches(profile.id))
  }

  useEffect(() => {
    if (!profile) return
    setForm(emptyAwardSearch(profile.id))
    reload().catch(e => setErr(e.message))
    const t = window.setInterval(() => { reload().catch(() => {}) }, 60_000)
    return () => window.clearInterval(t)
  }, [profile?.id])

  const originOpts: ComboboxOption[] = useMemo(
    () => searchAirports(originQ).map(a => ({
      value: a.iata,
      label: formatAirportOption(a),
      sublabel: a.size ? `${a.size} hub` : undefined,
    })),
    [originQ],
  )
  const destOpts: ComboboxOption[] = useMemo(
    () => searchAirports(destQ).map(a => ({
      value: a.iata,
      label: formatAirportOption(a),
      sublabel: a.size ? `${a.size} hub` : undefined,
    })),
    [destQ],
  )
  const airlineOpts: ComboboxOption[] = useMemo(
    () => searchAirlines(airlineQ, 30).map(a => ({
      value: a.id === 'any' ? '' : (a.iata || a.name),
      label: formatAirlineOption(a),
    })),
    [airlineQ],
  )

  if (!profile || !form) return null

  const set = <K extends keyof AwardSearch>(key: K, value: AwardSearch[K]) => {
    setForm(prev => (prev ? { ...prev, [key]: value } : prev))
  }

  const originDisplay = (() => {
    const a = airportByIata(form.origin)
    return a ? formatAirportOption(a) : form.origin
  })()
  const destDisplay = (() => {
    const a = airportByIata(form.destination)
    return a ? formatAirportOption(a) : form.destination
  })()
  const airlineDisplay = (() => {
    if (!form.preferred_airline) return 'Any airline'
    const hit = AIRLINES.find(a =>
      a.iata === form.preferred_airline
      || a.name === form.preferred_airline
      || a.id === form.preferred_airline,
    )
    return hit ? formatAirlineOption(hit) : form.preferred_airline
  })()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setMsg('')
    if (!form.origin.trim() || !form.destination.trim()) {
      setErr('Origin and destination are required.')
      return
    }
    setSaving(true)
    try {
      const app = form.booking_app || profile.preferred_booking_apps?.[0] || 'roame'
      const useSeats = form.seats_fallback || !bookingAppHasHandoff(app)
      await saveAwardSearch({
        ...form,
        id: form.id || emptyAwardSearch(profile.id).id,
        user_id: profile.id,
        booking_app: app,
        seats_fallback: useSeats,
        account_label: form.account_label || '',
        best_url: useSeats
          ? seatsAeroUrl(form.origin, form.destination)
          : awardDeepLink(app, form.origin, form.destination, form.date_start),
      })
      setForm(emptyAwardSearch(profile.id))
      setMsg('Search saved. When overnight monitoring finds a match, it appears here and in notifications.')
      await reload()
    } catch (x: any) {
      setErr(x.message)
    } finally {
      setSaving(false)
    }
  }

  const toggleNotify = async (s: AwardSearch, notify: boolean) => {
    await saveAwardSearch({ ...s, notify, active: notify ? s.active : s.active })
    await reload()
  }

  const toggleActive = async (s: AwardSearch, active: boolean) => {
    await saveAwardSearch({ ...s, active })
    await reload()
  }

  const useSeatsFallback = async (s: AwardSearch) => {
    await saveAwardSearch({
      ...s,
      seats_fallback: true,
      booking_app: 'seats_aero',
      best_url: seatsAeroUrl(s.origin, s.destination),
    })
    setMsg('Switched this search to Seats.aero handoff.')
    await reload()
  }

  const remove = async (id: string) => {
    await deleteAwardSearch(id)
    await reload()
  }

  const bookUrl = (s: AwardSearch) => {
    if (s.seats_fallback || s.booking_app === 'seats_aero' || !bookingAppHasHandoff(s.booking_app)) {
      return s.best_url || seatsAeroUrl(s.origin, s.destination)
    }
    return s.best_url || awardDeepLink(s.booking_app, s.origin, s.destination, s.date_start)
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
            Describe your ideal award flight. Overnight monitoring uses Seats.aero when configured, ranks matches with AI,
            then notifies you so you can book in your chosen app.
          </p>
          <form onSubmit={submit} className="flights-form">
            <SearchableCombobox
              label="Origin"
              value={form.origin}
              displayValue={originDisplay}
              placeholder="City or code (SFO, Tokyo…)"
              options={originOpts}
              onQueryChange={setOriginQ}
              onSelect={opt => set('origin', opt.value)}
              required
              emptyMessage="No airports match"
            />
            <SearchableCombobox
              label="Destination"
              value={form.destination}
              displayValue={destDisplay}
              placeholder="City or code (NRT, Seoul…)"
              options={destOpts}
              onQueryChange={setDestQ}
              onSelect={opt => set('destination', opt.value)}
              required
              emptyMessage="No airports match"
            />
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
            <SearchableCombobox
              label="Preferred airline"
              value={form.preferred_airline}
              displayValue={airlineDisplay}
              placeholder="Search airlines…"
              options={airlineOpts}
              onQueryChange={setAirlineQ}
              onSelect={opt => set('preferred_airline', opt.value)}
              emptyMessage="No airlines match"
            />
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
            <label>Account label (optional)</label>
            <input
              value={form.account_label || ''}
              onChange={e => set('account_label', e.target.value)}
              placeholder="e.g. United MileagePlus — never a password"
            />
            <label className="places-toggle" style={{ justifyContent: 'space-between', width: '100%', marginTop: 12 }}>
              <span>Notify when a match is found</span>
              <span className="toggle">
                <input type="checkbox" checked={form.notify} onChange={e => set('notify', e.target.checked)} />
                <span className="slider" />
              </span>
            </label>
            <label className="places-toggle" style={{ justifyContent: 'space-between', width: '100%', marginTop: 12 }}>
              <span>Use Seats.aero if app can’t be viewed</span>
              <span className="toggle">
                <input
                  type="checkbox"
                  checked={Boolean(form.seats_fallback) || form.booking_app === 'seats_aero'}
                  onChange={e => set('seats_fallback', e.target.checked)}
                />
                <span className="slider" />
              </span>
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
          <p className="places-hint">AI / Seats findings appear here. Open the link to finish booking in your app.</p>
          {searches.length === 0 ? (
            <p className="places-hint">No saved searches yet. Create one on the left.</p>
          ) : (
            <ul className="award-search-list">
              {searches.map(s => {
                const appLabel = BOOKING_APPS.find(a => a.id === s.booking_app)?.label || s.booking_app
                const needsSeatsOffer = !s.seats_fallback && s.booking_app !== 'seats_aero' && !bookingAppHasHandoff(s.booking_app)
                return (
                  <li key={s.id} className="panel award-search-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{s.origin} → {s.destination}</strong>
                      <span className="places-hint">{s.cabin} · {s.seats} seat{s.seats === 1 ? '' : 's'}</span>
                    </div>
                    <p className="places-hint" style={{ margin: '6px 0' }}>
                      {s.date_start}{s.date_end && s.date_end !== s.date_start ? ` – ${s.date_end}` : ''}
                      {s.preferred_airline ? ` · ${s.preferred_airline}` : ''}
                      {` · ${appLabel}`}
                      {s.account_label ? ` · ${s.account_label}` : ''}
                    </p>

                    <div className="award-ai-result">
                      {s.best_summary ? (
                        <>
                          <div className="award-ai-label">Best match so far</div>
                          <p style={{ margin: '6px 0', color: 'var(--slate-800)' }}>
                            {s.best_summary}
                            {s.best_points != null ? ` · ${s.best_points.toLocaleString()} pts` : ''}
                          </p>
                          <a className="btn-orange" style={{ textDecoration: 'none', display: 'inline-block' }} href={bookUrl(s)} target="_blank" rel="noreferrer">
                            Book in {s.seats_fallback || s.booking_app === 'seats_aero' ? 'Seats.aero' : appLabel}
                          </a>
                        </>
                      ) : (
                        <p className="places-hint" style={{ margin: 0 }}>
                          Waiting for overnight AI / Seats results. Monitoring {s.active ? 'is on' : 'is paused'}.
                        </p>
                      )}
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 14, alignItems: 'center' }}>
                      <label className="places-toggle">
                        <span style={{ marginRight: 8 }}>Active</span>
                        <span className="toggle">
                          <input type="checkbox" checked={s.active} onChange={e => toggleActive(s, e.target.checked)} />
                          <span className="slider" />
                        </span>
                      </label>
                      <label className="places-toggle">
                        <span style={{ marginRight: 8 }}>Notify</span>
                        <span className="toggle">
                          <input type="checkbox" checked={s.notify} onChange={e => toggleNotify(s, e.target.checked)} />
                          <span className="slider" />
                        </span>
                      </label>
                      <button type="button" className="btn-ghost" onClick={() => remove(s.id)}>Remove</button>
                    </div>

                    {(needsSeatsOffer || (!s.seats_fallback && s.booking_app !== 'seats_aero')) && (
                      <button type="button" className="btn-ghost" style={{ marginTop: 10 }} onClick={() => useSeatsFallback(s)}>
                        Use Seats.aero instead
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
