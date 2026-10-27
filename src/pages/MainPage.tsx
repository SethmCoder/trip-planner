import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../components/TopBar'
import MapView from '../components/MapView'
import MajorStopsInput from '../components/MajorStopsInput'
import StatusBadge from '../components/StatusBadge'
import DestinationThumb from '../components/DestinationThumb'
import AvatarStack from '../components/AvatarStack'
import { useAuth } from '../context/AuthContext'
import * as api from '../lib/data'
import * as social from '../lib/social'
import { searchPlaces, type GeoResult } from '../lib/geocoding'
import { placePrimary, placeSecondary } from '../lib/formatPlace'
import {
  bookingStatusLabel,
  formatDateRange,
  newId,
  tripDurationDays,
  type Trip,
  type TripPerson,
} from '../lib/types'
import { resolveTripImage } from '../lib/tripImages'
import { destinationTravelLinks } from '../lib/travelApps'

type Mode = 'list' | 'create' | 'edit' | 'detail'

function blankTrip(userId: string): Trip {
  const today = new Date().toISOString().slice(0, 10)
  return {
    id: newId(),
    user_id: userId,
    name: 'New Trip',
    place: '',
    place_lat: null,
    place_lng: null,
    start_date: today,
    end_date: today,
    major_stops: [],
    booking_status: 'not_booked',
    created_at: new Date().toISOString(),
    image_url: null,
  }
}

function TripForm({
  trip,
  onChange,
  onSave,
  onCancel,
  saveLabel,
  dateError,
}: {
  trip: Trip
  onChange: (t: Trip) => void
  onSave: () => void
  onCancel: () => void
  saveLabel: string
  dateError: string | null
}) {
  const [placeQ, setPlaceQ] = useState(trip.place)
  const [results, setResults] = useState<GeoResult[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<number | null>(null)
  const upd = (p: Partial<Trip>) => onChange({ ...trip, ...p })

  useEffect(() => () => { if (searchTimer.current) window.clearTimeout(searchTimer.current) }, [])

  return (
    <div className="trip-form selected">
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>{saveLabel === 'Create Trip' ? 'Create Trip' : 'Edit Trip'}</h3>
      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-secondary)' }}>
        Name, destination, and dates — then you land on the trip to build the itinerary.
      </p>

      <label htmlFor={`trip-name-${trip.id}`}>Trip Name</label>
      <input id={`trip-name-${trip.id}`} value={trip.name} onChange={e => upd({ name: e.target.value })} placeholder="Trip name" />

      <label htmlFor={`trip-place-${trip.id}`}>Destination</label>
      <input
        id={`trip-place-${trip.id}`}
        value={placeQ}
        onChange={e => {
          const v = e.target.value
          setPlaceQ(v)
          upd({ place: v, place_lat: null, place_lng: null })
          if (searchTimer.current) window.clearTimeout(searchTimer.current)
          if (v.trim().length < 2) { setResults([]); setSearching(false); return }
          setSearching(true)
          searchTimer.current = window.setTimeout(async () => {
            setResults(await searchPlaces(v))
            setSearching(false)
          }, 280)
        }}
        placeholder="City or destination…"
        autoComplete="off"
      />
      {searching && <p className="places-hint">Searching…</p>}
      {results.length > 0 && (
        <div className="autocomplete" role="listbox">
          {results.map((r, i) => {
            const primary = placePrimary(r.name) || r.name
            const secondary = r.detail || placeSecondary(r.display)
            return (
              <button
                key={`${r.lat}-${r.lng}-${i}`}
                type="button"
                role="option"
                onClick={async () => {
                  const next = { ...trip, place: primary, place_lat: r.lat, place_lng: r.lng, image_url: null as string | null }
                  onChange(next)
                  setPlaceQ(primary)
                  setResults([])
                  const img = await resolveTripImage(primary, r.lat, r.lng)
                  onChange({ ...next, image_url: img })
                }}
              >
                <span className="ac-name">{primary}</span>
                {secondary && <span className="ac-detail">{secondary}</span>}
              </button>
            )
          })}
        </div>
      )}

      <label htmlFor={`trip-start-${trip.id}`}>Start Date</label>
      <input id={`trip-start-${trip.id}`} type="date" value={trip.start_date} onChange={e => upd({ start_date: e.target.value })} />

      <label htmlFor={`trip-end-${trip.id}`}>End Date</label>
      <input id={`trip-end-${trip.id}`} type="date" value={trip.end_date} onChange={e => upd({ end_date: e.target.value })} />
      {dateError && <p className="field-error" role="alert">{dateError}</p>}

      <label htmlFor={`trip-stops-${trip.id}`}>Major Stops (comma separated)</label>
      <MajorStopsInput value={trip.major_stops} onChange={stops => upd({ major_stops: stops })} />

      <label htmlFor={`trip-status-${trip.id}`}>Booking Status</label>
      <select
        id={`trip-status-${trip.id}`}
        value={trip.booking_status}
        onChange={e => upd({ booking_status: e.target.value as Trip['booking_status'] })}
      >
        <option value="not_booked">Not Booked</option>
        <option value="partially_booked">Partially Booked</option>
        <option value="booked">Booked</option>
      </select>

      <div className="trip-actions">
        <button type="button" className="btn-orange full" onClick={onSave} disabled={!!dateError}>{saveLabel}</button>
        <button type="button" className="btn-secondary full" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function TripDetail({
  trip,
  people,
  onOpen,
  onEdit,
  onDelete,
}: {
  trip: Trip
  people: TripPerson[]
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const duration = tripDurationDays(trip.start_date, trip.end_date)
  const stops = trip.major_stops.map(s => s.name).filter(Boolean)

  const links = destinationTravelLinks(trip.place)

  return (
    <div className="trip-detail selected">
      {(trip.image_url || (trip.place_lat != null && trip.place_lng != null)) && (
        <div className="trip-detail-cover">
          <DestinationThumb
            place={trip.place}
            name={trip.name}
            lat={trip.place_lat}
            lng={trip.place_lng}
            imageUrl={trip.image_url}
            size={280}
            className="trip-detail-cover-img"
          />
        </div>
      )}
      <div className="trip-detail-header">
        <DestinationThumb
          place={trip.place}
          name={trip.name}
          lat={trip.place_lat}
          lng={trip.place_lng}
          imageUrl={trip.image_url}
          size={64}
          className="trip-detail-thumb"
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{trip.name || 'Untitled Trip'}</h3>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {trip.place || 'Destination not set'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StatusBadge status={trip.booking_status} />
            <AvatarStack people={people} size={30} />
          </div>
        </div>
      </div>

      <div className="trip-detail-row">
        <span>Dates</span>
        <span>{formatDateRange(trip.start_date, trip.end_date)}</span>
      </div>
      <div className="trip-detail-row">
        <span>Duration</span>
        <span>{duration ? `${duration} day${duration === 1 ? '' : 's'}` : '—'}</span>
      </div>
      <div className="trip-detail-row">
        <span>Booking</span>
        <span>{bookingStatusLabel(trip.booking_status)}</span>
      </div>
      {stops.length > 0 && (
        <div className="trip-detail-row">
          <span>Major stops</span>
          <span>{stops.join(', ')}</span>
        </div>
      )}

      {links.length > 0 && (
        <div className="travel-link-row">
          {links.slice(0, 4).map(l => (
            <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="travel-chip" title={l.blurb}>
              {l.label}
            </a>
          ))}
        </div>
      )}

      <div className="trip-actions">
        <button type="button" className="btn-orange full" onClick={onOpen}>Open Trip</button>
        <button type="button" className="btn-secondary" onClick={onEdit}>Edit</button>
        <button type="button" className="btn-danger" onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}

export default function MainPage() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [trips, setTrips] = useState<Trip[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('list')
  const [draft, setDraft] = useState<Trip | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [peopleByTrip, setPeopleByTrip] = useState<Record<string, TripPerson[]>>({})

  useEffect(() => {
    if (!profile) return
    api.listTrips(profile.id).then(async list => {
      setTrips(list)
      social.listPeopleByTrips(list).then(setPeopleByTrip).catch(() => setPeopleByTrip({}))
      // Backfill destination photos for trips that have a place but no image yet
      for (const t of list) {
        if (t.image_url || !t.place) continue
        const img = await resolveTripImage(t.place, t.place_lat, t.place_lng)
        if (!img) continue
        const updated = { ...t, image_url: img }
        try {
          await api.saveTrip(updated)
          setTrips(prev => prev.map(x => x.id === t.id ? updated : x))
        } catch { /* ignore */ }
      }
    })
  }, [profile])

  const selected = useMemo(() => trips.find(t => t.id === selectedId) ?? null, [trips, selectedId])

  const dateError = useMemo(() => {
    if (!draft?.start_date || !draft?.end_date) return null
    if (draft.end_date < draft.start_date) return 'End date must be on or after the start date.'
    return null
  }, [draft])

  if (!profile) return null

  const selectTrip = (id: string) => {
    setSelectedId(id)
    setMode('detail')
    setDraft(null)
    setSidebarOpen(true)
  }

  const startCreate = () => {
    const t = blankTrip(profile.id)
    setDraft(t)
    setSelectedId(null)
    setMode('create')
    setSidebarOpen(true)
  }

  const startEdit = (trip: Trip) => {
    setDraft({ ...trip, major_stops: [...trip.major_stops] })
    setSelectedId(trip.id)
    setMode('edit')
    setSidebarOpen(true)
  }

  const cancelForm = () => {
    if (selectedId) setMode('detail')
    else setMode('list')
    setDraft(null)
  }

  const saveDraft = async () => {
    if (!draft || dateError) return
    const wasCreate = mode === 'create'
    try {
      await api.saveTrip(draft)
      setTrips(prev => {
        const exists = prev.some(t => t.id === draft.id)
        return exists ? prev.map(t => (t.id === draft.id ? draft : t)) : [...prev, draft]
      })
      const id = draft.id
      setSelectedId(id)
      setDraft(null)
      if (wasCreate) {
        nav(`/trip/${id}`)
        return
      }
      setMode('detail')
    } catch (x: any) {
      alert(`Could not save the trip: ${x.message}`)
    }
  }

  const deleteTrip = async (t: Trip) => {
    if (!window.confirm(`Delete "${t.name || 'Untitled Trip'}" and all of its itinerary items? This cannot be undone.`)) return
    try {
      await api.deleteTrip(t.id)
      setTrips(prev => prev.filter(x => x.id !== t.id))
      if (selectedId === t.id) {
        setSelectedId(null)
        setMode('list')
        setDraft(null)
      }
    } catch (x: any) {
      alert(`Could not delete the trip: ${x.message}`)
    }
  }

  const pins = trips
    .filter(t => t.place_lat != null && t.place_lng != null)
    .map(t => ({
      id: t.id,
      lat: t.place_lat!,
      lng: t.place_lng!,
      label: `<b>${t.name || 'Untitled Trip'}</b><br/>${t.place || 'No destination'}<br/>${formatDateRange(t.start_date, t.end_date)}<br/>${bookingStatusLabel(t.booking_status)}`,
    }))

  const sortedTrips = [...trips].sort((a, b) => a.start_date.localeCompare(b.start_date))

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <button
          type="button"
          className={`sidebar-backdrop${sidebarOpen ? ' visible' : ''}`}
          aria-label="Close trips panel"
          onClick={() => setSidebarOpen(false)}
        />

        <aside className={`trips-sidebar${sidebarOpen ? ' open' : ''}`} aria-label="My Trips">
          <div className="trips-sidebar-header">
            <h2>My Trips</h2>
            <button type="button" className="btn-orange btn-small" onClick={startCreate}>+ New</button>
          </div>
          <div className="trips-sidebar-body">
            {(mode === 'create' || mode === 'edit') && draft && (
              <TripForm
                trip={draft}
                onChange={setDraft}
                onSave={saveDraft}
                onCancel={cancelForm}
                saveLabel={mode === 'create' ? 'Create Trip' : 'Save Changes'}
                dateError={dateError}
              />
            )}

            {mode === 'detail' && selected && (
              <TripDetail
                trip={selected}
                people={peopleByTrip[selected.id] || []}
                onOpen={() => nav(`/trip/${selected.id}`)}
                onEdit={() => startEdit(selected)}
                onDelete={() => deleteTrip(selected)}
              />
            )}

            {trips.length === 0 && mode === 'list' && (
              <div className="empty-state">
                <h3>No trips yet</h3>
                <p>Create your first trip to pin a destination on the map and start planning.</p>
                <button type="button" className="btn-orange" onClick={startCreate}>Create a Trip</button>
              </div>
            )}

            {sortedTrips.length > 0 && (
              <>
                {(mode === 'detail' || mode === 'create' || mode === 'edit') && (
                  <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '4px 0 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    All trips
                  </p>
                )}
                {sortedTrips.map(t => {
                  const duration = tripDurationDays(t.start_date, t.end_date)
                  const isSelected = selectedId === t.id && mode !== 'create'
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`trip-card${isSelected ? ' selected' : ''}`}
                      onClick={() => selectTrip(t.id)}
                      aria-pressed={isSelected}
                    >
                      <div className="trip-card-top">
                        <DestinationThumb place={t.place} name={t.name} lat={t.place_lat} lng={t.place_lng} imageUrl={t.image_url} />
                        <div className="trip-card-meta">
                          <div className="trip-card-name">{t.name || 'Untitled Trip'}</div>
                          <div className="trip-card-place">{t.place || 'No destination set'}</div>
                          <div className="trip-card-dates">
                            {formatDateRange(t.start_date, t.end_date)}
                            {duration ? ` · ${duration}d` : ''}
                          </div>
                        </div>
                      </div>
                      <div className="trip-card-footer">
                        <AvatarStack people={peopleByTrip[t.id] || []} size={26} />
                        <StatusBadge status={t.booking_status} />
                        <span style={{ fontSize: 12, color: 'var(--orange)', fontWeight: 600 }}>View</span>
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </aside>

        <MapView
          pins={pins}
          selectedId={selectedId}
          onPinClick={id => selectTrip(id)}
          showUserLocation
          displayLanguage={profile?.preferred_language || 'en'}
        >
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={sidebarOpen ? 'Hide trips' : 'Show trips'}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(o => !o)}
          >
            {sidebarOpen ? '✕' : '☰'}
          </button>

          <button type="button" className="btn-orange map-create-btn" onClick={startCreate}>
            Create New Trip
          </button>

          {trips.length === 0 && mode !== 'create' && (
            <div className="map-empty-overlay">
              <div className="map-empty-card">
                <h3>Where to next?</h3>
                <p>Explore the map and create a trip when you are ready.</p>
                <button type="button" className="btn-orange" onClick={startCreate}>Create a Trip</button>
              </div>
            </div>
          )}
        </MapView>
      </div>
    </div>
  )
}
