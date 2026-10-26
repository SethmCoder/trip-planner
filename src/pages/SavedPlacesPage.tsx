import { useEffect, useMemo, useState } from 'react'
import TopBar from '../components/TopBar'
import MapView, { type SavePlacePayload } from '../components/MapView'
import { useAuth } from '../context/AuthContext'
import * as api from '../lib/data'
import * as placeLists from '../lib/placeLists'
import type { PlaceList } from '../lib/placeLists'
import { searchPlaces, type GeoResult } from '../lib/geocoding'
import { placePrimary, placeSecondary, shortAddress } from '../lib/formatPlace'
import TranslatedText from '../components/TranslatedText'
import { emojiForKind, poiMeta } from '../lib/pois'
import { googleMapsUrl } from '../lib/maps'
import { isGoogleMapsEnabled } from '../lib/googleConfig'
import { newId, type SavedPlace } from '../lib/types'
import * as social from '../lib/social'
import type { Friendship } from '../lib/types'

export default function SavedPlacesPage() {
  const { profile, setProfile } = useAuth()
  const [places, setPlaces] = useState<SavedPlace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<GeoResult[]>([])
  const [searching, setSearching] = useState(false)
  const [msg, setMsg] = useState('')
  const [lists, setLists] = useState<PlaceList[]>([])
  const [sharedLists, setSharedLists] = useState<PlaceList[]>([])
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [newListName, setNewListName] = useState('')
  const [friends, setFriends] = useState<Friendship[]>([])
  const [shareFriendId, setShareFriendId] = useState('')
  const [sharedListPlaces, setSharedListPlaces] = useState<SavedPlace[]>([])
  const googleOn = isGoogleMapsEnabled()

  const reloadLists = async () => {
    if (!profile) return
    setLists(await placeLists.listPlaceLists(profile.id))
    setSharedLists(await placeLists.listSharedWithMe(profile.id))
  }

  useEffect(() => {
    if (!profile) return
    api.listSavedPlaces(profile.id).then(setPlaces)
    reloadLists().catch(() => {})
    social.listAcceptedFriends(profile.id).then(setFriends).catch(() => {})
  }, [profile])

  const activeList = [...lists, ...sharedLists].find(l => l.id === activeListId) || null
  const activePlaceIds = new Set(activeList?.place_ids || [])

  useEffect(() => {
    if (!profile || !activeList?.shared) {
      setSharedListPlaces([])
      return
    }
    placeLists.placesForList(activeList, profile.id).then(setSharedListPlaces).catch(() => setSharedListPlaces([]))
  }, [profile?.id, activeListId, activeList?.shared, activeList?.place_ids?.join(',')])

  const displayPlaces = activeList?.shared ? sharedListPlaces : places

  const mapPlaces = useMemo(() => {
    if (!activeList) return places
    if (activeList.shared) return sharedListPlaces
    return places.filter(p => activePlaceIds.has(p.id))
  }, [places, sharedListPlaces, activeList, activePlaceIds])

  const pins = useMemo(() => mapPlaces.map(p => ({
    id: p.id,
    lat: p.lat,
    lng: p.lng,
    name: p.name,
    kind: p.category,
    savable: false,
    label: `<div class="map-popup"><div class="map-popup-title">${emojiForKind(p.category)} <b>${p.name}</b></div><div class="map-popup-cat">${poiMeta(p.category).title}</div><div class="map-popup-actions"><a class="map-popup-link" href="${googleMapsUrl({ lat: p.lat, lng: p.lng, name: p.name })}" target="_blank" rel="noreferrer">Open in Google Maps</a></div></div>`,
  })), [mapPlaces])

  if (!profile) return null

  const persist = async (payload: SavePlacePayload) => {
    const exists = places.some(p =>
      Math.abs(p.lat - payload.lat) < 0.0002 && Math.abs(p.lng - payload.lng) < 0.0002,
    )
    if (exists) {
      setMsg('Already in your saved places')
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
      if (activeList && !activeList.shared) {
        await placeLists.addPlaceToList(activeList.id, place.id)
        await reloadLists()
      }
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

  const createList = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newListName.trim()) return
    const list = await placeLists.createPlaceList(profile.id, newListName.trim())
    setNewListName('')
    setActiveListId(list.id)
    setMsg(`Created list “${list.name}”`)
    await reloadLists()
  }

  const toggleInList = async (placeId: string) => {
    if (!activeList || activeList.shared) return
    if (activePlaceIds.has(placeId)) {
      await placeLists.removePlaceFromList(activeList.id, placeId)
    } else {
      await placeLists.addPlaceToList(activeList.id, placeId)
    }
    await reloadLists()
  }

  const shareList = async () => {
    if (!activeList || !shareFriendId || activeList.shared) return
    await placeLists.sharePlaceList(activeList.id, profile.id, shareFriendId)
    setMsg(`Shared “${activeList.name}” with friend`)
    setShareFriendId('')
  }

  const friendUserId = (f: Friendship) => (f.requester_id === profile.id ? f.addressee_id : f.requester_id)

  return (
    <div className="app-shell saved-places-page">
      <TopBar />
      <div className="saved-body">
        <aside className="saved-sidebar" aria-label="Saved places">
          <div className="saved-sidebar-header">
            <h2>Saved Places</h2>
            <p>
              Save places and group them into named lists (e.g. mylist1). Share a whole list with friends.
              {googleOn
                ? ' Search uses Google Places (API key detected).'
                : ' Search uses OpenStreetMap until VITE_GOOGLE_MAPS_API_KEY is set.'}
            </p>
          </div>

          {googleOn && (
            <div className="panel" style={{ margin: '0 0 12px', padding: 12 }}>
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

          <section className="place-lists-panel">
            <h3>Lists</h3>
            <form onSubmit={createList} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input value={newListName} onChange={e => setNewListName(e.target.value)} placeholder="e.g. mylist1" aria-label="New list name" />
              <button type="submit" className="btn-orange">Create</button>
            </form>
            <div className="place-list-chips">
              <button type="button" className={!activeListId ? 'chip active' : 'chip'} onClick={() => setActiveListId(null)}>
                All places
              </button>
              {lists.map(l => (
                <button
                  key={l.id}
                  type="button"
                  className={activeListId === l.id ? 'chip active' : 'chip'}
                  onClick={() => setActiveListId(l.id)}
                >
                  {l.name} ({l.place_ids?.length || 0})
                </button>
              ))}
              {sharedLists.map(l => (
                <button
                  key={l.id}
                  type="button"
                  className={activeListId === l.id ? 'chip active' : 'chip'}
                  onClick={() => setActiveListId(l.id)}
                  title="Shared with you"
                >
                  {l.name} · shared
                </button>
              ))}
            </div>
            {activeList && !activeList.shared && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <label>Share list with friend</label>
                  <select value={shareFriendId} onChange={e => setShareFriendId(e.target.value)}>
                    <option value="">Select friend</option>
                    {friends.map(f => (
                      <option key={f.id} value={friendUserId(f)}>{f.other_username}</option>
                    ))}
                  </select>
                </div>
                <button type="button" className="btn-ghost" onClick={shareList} disabled={!shareFriendId}>Share list</button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={async () => {
                    if (!window.confirm(`Delete list “${activeList.name}”? Places stay saved.`)) return
                    await placeLists.deletePlaceList(activeList.id)
                    setActiveListId(null)
                    await reloadLists()
                  }}
                >
                  Delete list
                </button>
              </div>
            )}
          </section>

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
            {displayPlaces
              .filter(p => {
                if (!activeList) return true
                if (activeList.shared) return true
                return true // own list: show all so you can add/remove
              })
              .map(p => {
                const inActive = activePlaceIds.has(p.id)
                const meta = poiMeta(p.category)
                const active = selectedId === p.id
                return (
                  <div key={p.id} className={`saved-card${active ? ' selected' : ''}${activeList && !inActive ? ' dimmed' : ''}`}>
                    <button type="button" className="saved-card-hit" onClick={() => setSelectedId(p.id)}>
                      <span className="saved-card-emoji" aria-hidden>{emojiForKind(p.category)}</span>
                      <span className="saved-card-main">
                        <TranslatedText text={p.name} className="saved-card-name" />
                        <span className="saved-card-meta">{meta.title} · {shortAddress(p.place_name)}</span>
                      </span>
                    </button>
                    <span className="saved-card-links">
                      {activeList && !activeList.shared && (
                        <button type="button" className="btn-ghost" style={{ padding: '4px 8px', height: 'auto' }} onClick={() => toggleInList(p.id)}>
                          {inActive ? 'Remove from list' : 'Add to list'}
                        </button>
                      )}
                      <a href={googleMapsUrl({ lat: p.lat, lng: p.lng, name: p.name })} target="_blank" rel="noreferrer">Maps</a>
                      {!activeList?.shared && (
                        <button type="button" className="link-danger" onClick={() => remove(p)}>Remove</button>
                      )}
                    </span>
                  </div>
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
