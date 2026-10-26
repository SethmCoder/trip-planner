import { useEffect, useMemo, useState } from 'react'
import TopBar from '../components/TopBar'
import MapView, { type SavePlacePayload } from '../components/MapView'
import { useAuth } from '../context/AuthContext'
import * as api from '../lib/data'
import { searchPlaces, type GeoResult } from '../lib/geocoding'
import { placePrimary, placeSecondary, shortAddress } from '../lib/formatPlace'
import TranslatedText from '../components/TranslatedText'
import { emojiForKind, poiMeta } from '../lib/pois'
import { googleMapsUrl } from '../lib/maps'
import { isGoogleMapsEnabled } from '../lib/googleConfig'
import { newId, type SavedPlace } from '../lib/types'

export default function SavedPlacesPage() {
  const { profile, setProfile } = useAuth()
  const [places, setPlaces] = useState<SavedPlace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<GeoResult[]>([])
  const [searching, setSearching] = useState(false)
  const [msg, setMsg] = useState('')
  const googleOn = isGoogleMapsEnabled()

  useEffect(() => {
    if (!profile) return
    api.listSavedPlaces(profile.id).then(setPlaces)
  }, [profile])

  const pins = useMemo(() => places.map(p => ({
    id: p.id,
    lat: p.lat,
    lng: p.lng,
    name: p.name,
    kind: p.category,
    savable: false,
    label: `<div class="map-popup"><div class="map-popup-title">${emojiForKind(p.category)} <b>${p.name}</b></div><div class="map-popup-cat">${poiMeta(p.category).title}</div><div class="map-popup-actions"><a class="map-popup-link" href="${googleMapsUrl({ lat: p.lat, lng: p.lng, name: p.name })}" target="_blank" rel="noreferrer">Open in Google Maps</a></div></div>`,
  })), [places])

  if (!profile) return null

  const persist = async (payload: SavePlacePayload) => {
    const exists = places.some(p =>
      Math.abs(p.lat - payload.lat) < 0.0002 && Math.abs(p.lng - payload.lng) < 0.0002,
    )
    if (exists) {
      setMsg('Already in your saved list')
      return
    }
    const place: SavedPlace = {
      id: newId(),
      user_id: profile.id,
      name: payload.name,
      place_name: payload.place_name || payload.name,
      lat: payload.lat,
      lng: payload.lng,
      category: payload.category || 'other',
      created_at: new Date().toISOString(),
    }
    try {
      await api.saveSavedPlace(place)
      setPlaces(prev => [place, ...prev])
      setSelectedId(place.id)
      setMsg(`Saved “${place.name}”`)
    } catch (e: any) {
      alert(`Could not save place: ${e.message}`)
    }
  }

  const remove = async (p: SavedPlace) => {
    if (!window.confirm(`Remove “${p.name}” from saved places?`)) return
    await api.deleteSavedPlace(p.id)
    setPlaces(prev => prev.filter(x => x.id !== p.id))
    if (selectedId === p.id) setSelectedId(null)
  }

  const onSearch = async (value: string) => {
    setQ(value)
    if (value.length < 2) { setResults([]); return }
    setSearching(true)
    setResults(await searchPlaces(value))
    setSearching(false)
  }

  const addFromSearch = async (r: GeoResult) => {
    const name = placePrimary(r.name) || r.name
    const detail = r.detail || placeSecondary(r.display) || shortAddress(r.display, 2)
    await persist({
      name,
      place_name: detail ? `${name}, ${detail}` : name,
      lat: r.lat,
      lng: r.lng,
      category: 'other',
    })
    setQ('')
    setResults([])
  }

  return (
    <div className="app-shell saved-places-page">
      <TopBar />
      <div className="saved-body">
        <aside className="saved-sidebar" aria-label="Saved places">
          <div className="saved-sidebar-header">
            <h2>Saved Places</h2>
            <p>
              Search a place or save pins from trip maps. Open any place in Google Maps.
              {googleOn
                ? ' Search uses Google Places (API key detected).'
                : ' Search uses OpenStreetMap until VITE_GOOGLE_MAPS_API_KEY is set.'}
            </p>
          </div>

          {googleOn && profile && (
            <div className="panel" style={{ margin: '0 0 12px', padding: 12 }}>
              <p className="places-hint" style={{ marginTop: 0 }}>
                Optional: mark Google account connected for Saved Places import workflows (OAuth tokens stay server-side).
              </p>
              <button
                type="button"
                className="btn-ghost"
                onClick={async () => {
                  const next = await api.updateProfile(profile, { google_places_connected: !profile.google_places_connected })
                  setProfile(next)
                  setMsg(next.google_places_connected ? 'Google marked connected' : 'Google disconnected')
                }}
              >
                {profile.google_places_connected ? 'Disconnect Google' : 'Connect Google account'}
              </button>
            </div>
          )}

          <div className="saved-search">
            <label htmlFor="saved-search-input">Add by search</label>
            <input
              id="saved-search-input"
              value={q}
              onChange={e => onSearch(e.target.value)}
              placeholder="Type a short place name…"
              autoComplete="off"
            />
            {searching && <p className="places-hint">Searching…</p>}
            {results.length > 0 && (
              <div className="autocomplete" role="listbox">
                {results.map((r, i) => {
                  const primary = placePrimary(r.name) || r.name
                  const secondary = r.detail || placeSecondary(r.display)
                  return (
                    <button key={`${r.lat}-${r.lng}-${i}`} type="button" role="option" onClick={() => addFromSearch(r)}>
                      <span className="ac-name">{primary}</span>
                      {secondary && <span className="ac-detail">{secondary}</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {msg && <p className="saved-toast">{msg}</p>}

          <div className="saved-list">
            {places.length === 0 && (
              <div className="places-empty">
                <h4>No saved places yet</h4>
                <p>Search above, or tap “Add to saved list” on a map pin or trip card.</p>
              </div>
            )}
            {places.map(p => {
              const active = selectedId === p.id
              const meta = poiMeta(p.category)
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`saved-card${active ? ' selected' : ''}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className="saved-card-emoji" aria-hidden>{emojiForKind(p.category)}</span>
                  <span className="saved-card-main">
                    <TranslatedText text={p.name} className="saved-card-name" />
                    <span className="saved-card-meta">{meta.title} · {shortAddress(p.place_name)}</span>
                    <span className="saved-card-links">
                      <a
                        href={googleMapsUrl({ lat: p.lat, lng: p.lng, name: p.name })}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                      >
                        Google Maps
                      </a>
                      <button
                        type="button"
                        className="link-danger"
                        onClick={e => { e.stopPropagation(); remove(p) }}
                      >
                        Remove
                      </button>
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        <MapView
          pins={pins}
          selectedId={selectedId}
          onPinClick={id => setSelectedId(id)}
          showUserLocation
          enableNearbyPois
          displayLanguage={profile.preferred_language || 'en'}
          onSavePlace={persist}
        />
      </div>
    </div>
  )
}
