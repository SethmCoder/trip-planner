import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import TopBar from '../components/TopBar'
import MapView, { type SavePlacePayload } from '../components/MapView'
import { googleMapsUrl } from '../lib/maps'
import MajorStopsInput from '../components/MajorStopsInput'
import TransitTimeInput from '../components/TransitTimeInput'
import { useAuth } from '../context/AuthContext'
import * as api from '../lib/data'
import { searchPlaces, type GeoResult } from '../lib/geocoding'
import { bookingLink, discoveryLinks } from '../lib/bookingLinks'
import { newId, fmtDate, type Trip, type ItineraryItem, type SavedPlace, type ItinerarySuggestion } from '../lib/types'
import { listSuggestions, requestSuggestStops, updateSuggestionStatus } from '../lib/aiClient'
import { canUseAiSuggest, isAdvancedEnabled } from '../lib/advanced'
import { calculateTransitMinutes, formatTransitTime, isFlight, addMinutes, getQuickestRoute, estimateGapTravel, formatCompactDuration, haversineKm, type LatLng, type GapTravel } from '../lib/routing'
import { buildPinPopup, categoryFromItemType, emojiForKind, fetchExperiences, fetchHotelsNearby, poiMeta, type MapPoi } from '../lib/pois'
import { resolvePlaceImage, resolveTripImage } from '../lib/tripImages'
import { destinationTravelLinks, poiTravelLinks } from '../lib/travelApps'
import { shortAddress, placePrimary, placeSecondary, hotelStayTitle, hotelPhase } from '../lib/formatPlace'
import { dayColor, TRANSIT_MODES, GAP_MODES } from '../lib/transportModes'
import { lookupFlights, type FlightOption } from '../lib/flights'
import { isImageFile, ocrFlightScreenshot, type ParsedFlightScreenshot } from '../lib/flightScreenshot'
import { airportByIata, type AirportRef } from '../lib/airports'
import DestinationThumb from '../components/DestinationThumb'
import TranslatedText from '../components/TranslatedText'

function geoFromAirport(a: AirportRef): GeoResult {
  const label = `${a.city || a.name} (${a.iata})`
  return {
    name: label,
    display: `${a.name}, ${a.city}`,
    detail: a.name,
    lat: a.lat,
    lng: a.lng,
  }
}

const STAY_COLORS = ['#2563EB', '#7C3AED', '#0891B2', '#DB2777', '#059669', '#D97706']

function compactGeo(r: GeoResult): GeoResult {
  const name = placePrimary(r.name) || shortAddress(r.name, 1) || r.name
  const detail = r.detail || placeSecondary(r.display) || shortAddress(r.display, 2)
  return { ...r, name, display: detail ? `${name}, ${detail}` : name, detail }
}

function categoryMeta(it: ItineraryItem) {
  if (it.type === 'transit') return { label: 'Transit', color: '#F97316', icon: '🚅' }
  if (it.type === 'hotel') return { label: it.subtype === 'checkout' ? 'Hotel · Check-out' : it.subtype === 'checkin' ? 'Hotel · Check-in' : 'Hotel', color: '#2563EB', icon: '🛏️' }
  if (it.type === 'restaurant') return { label: 'Restaurant', color: '#DC2626', icon: '🍽️' }
  return { label: 'Experience', color: '#0D9488', icon: '🗿' }
}

function ItemThumb({ it, onResolved }: { it: ItineraryItem; onResolved?: (url: string) => void }) {
  const meta = categoryMeta(it)
  const [src, setSrc] = useState<string | null>(it.image_url || null)
  const [failed, setFailed] = useState(false)
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  useEffect(() => {
    setSrc(it.image_url || null)
    setFailed(false)
  }, [it.id, it.image_url])

  useEffect(() => {
    if (it.image_url || failed) return
    let cancelled = false
    const query = it.type === 'transit'
      ? (it.to_name || it.title)
      : (hotelStayTitle(it.title) || it.place_name || it.title)
    resolvePlaceImage(query, it.lat, it.lng).then(url => {
      if (cancelled || !url) return
      setSrc(url)
      onResolvedRef.current?.(url)
    })
    return () => { cancelled = true }
  }, [it.id, it.image_url, it.title, it.place_name, it.to_name, it.type, it.lat, it.lng, failed])

  return (
    <div className="item-thumb" style={{ background: meta.color }} aria-hidden>
      {src && !failed
        ? <img src={src} alt="" onError={() => setFailed(true)} />
        : <span className="item-thumb-icon">{meta.icon}</span>}
    </div>
  )
}

const baseItem = (trip: Trip, userId: string, order: number): ItineraryItem => ({
  id: newId(), trip_id: trip.id, user_id: userId, type: 'activity', group_id: null, title: '', place_name: '',
  lat: trip.place_lat, lng: trip.place_lng, from_name: '', from_lat: null, from_lng: null, to_name: '', to_lat: null, to_lng: null,
  start_at: `${trip.start_date}T09:00`, end_at: `${trip.start_date}T10:00`, duration_minutes: 60, mode_of_transport: '',
  booking_status: 'not_booked', booking_open_date: '', book_by_date: '', image_url: '', sort_order: order, created_at: new Date().toISOString(),
})

function PlaceSearch({
  label,
  onPick,
  near,
  placeholder = 'Type a short place name…',
  onHover,
  value = null,
}: {
  label: string
  onPick: (r: GeoResult) => void
  near?: { lat: number; lng: number } | null
  placeholder?: string
  onHover?: (r: GeoResult | null) => void
  /** Controlled selection (e.g. filled from a flight screenshot). */
  value?: GeoResult | null
}) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<GeoResult[]>([])
  const [picked, setPicked] = useState('')
  const [searching, setSearching] = useState(false)

  // Keep the input in sync when parent sets From/To (screenshot OCR, flight estimate, etc.)
  useEffect(() => {
    if (value?.name) {
      setPicked(value.name)
      setQ('')
      setRes([])
    } else if (value === null) {
      // only clear when explicitly nullled — ignore undefined for uncontrolled uses
    }
  }, [value?.name, value?.lat, value?.lng])

  useEffect(() => {
    if (picked || q.trim().length < 2) {
      setRes([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(async () => {
      const list = await searchPlaces(q, { near })
      if (cancelled) return
      setRes(list)
      setSearching(false)
    }, 280)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [q, picked, near?.lat, near?.lng])

  return (
    <div className="place-search">
      <label>{label}</label>
      <input
        value={picked || q}
        onChange={e => {
          setPicked('')
          setQ(e.target.value)
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {searching && <p className="places-hint">Searching…</p>}
      {res.length > 0 && (
        <div className="autocomplete" role="listbox">
          {res.map((r, i) => {
            const primary = placePrimary(r.name) || r.name
            const secondary = r.detail || placeSecondary(r.display) || shortAddress(r.display, 2)
            return (
              <button
                key={`${r.lat}-${r.lng}-${i}`}
                type="button"
                role="option"
                onMouseEnter={() => onHover?.(r)}
                onMouseLeave={() => onHover?.(null)}
                onFocus={() => onHover?.(r)}
                onBlur={() => onHover?.(null)}
                onClick={() => {
                  const c = compactGeo(r)
                  onPick(c)
                  setPicked(c.name)
                  setRes([])
                  onHover?.(null)
                }}
              >
                <span className="ac-name">{primary}</span>
                {secondary && <span className="ac-detail">{secondary}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function TripPage() {
  const { id } = useParams()
  const { profile } = useAuth()
  const nav = useNavigate()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [items, setItems] = useState<ItineraryItem[]>([])
  const [divide, setDivide] = useState(true)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [dayRoutePaths, setDayRoutePaths] = useState<Record<string, LatLng[]>>({})
  const [dragId, setDragId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [from, setFrom] = useState<GeoResult | null>(null)
  const [to, setTo] = useState<GeoResult | null>(null)
  const [mode, setMode] = useState('Airplane')
  const [tStart, setTStart] = useState('')
  const [tEnd, setTEnd] = useState('')
  const [flightOptions, setFlightOptions] = useState<FlightOption[]>([])
  const [flightStatus, setFlightStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')
  const [flightMsg, setFlightMsg] = useState('')
  const [flightLink, setFlightLink] = useState('')
  const [shotStatus, setShotStatus] = useState<'idle' | 'reading' | 'done' | 'error'>('idle')
  const [shotMsg, setShotMsg] = useState('')
  const [shotDragging, setShotDragging] = useState(false)
  const shotInputRef = useRef<HTMLInputElement>(null)
  const [gapModes, setGapModes] = useState<Record<string, string>>({})
  const [hotel, setHotel] = useState<GeoResult | null>(null)
  const [hIn, setHIn] = useState('')
  const [hOut, setHOut] = useState('')
  const [stayKind, setStayKind] = useState<'hotel' | 'airbnb'>('hotel')
  const [airbnbAddress, setAirbnbAddress] = useState('')
  const [hotelPicks, setHotelPicks] = useState<MapPoi[]>([])
  const [hotelListStatus, setHotelListStatus] = useState<'idle' | 'loading' | 'ready' | 'empty'>('idle')
  const [hotelPreview, setHotelPreview] = useState<{ id?: string; lat: number; lng: number; name: string } | null>(null)
  const [expPicks, setExpPicks] = useState<MapPoi[]>([])
  const [expPickStatus, setExpPickStatus] = useState<'idle' | 'loading' | 'ready' | 'empty'>('idle')
  const [expTime, setExpTime] = useState('')
  const [expFilter, setExpFilter] = useState('')
  const [expSelected, setExpSelected] = useState<GeoResult | null>(null)
  const [act, setAct] = useState<GeoResult | null>(null)
  const [aTime, setATime] = useState('')
  const [rest, setRest] = useState<GeoResult | null>(null)
  const [rTime, setRTime] = useState('')
  const [mobilePanel, setMobilePanel] = useState<'create' | 'map' | 'places'>('map')
  const [rightTab, setRightTab] = useState<'places' | 'experiences'>('places')
  const [experiences, setExperiences] = useState<MapPoi[]>([])
  const [expStatus, setExpStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'need-place'>('idle')
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([])
  const [saveMsg, setSaveMsg] = useState('')
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string[]>([])
  const [aiSuggestions, setAiSuggestions] = useState<ItinerarySuggestion[]>([])
  const [aiSuggestLoading, setAiSuggestLoading] = useState(false)
  const [aiSuggestErr, setAiSuggestErr] = useState('')
  const [aiOrgNote, setAiOrgNote] = useState('')

  useEffect(() => {
    if (id) {
      listSuggestions(id).then(setAiSuggestions).catch(() => {})
      api.getTrip(id).then(async t => {
        setTrip(t)
        if (t) {
          setTStart(`${t.start_date}T09:00`)
          setTEnd(`${t.start_date}T11:00`)
          setHIn(`${t.start_date}T15:00`)
          setHOut(`${t.end_date}T11:00`)
          setATime(`${t.start_date}T10:00`)
          setRTime(`${t.start_date}T19:00`)
          setExpTime(`${t.start_date}T11:00`)
          if (t.place && !t.image_url) {
            const img = await resolveTripImage(t.place, t.place_lat, t.place_lng)
            if (img) {
              const updated = { ...t, image_url: img }
              setTrip(updated)
              try { await api.saveTrip(updated) } catch { /* schema may lack image_url */ }
            }
          }
        }
      })
      api.listItems(id).then(setItems)
    }
  }, [id])

  useEffect(() => {
    if (!profile) return
    api.listSavedPlaces(profile.id).then(setSavedPlaces).catch(() => setSavedPlaces([]))
  }, [profile])

  // Nearby hotels & experiences for the Create Items lists (OSM / deep-linked apps)
  useEffect(() => {
    if (!trip?.place_lat || !trip?.place_lng) {
      setHotelPicks([]); setHotelListStatus('idle')
      setExpPicks([]); setExpPickStatus('idle')
      return
    }
    let cancelled = false
    const pad = 0.08
    const bounds = {
      south: trip.place_lat - pad, west: trip.place_lng - pad,
      north: trip.place_lat + pad, east: trip.place_lng + pad,
    }
    setHotelListStatus('loading')
    setExpPickStatus('loading')
    fetchHotelsNearby(bounds, trip.place).then(list => {
      if (cancelled) return
      setHotelPicks(list)
      setHotelListStatus(list.length ? 'ready' : 'empty')
    })
    fetchExperiences(bounds, trip.place).then(list => {
      if (cancelled) return
      setExpPicks(list)
      setExpPickStatus(list.length ? 'ready' : 'empty')
    })
    return () => { cancelled = true }
  }, [trip?.place_lat, trip?.place_lng, trip?.place])

  const days = useMemo(() => {
    const out: string[] = []
    if (!trip) return out
    if (trip.start_date && trip.end_date) {
      const d = new Date(trip.start_date + 'T12:00:00')
      const end = new Date(trip.end_date + 'T12:00:00')
      while (d <= end && out.length < 60) {
        out.push(d.toISOString().slice(0, 10))
        d.setDate(d.getDate() + 1)
      }
    }
    return out.length ? out : [trip.start_date]
  }, [trip])

  const [routePaths, setRoutePaths] = useState<Record<string, LatLng[]>>({})
  const transitSignature = items.filter(i => i.type === 'transit' && i.from_lat != null && i.to_lat != null).map(i => `${i.id}:${i.from_lat},${i.from_lng}->${i.to_lat},${i.to_lng}:${i.mode_of_transport}`).join('|')
  useEffect(() => {
    let cancelled = false
    const legs = items.filter(i => i.type === 'transit' && i.from_lat != null && i.from_lng != null && i.to_lat != null && i.to_lng != null)
    legs.forEach(async leg => {
      const route = await getQuickestRoute({ lat: leg.from_lat!, lng: leg.from_lng! }, { lat: leg.to_lat!, lng: leg.to_lng! }, leg.mode_of_transport)
      if (!cancelled && route && route.path.length > 1) setRoutePaths(prev => ({ ...prev, [leg.id]: route.path }))
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitSignature])

  const [gapInfo, setGapInfo] = useState<Record<string, GapTravel>>({})
  const sortedForGaps = [...items].sort((a, b) => a.sort_order - b.sort_order)
  const gapPairs: [ItineraryItem, ItineraryItem][] = []
  for (let i = 0; i < sortedForGaps.length - 1; i++) {
    const a = sortedForGaps[i], b = sortedForGaps[i + 1]
    if (a.type !== 'transit' && b.type !== 'transit' && a.lat != null && a.lng != null && b.lat != null && b.lng != null) gapPairs.push([a, b])
  }
  const gapSignature = gapPairs.map(([a, b]) => `${a.id}:${a.lat},${a.lng}->${b.id}:${b.lat},${b.lng}:${gapModes[`${a.id}->${b.id}`] || ''}`).join('|')
  useEffect(() => {
    let cancelled = false
    gapPairs.forEach(async ([a, b]) => {
      const key = `${a.id}->${b.id}`
      const est = await estimateGapTravel(
        { lat: a.lat!, lng: a.lng! },
        { lat: b.lat!, lng: b.lng! },
        gapModes[key] || null,
      )
      if (!cancelled) setGapInfo(prev => ({ ...prev, [key]: est }))
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gapSignature])

  useEffect(() => {
    if (rightTab !== 'experiences' || !trip?.place_lat || !trip?.place_lng) {
      if (rightTab === 'experiences' && trip && (trip.place_lat == null || trip.place_lng == null)) setExpStatus('need-place')
      return
    }
    let cancelled = false
    setExpStatus('loading')
    const pad = 0.12
    fetchExperiences({
      south: trip.place_lat - pad,
      west: trip.place_lng - pad,
      north: trip.place_lat + pad,
      east: trip.place_lng + pad,
    }, trip.place).then(list => {
      if (cancelled) return
      setExperiences(list)
      setExpStatus(list.length ? 'ready' : 'empty')
    })
    return () => { cancelled = true }
  }, [rightTab, trip?.place_lat, trip?.place_lng, trip?.place])

  // Routes for one day or all days (multi-color when All days is selected)
  const dayRouteSignature = useMemo(() => {
    const daysToRoute = selectedDay
      ? [selectedDay]
      : [...new Set(items.map(i => i.start_at.slice(0, 10)).filter(Boolean))].sort()
    return daysToRoute.map(day => {
      const stops = items
        .filter(i => i.start_at.slice(0, 10) === day && i.lat != null && i.lng != null)
        .sort((a, b) => a.sort_order - b.sort_order || a.start_at.localeCompare(b.start_at))
      const gapPart = stops.slice(0, -1).map((a, i) => {
        const b = stops[i + 1]
        const key = `${a.id}->${b.id}`
        return `${key}:${gapModes[key] || ''}`
      }).join(',')
      return `${day}:${stops.map(i => `${i.id}:${i.lat},${i.lng}`).join('|')}:${gapPart}`
    }).join('||')
  }, [selectedDay, items, gapModes])

  useEffect(() => {
    if (!dayRouteSignature) {
      setDayRoutePaths({})
      return
    }
    let cancelled = false
    const daysToRoute = selectedDay
      ? [selectedDay]
      : [...new Set(items.map(i => i.start_at.slice(0, 10)).filter(Boolean))].sort()
    ;(async () => {
      const paths: Record<string, LatLng[]> = {}
      for (const day of daysToRoute) {
        const stops = items
          .filter(i => i.start_at.slice(0, 10) === day && i.lat != null && i.lng != null)
          .sort((a, b) => a.sort_order - b.sort_order || a.start_at.localeCompare(b.start_at))
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i], b = stops[i + 1]
          const key = `${a.id}->${b.id}`
          const mode = gapModes[key]
            || (a.type === 'transit' ? (a.mode_of_transport || 'Driving') : 'Walking')
          try {
            const route = await getQuickestRoute(
              { lat: a.lat!, lng: a.lng! },
              { lat: b.lat!, lng: b.lng! },
              mode,
            )
            paths[key] = route?.path?.length ? route.path : [{ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! }]
          } catch {
            paths[key] = [{ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! }]
          }
        }
      }
      if (!cancelled) setDayRoutePaths(paths)
    })()
    return () => { cancelled = true }
  }, [dayRouteSignature, selectedDay, items, gapModes])

  /** Saved places near booked flights/hotels that are not already on this trip. */
  const savedPlaceSuggestions = useMemo(() => {
    type Anchor = { lat: number; lng: number; label: string; when: string }
    const anchors: Anchor[] = []
    for (const it of items) {
      const booked = it.booking_status === 'booked' || it.booking_status === 'partially_booked'
      if (!booked) continue
      if (it.type === 'hotel' && it.lat != null && it.lng != null) {
        anchors.push({
          lat: it.lat,
          lng: it.lng,
          label: `booked stay · ${hotelStayTitle(it.title) || it.place_name || 'Hotel'}`,
          when: it.start_at,
        })
      }
      if (it.type === 'transit' && isFlight(it.mode_of_transport)) {
        if (it.to_lat != null && it.to_lng != null) {
          anchors.push({
            lat: it.to_lat,
            lng: it.to_lng,
            label: `flight arrival · ${placePrimary(it.to_name) || 'destination'}`,
            when: it.end_at || it.start_at,
          })
        }
        if (it.from_lat != null && it.from_lng != null) {
          anchors.push({
            lat: it.from_lat,
            lng: it.from_lng,
            label: `flight departure · ${placePrimary(it.from_name) || 'origin'}`,
            when: it.start_at,
          })
        }
      }
    }
    if (anchors.length === 0 || savedPlaces.length === 0) return []

    const onTrip = (place: SavedPlace) => items.some(it => {
      if (it.lat == null || it.lng == null) return false
      if (haversineKm({ lat: it.lat, lng: it.lng }, { lat: place.lat, lng: place.lng }) < 0.35) return true
      const a = (it.title || '').toLowerCase()
      const b = (place.name || '').toLowerCase()
      return !!b && (a.includes(b) || b.includes(hotelStayTitle(it.title).toLowerCase()))
    })

    const NEAR_KM = 35
    const out: { place: SavedPlace; reason: string; when: string; km: number }[] = []
    const seen = new Set<string>()

    for (const place of savedPlaces) {
      if (dismissedSuggestions.includes(place.id) || seen.has(place.id) || onTrip(place)) continue
      let best: { reason: string; when: string; km: number } | null = null
      for (const anchor of anchors) {
        const km = haversineKm({ lat: place.lat, lng: place.lng }, { lat: anchor.lat, lng: anchor.lng })
        if (km > NEAR_KM) continue
        if (!best || km < best.km) best = { reason: `Near your ${anchor.label}`, when: anchor.when, km }
      }
      if (!best) continue
      seen.add(place.id)
      out.push({ place, ...best })
    }

    return out.sort((a, b) => a.km - b.km).slice(0, 6)
  }, [items, savedPlaces, dismissedSuggestions])

  const filteredExpPicks = useMemo(() => {
    const q = expFilter.trim().toLowerCase()
    if (!q) return expPicks
    return expPicks.filter(p =>
      p.name.toLowerCase().includes(q) ||
      poiMeta(p.category).title.toLowerCase().includes(q),
    )
  }, [expPicks, expFilter])

  if (!profile) return null
  if (!trip) {
    return (
      <div className="app-shell">
        <TopBar />
        <p style={{ padding: 24 }}>Loading trip… <button className="btn-secondary btn-small" onClick={() => nav('/')}>Back</button></p>
      </div>
    )
  }

  const saveT = async (t: Trip) => { setTrip(t); await api.saveTrip(t) }
  const deleteThisTrip = async () => {
    if (!window.confirm(`Delete "${trip.name || 'Untitled Trip'}" and all of its itinerary items? This cannot be undone.`)) return
    try { await api.deleteTrip(trip.id); nav('/') } catch (x: any) { alert(`Could not delete the trip: ${x.message}`) }
  }
  const addItems = async (news: ItineraryItem[]) => {
    const seeded = await Promise.all(news.map(async it => {
      if (it.image_url) return it
      const query = it.type === 'transit' ? (it.to_name || it.title) : (hotelStayTitle(it.title) || it.place_name || it.title)
      const image_url = (await resolvePlaceImage(query, it.lat, it.lng)) || ''
      return { ...it, image_url }
    }))
    const all = [...items, ...seeded]
    setItems(all)
    if (seeded[0]) setExpandedId(seeded[0].id)
    await api.saveItems(seeded)
  }

  const persistThumb = async (it: ItineraryItem, url: string) => {
    if (it.image_url === url) return
    const updated = { ...it, image_url: url }
    setItems(prev => prev.map(x => x.id === it.id ? updated : x))
    try { await api.saveItem(updated) } catch { /* ignore */ }
  }
  const update = async (it: ItineraryItem) => {
    let all = items.map(x => x.id === it.id ? it : x)
    if (it.type === 'hotel' && it.group_id) {
      all = all.map(x => x.group_id === it.group_id && x.id !== it.id ? { ...x, title: it.title, place_name: it.place_name, booking_status: it.booking_status } : x)
    }
    setItems(all)
    await api.saveItems(all.filter(x => x.id === it.id || x.group_id === it.group_id))
  }
  const remove = async (it: ItineraryItem) => { setItems(items.filter(x => x.id !== it.id)); await api.deleteItem(it.id) }
  const applyFlightScreenshot = (parsed: ParsedFlightScreenshot) => {
    setMode('Airplane')
    setFlightOptions([])
    setFlightStatus('idle')
    const dep = parsed.depAirport || airportByIata(parsed.depIata)
    const arr = parsed.arrAirport || airportByIata(parsed.arrIata)
    if (dep) setFrom(geoFromAirport(dep))
    if (arr) setTo(geoFromAirport(arr))
    if (parsed.departure) setTStart(parsed.departure)
    if (parsed.arrival) setTEnd(parsed.arrival)
    const bits: string[] = []
    if (dep && arr) bits.push(`${dep.iata} → ${arr.iata}`)
    else if (parsed.depIata || parsed.arrIata) bits.push(`${parsed.depIata || '?'} → ${parsed.arrIata || '?'}`)
    if (parsed.departure) bits.push(`dep ${parsed.departure.replace('T', ' ')}`)
    if (parsed.arrival) bits.push(`arr ${parsed.arrival.replace('T', ' ')}`)
    if (parsed.durationMinutes != null) bits.push(`${formatTransitTime(parsed.durationMinutes, 'Airplane')} block`)
    if (!dep || !arr) {
      setShotMsg('Read times from the screenshot, but could not fill From/To — check airport codes on the card.')
    } else if (parsed.confidence < 0.5) {
      setShotMsg('Could only read part of the screenshot — check From/To and times.')
    } else {
      setShotMsg(bits.length ? `Filled From/To and times: ${bits.join(' · ')}` : 'Screenshot read, but no flight fields matched.')
    }
  }

  const ingestFlightScreenshot = async (file: File) => {
    if (!isImageFile(file)) {
      setShotStatus('error')
      setShotMsg('Drop a PNG or JPEG screenshot of a flight card.')
      return
    }
    setShotStatus('reading')
    setShotMsg('Reading screenshot…')
    try {
      const year = Number((tStart || trip.start_date || '').slice(0, 4)) || new Date().getFullYear()
      const parsed = await ocrFlightScreenshot(file, year)
      applyFlightScreenshot(parsed)
      setShotStatus(parsed.confidence >= 0.5 ? 'done' : 'error')
    } catch {
      setShotStatus('error')
      setShotMsg('Could not read that image — try a clearer crop of the flight card.')
    }
  }

  const addTransit = async (override?: { start?: string; end?: string; title?: string; duration?: number }) => {
    if (!from || !to) return alert('Pick both From and To places')
    const start = override?.start || tStart
    const endIn = override?.end || tEnd
    const calc = await calculateTransitMinutes(from, to, mode, start, endIn)
    const dur = override?.duration ?? calc?.minutes ?? null
    const end = dur != null && start && !isFlight(mode) ? addMinutes(start, dur) : endIn
    const title = override?.title || `${from.name} → ${to.name}`
    addItems([{
      ...baseItem(trip, profile.id, items.length), type: 'transit', title,
      from_name: from.name, from_lat: from.lat, from_lng: from.lng, to_name: to.name, to_lat: to.lat, to_lng: to.lng,
      lat: to.lat, lng: to.lng, place_name: shortAddress(to.display, 2) || to.name, start_at: start, end_at: end, duration_minutes: dur, mode_of_transport: mode,
    }])
  }
  const recalcTransit = async (it: ItineraryItem) => {
    const fromC = it.from_lat != null && it.from_lng != null ? { lat: it.from_lat, lng: it.from_lng } : null
    const toC = it.to_lat != null && it.to_lng != null ? { lat: it.to_lat, lng: it.to_lng } : null
    const calc = await calculateTransitMinutes(fromC, toC, it.mode_of_transport, it.start_at, it.end_at)
    if (!calc) { alert('Could not calculate a transit time — pick the From and To places using search so they have locations.'); return }
    const updated = { ...it, duration_minutes: calc.minutes, end_at: it.start_at && !isFlight(it.mode_of_transport) ? addMinutes(it.start_at, calc.minutes) : it.end_at }
    await update(updated)
    alert(`Transit time: ${formatTransitTime(calc.minutes, it.mode_of_transport)}${isFlight(it.mode_of_transport) ? ' (hour:minute)' : ' minutes'} — ${calc.source}`)
  }
  const addHotel = () => {
    const gid = newId()
    if (stayKind === 'airbnb') {
      const addr = airbnbAddress.trim()
      if (!addr) return alert('Enter an Airbnb address')
      const title = shortAddress(addr, 1) || 'Airbnb'
      const common = {
        ...baseItem(trip, profile.id, items.length), type: 'hotel' as const, group_id: gid,
        title, place_name: shortAddress(addr, 2) || addr,
        lat: trip.place_lat, lng: trip.place_lng,
      }
      addItems([
        { ...common, id: newId(), subtype: 'checkin', title: `${title} (Check-in)`, start_at: hIn, end_at: hIn, sort_order: items.length },
        { ...common, id: newId(), subtype: 'checkout', title: `${title} (Check-out)`, start_at: hOut, end_at: hOut, sort_order: items.length + 1 },
      ])
      return
    }
    if (!hotel) return alert('Pick a hotel from the list or search')
    const place = shortAddress(hotel.display, 2) || hotel.name
    const common = { ...baseItem(trip, profile.id, items.length), type: 'hotel' as const, group_id: gid, title: hotel.name, place_name: place, lat: hotel.lat, lng: hotel.lng }
    addItems([
      { ...common, id: newId(), subtype: 'checkin', title: `${hotel.name} (Check-in)`, start_at: hIn, end_at: hIn, sort_order: items.length },
      { ...common, id: newId(), subtype: 'checkout', title: `${hotel.name} (Check-out)`, start_at: hOut, end_at: hOut, sort_order: items.length + 1 },
    ])
  }

  const addHotelFromList = (p: MapPoi) => {
    setHotel({ name: p.name, display: p.name, lat: p.lat, lng: p.lng })
    setStayKind('hotel')
  }

  const addExperienceFromList = async (p: MapPoi) => {
    await addItems([{
      ...baseItem(trip, profile.id, items.length),
      type: 'activity',
      title: p.name,
      place_name: shortAddress(trip.place, 2) || p.name,
      lat: p.lat,
      lng: p.lng,
      start_at: expTime || `${trip.start_date}T11:00`,
      end_at: expTime || `${trip.start_date}T11:00`,
      image_url: '',
    }])
  }

  const addExperienceFromSearch = async () => {
    if (!expSelected) return alert('Search and pick an experience first')
    await addItems([{
      ...baseItem(trip, profile.id, items.length),
      type: 'activity',
      title: expSelected.name,
      place_name: shortAddress(expSelected.display, 2) || expSelected.name,
      lat: expSelected.lat,
      lng: expSelected.lng,
      start_at: expTime || `${trip.start_date}T11:00`,
      end_at: expTime || `${trip.start_date}T11:00`,
      image_url: '',
    }])
    setExpSelected(null)
    setExpFilter('')
  }

  const expSearchTerm = expFilter.trim() || expSelected?.name || trip.place || 'experiences'

  const addActivity = () => {
    if (!act) return alert('Pick a place to visit')
    addItems([{
      ...baseItem(trip, profile.id, items.length), type: 'activity', title: act.name,
      place_name: shortAddress(act.display, 2) || act.name, lat: act.lat, lng: act.lng,
      start_at: aTime, end_at: aTime, image_url: '',
    }])
  }
  const addRestaurant = () => {
    if (!rest) return alert('Pick a restaurant')
    addItems([{
      ...baseItem(trip, profile.id, items.length), type: 'restaurant', title: rest.name,
      place_name: shortAddress(rest.display, 2) || rest.name, lat: rest.lat, lng: rest.lng,
      start_at: rTime, end_at: rTime, image_url: '',
    }])
  }

  const ordered = [...items].sort((a, b) => a.sort_order - b.sort_order || a.start_at.localeCompare(b.start_at))

  const hotelStayIndex = (() => {
    const map = new Map<string, number>()
    let n = 0
    for (const it of ordered) {
      if (it.type === 'hotel' && it.group_id && !map.has(it.group_id)) map.set(it.group_id, ++n)
    }
    return map
  })()

  const tripDays = [...new Set(ordered.map(i => i.start_at.slice(0, 10)).filter(Boolean))].sort()
  const dayIndexOf = (day: string) => {
    const ix = days.indexOf(day)
    if (ix >= 0) return ix
    const j = tripDays.indexOf(day)
    return j >= 0 ? j : 0
  }

  const mapSourceItems = selectedDay
    ? ordered.filter(i => i.start_at.slice(0, 10) === selectedDay && i.lat != null && i.lng != null)
    : ordered.filter(i => i.lat != null && i.lng != null)

  // Per-day numbering when showing all days
  const pins = (() => {
    const out: {
      id: string; lat: number; lng: number; name: string; number: number; kind: string
      savable: boolean; color?: string; label: string
    }[] = []
    if (selectedDay) {
      mapSourceItems.forEach((i, ix) => {
        const title = shortAddress(i.title, 1) || i.title || 'Stop'
        const kind = categoryFromItemType(i.type, i.mode_of_transport)
        const color = dayColor(dayIndexOf(selectedDay))
        out.push({
          id: i.id, lat: i.lat!, lng: i.lng!, name: title, number: ix + 1, kind, savable: true, color,
          label: buildPinPopup({
            title, category: kind, place: shortAddress(i.place_name),
            lat: i.lat!, lng: i.lng!, savable: true, itinerary: false, pinId: i.id,
          }),
        })
      })
    } else {
      const counters: Record<string, number> = {}
      mapSourceItems.forEach(i => {
        const day = i.start_at.slice(0, 10)
        counters[day] = (counters[day] || 0) + 1
        const title = shortAddress(i.title, 1) || i.title || 'Stop'
        const kind = categoryFromItemType(i.type, i.mode_of_transport)
        const color = dayColor(dayIndexOf(day))
        out.push({
          id: i.id, lat: i.lat!, lng: i.lng!, name: title, number: counters[day], kind, savable: true, color,
          label: buildPinPopup({
            title, category: kind, place: `${fmtDate(day)} · ${shortAddress(i.place_name)}`,
            lat: i.lat!, lng: i.lng!, savable: true, itinerary: false, pinId: i.id,
          }),
        })
      })
    }
    if (out.length === 0 && !selectedDay && trip.place_lat != null && trip.place_lng != null) {
      const title = shortAddress(trip.place, 1) || trip.name || 'Destination'
      out.push({
        id: `trip-dest-${trip.id}`,
        lat: trip.place_lat, lng: trip.place_lng, name: title, kind: 'attraction',
        savable: true, number: 1, color: dayColor(0),
        label: buildPinPopup({
          title, category: 'attraction', place: shortAddress(trip.place),
          lat: trip.place_lat, lng: trip.place_lng, savable: true, itinerary: true, pinId: `trip-dest-${trip.id}`,
        }),
      })
    }
    return out
  })()

  const transitSegments = ordered
    .filter(i => i.type === 'transit' && i.from_lat != null && i.from_lng != null && i.to_lat != null && i.to_lng != null)
    .filter(i => !selectedDay || i.start_at.slice(0, 10) === selectedDay)
    .map(i => ({
      id: i.id,
      fromLat: i.from_lat!, fromLng: i.from_lng!, toLat: i.to_lat!, toLng: i.to_lng!,
      path: routePaths[i.id],
      color: dayColor(dayIndexOf(i.start_at.slice(0, 10))),
      label: `<b>${i.title}</b><br/>${shortAddress(i.from_name, 1)} → ${shortAddress(i.to_name, 1)}`,
    }))

  const daysForPaths = selectedDay ? [selectedDay] : tripDays
  const dayPathSegments = daysForPaths.flatMap(day => {
    const stops = ordered.filter(i => i.start_at.slice(0, 10) === day && i.lat != null && i.lng != null)
    const color = dayColor(dayIndexOf(day))
    return stops.slice(0, -1).map((a, i) => {
      const b = stops[i + 1]
      const key = `${a.id}->${b.id}`
      return {
        id: `day-${day}-${key}`,
        fromLat: a.lat!, fromLng: a.lng!, toLat: b.lat!, toLng: b.lng!,
        path: dayRoutePaths[key],
        color,
        label: `<b>${fmtDate(day)}</b><br/>${shortAddress(a.title || a.place_name, 1)} → ${shortAddress(b.title || b.place_name, 1)}`,
      }
    })
  })

  const segments = [...dayPathSegments, ...transitSegments]
  const showDayRoute = false // day paths already in segments; avoid extra dashed overlay
  const dayLoad = (day: string) => {
    const di = ordered.filter(i => i.start_at.slice(0, 10) === day)
    return { count: di.length, mins: di.reduce((s, i) => s + (i.duration_minutes || 60), 0), items: di }
  }
  const leastFullDay = days.reduce((best, d) => dayLoad(d).count < dayLoad(best).count ? d : best, days[0])
  const moveItem = async (it: ItineraryItem, toDay: string) => {
    const moved = { ...it, start_at: toDay + it.start_at.slice(10), end_at: it.end_at ? toDay + it.end_at.slice(10) : it.end_at }
    await update(moved)
  }
  const onDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId) return
    const arr = [...ordered]
    const a = arr.findIndex(x => x.id === dragId)
    const b = arr.findIndex(x => x.id === targetId)
    const [m] = arr.splice(a, 1)
    arr.splice(b, 0, m)
    arr.forEach((x, i) => { x.sort_order = i })
    setItems(arr)
    await api.saveItems(arr)
  }
  const fmtWhen = (iso: string) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  const fmtDay = (iso: string) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
  const fmtClock = (iso: string) => iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
  const near = trip.place_lat != null && trip.place_lng != null
    ? { lat: trip.place_lat, lng: trip.place_lng }
    : null

  const addExperienceToTrip = async (poi: MapPoi) => {
    if (!profile || !trip) return
    await addItems([{
      ...baseItem(trip, profile.id, items.length),
      type: 'activity',
      title: poi.name,
      place_name: shortAddress(trip.place, 2) || poi.name,
      lat: poi.lat,
      lng: poi.lng,
      start_at: aTime || `${trip.start_date}T10:00`,
      end_at: aTime || `${trip.start_date}T10:00`,
      image_url: '',
    }])
    setRightTab('places')
  }

  const selectDay = (day: string) => {
    setSelectedDay(prev => prev === day ? null : day)
    setDivide(true)
    setMobilePanel('map')
  }

  const persistSavePlace = async (payload: SavePlacePayload) => {
    if (!profile) return
    const exists = savedPlaces.some(p =>
      Math.abs(p.lat - payload.lat) < 0.0002 && Math.abs(p.lng - payload.lng) < 0.0002,
    )
    if (exists) {
      setSaveMsg('Already in your saved list')
      window.setTimeout(() => setSaveMsg(''), 2500)
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
      setSavedPlaces(prev => [place, ...prev])
      setSaveMsg(`Saved “${place.name}”`)
      window.setTimeout(() => setSaveMsg(''), 2500)
    } catch (e: any) {
      alert(`Could not save place: ${e.message}`)
    }
  }

  const addPlaceToItinerary = async (payload: SavePlacePayload) => {
    if (!profile) return
    const cat = (payload.category || 'other').toLowerCase()
    const when = aTime || `${trip.start_date}T11:00`
    if (cat === 'hotel') {
      const gid = newId()
      const endDay = trip.end_date || trip.start_date
      await addItems([
        {
          ...baseItem(trip, profile.id, items.length),
          type: 'hotel',
          group_id: gid,
          subtype: 'checkin',
          title: `${payload.name} (Check-in)`,
          place_name: payload.place_name || payload.name,
          lat: payload.lat,
          lng: payload.lng,
          start_at: when,
          end_at: when,
        },
        {
          ...baseItem(trip, profile.id, items.length + 1),
          type: 'hotel',
          group_id: gid,
          subtype: 'checkout',
          title: `${payload.name} (Check-out)`,
          place_name: payload.place_name || payload.name,
          lat: payload.lat,
          lng: payload.lng,
          start_at: `${endDay}T11:00`,
          end_at: `${endDay}T11:00`,
        },
      ])
    } else {
      const type: ItineraryItem['type'] =
        cat === 'restaurant' || cat === 'cafe' ? 'restaurant' : 'activity'
      await addItems([{
        ...baseItem(trip, profile.id, items.length),
        type,
        title: payload.name,
        place_name: payload.place_name || payload.name,
        lat: payload.lat,
        lng: payload.lng,
        start_at: when,
        end_at: when,
      }])
    }
    setSaveMsg(`Added “${payload.name}” to itinerary`)
    window.setTimeout(() => setSaveMsg(''), 2500)
    setMobilePanel('create')
  }

  const saveItemPlace = async (it: ItineraryItem) => {
    if (it.lat == null || it.lng == null) {
      alert('This item needs a map location before it can be saved.')
      return
    }
    await persistSavePlace({
      name: shortAddress(it.title, 1) || it.title || 'Place',
      place_name: shortAddress(it.place_name) || it.place_name || it.title,
      lat: it.lat,
      lng: it.lng,
      category: categoryFromItemType(it.type),
    })
  }

  const isProtectedItem = (it: ItineraryItem) =>
    it.type === 'hotel' || (it.type === 'transit' && /plane|flight|air/i.test(it.mode_of_transport || it.subtype || ''))

  const applyAiReorder = async (reorderIds: string[]) => {
    if (!reorderIds.length) return
    const byId = new Map(items.map(i => [i.id, i]))
    const protectedItems = items.filter(isProtectedItem)
    const movable = items.filter(i => !isProtectedItem(i))
    const ordered: ItineraryItem[] = []
    const used = new Set<string>()
    for (const rid of reorderIds) {
      const it = byId.get(rid)
      if (it && !isProtectedItem(it) && !used.has(rid)) {
        ordered.push(it)
        used.add(rid)
      }
    }
    for (const it of movable) {
      if (!used.has(it.id)) ordered.push(it)
    }
    // Keep relative day flow: merge protected anchors back by original sort position
    const merged = [...items].sort((a, b) => a.sort_order - b.sort_order)
    const nextMovable = [...ordered]
    let mi = 0
    const result: ItineraryItem[] = merged.map(it => {
      if (isProtectedItem(it)) return it
      const n = nextMovable[mi++]
      return n || it
    })
    const withOrder = result.map((it, idx) => ({ ...it, sort_order: idx }))
    setItems(withOrder)
    await api.saveItems(withOrder)
    void protectedItems
  }

  const runAiSuggest = async () => {
    if (!id || !profile) return
    if (!isAdvancedEnabled(profile)) {
      setAiSuggestErr('Turn on Advanced in Settings to use Suggest itinerary.')
      return
    }
    setAiSuggestErr('')
    setAiOrgNote('')
    setAiSuggestLoading(true)
    try {
      const res = await requestSuggestStops(id)
      setAiSuggestions((res.suggestions || []).filter(r => r.status === 'suggested'))
      if (res.organization_note) setAiOrgNote(res.organization_note)
      if (res.reorder_ids?.length) await applyAiReorder(res.reorder_ids)
    } catch (e: any) {
      setAiSuggestErr(e.message || 'Could not suggest itinerary')
    } finally {
      setAiSuggestLoading(false)
    }
  }

  const addAiSuggestion = async (s: ItinerarySuggestion) => {
    if (!trip || !profile) return
    // Hard rule: only restaurant / activity — never hotels or flights
    const type = s.type === 'restaurant' ? 'restaurant' : 'activity'
    const start = s.suggested_start || (trip.start_date ? `${trip.start_date}T12:00` : '')
    const item: ItineraryItem = {
      id: newId(),
      trip_id: trip.id,
      user_id: profile.id,
      type,
      group_id: null,
      subtype: null,
      title: s.title,
      place_name: s.place_name || s.title,
      lat: s.lat,
      lng: s.lng,
      from_name: '', from_lat: null, from_lng: null,
      to_name: '', to_lat: null, to_lng: null,
      start_at: start,
      end_at: start,
      duration_minutes: type === 'restaurant' ? 90 : 120,
      mode_of_transport: '',
      booking_status: 'not_booked',
      booking_open_date: '',
      book_by_date: '',
      image_url: '',
      sort_order: items.length,
      created_at: new Date().toISOString(),
    }
    const saved = await api.saveItem(item)
    setItems(prev => [...prev, saved])
    await updateSuggestionStatus(s.id, 'added')
    setAiSuggestions(prev => prev.filter(x => x.id !== s.id))
  }

  const dismissAiSuggestion = async (s: ItinerarySuggestion) => {
    await updateSuggestionStatus(s.id, 'dismissed')
    setAiSuggestions(prev => prev.filter(x => x.id !== s.id))
  }

  const addSuggestedSavedPlace = async (place: SavedPlace, when: string) => {
    const cat = (place.category || 'other').toLowerCase()
    const type: ItineraryItem['type'] =
      cat === 'restaurant' || cat === 'cafe' ? 'restaurant'
        : cat === 'hotel' ? 'hotel'
          : 'activity'
    const start = when || aTime || `${trip.start_date}T11:00`
    if (type === 'hotel') {
      const gid = newId()
      const endDay = trip.end_date || trip.start_date
      await addItems([
        {
          ...baseItem(trip, profile.id, items.length),
          type: 'hotel',
          group_id: gid,
          subtype: 'checkin',
          title: `${place.name} (Check-in)`,
          place_name: place.place_name || place.name,
          lat: place.lat,
          lng: place.lng,
          start_at: start,
          end_at: start,
          image_url: '',
        },
        {
          ...baseItem(trip, profile.id, items.length + 1),
          type: 'hotel',
          group_id: gid,
          subtype: 'checkout',
          title: `${place.name} (Check-out)`,
          place_name: place.place_name || place.name,
          lat: place.lat,
          lng: place.lng,
          start_at: `${endDay}T11:00`,
          end_at: `${endDay}T11:00`,
          image_url: '',
        },
      ])
    } else {
      await addItems([{
        ...baseItem(trip, profile.id, items.length),
        type,
        title: place.name,
        place_name: place.place_name || place.name,
        lat: place.lat,
        lng: place.lng,
        start_at: start,
        end_at: start,
        image_url: '',
      }])
    }
    setDismissedSuggestions(prev => prev.includes(place.id) ? prev : [...prev, place.id])
    setRightTab('places')
    setSaveMsg(`Added “${place.name}” to this trip`)
    window.setTimeout(() => setSaveMsg(''), 2500)
  }

  const card = (it: ItineraryItem) => {
    const link = bookingLink(it)
    const extra = discoveryLinks(it)
    const isOpen = expandedId === it.id
    const toggle = () => setExpandedId(isOpen ? null : it.id)
    const cat = categoryMeta(it)
    const stayNum = it.type === 'hotel' && it.group_id ? hotelStayIndex.get(it.group_id) : undefined
    const stayColor = stayNum ? STAY_COLORS[(stayNum - 1) % STAY_COLORS.length] : cat.color
    const addressLine = it.type === 'transit'
      ? `${placePrimary(it.from_name) || '?'} → ${placePrimary(it.to_name) || '?'}`
      : placePrimary(it.place_name) || placePrimary(hotelStayTitle(it.title)) || placePrimary(it.title) || 'Place'
    const dateLine = it.type === 'hotel'
      ? `${hotelPhase(it.subtype)} · ${fmtDay(it.start_at)}`
      : fmtDay(it.start_at)
    const timeLine = fmtClock(it.start_at)

    return (
      <div
        key={it.id}
        className={`place-card place-card-compact place-card-${it.type}${isOpen ? ' open' : ''}${stayNum ? ` stay-${stayNum}` : ''}`}
        style={{ borderLeftColor: stayColor }}
        draggable
        onDragStart={() => setDragId(it.id)}
        onDragOver={e => e.preventDefault()}
        onDrop={() => onDrop(it.id)}
      >
        <div className="place-card-summary" onClick={toggle} title={isOpen ? 'Click to collapse' : 'Click to expand'}>
          <ItemThumb it={it} onResolved={url => persistThumb(it, url)} />
          <div className="place-card-main">
            <TranslatedText text={addressLine} className="place-card-place" />
            <span className="place-card-time">
              {dateLine}{timeLine ? ` · ${timeLine}` : ''}
            </span>
          </div>
          <div className="place-card-actions">
            {it.lat != null && it.lng != null && (
              <button
                type="button"
                className="place-icon-btn"
                title="Save place"
                aria-label="Save place"
                onClick={e => { e.stopPropagation(); saveItemPlace(it) }}
              >
                ☆
              </button>
            )}
            <button type="button" className="place-icon-btn" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={e => { e.stopPropagation(); toggle() }}>
              {isOpen ? '▾' : '▸'}
            </button>
            <button
              type="button"
              className="place-icon-btn danger"
              aria-label="Delete item"
              title="Delete item"
              onClick={e => { e.stopPropagation(); if (window.confirm(`Delete "${it.title || 'this item'}"?`)) remove(it) }}
            >
              ✕
            </button>
          </div>
        </div>
        {isOpen && (
          <div className="place-card-body">
            <label>Name / Title</label>
            <input value={it.title} onChange={e => update({ ...it, title: e.target.value })} />
            {it.type === 'transit' && (
              <>
                <label>From</label><input value={it.from_name} onChange={e => update({ ...it, from_name: e.target.value })} />
                <label>To</label><input value={it.to_name} onChange={e => update({ ...it, to_name: e.target.value })} />
                <label>Mode of Transportation</label>
                <select value={it.mode_of_transport || 'Airplane'} onChange={e => update({ ...it, mode_of_transport: e.target.value })}>
                  {TRANSIT_MODES.map(m => (
                    <option key={m.value} value={m.value}>{m.icon} {m.label}</option>
                  ))}
                  {it.mode_of_transport && !TRANSIT_MODES.some(m => m.value === it.mode_of_transport) && (
                    <option value={it.mode_of_transport}>{it.mode_of_transport}</option>
                  )}
                </select>
                <label>Departure</label><input type="datetime-local" value={it.start_at} onChange={e => update({ ...it, start_at: e.target.value })} />
                <label>Arrival</label>
                <input
                  type="datetime-local"
                  value={it.end_at}
                  onChange={e => {
                    const end = e.target.value
                    update({ ...it, end_at: end, duration_minutes: it.start_at && end ? Math.max(0, Math.round((+new Date(end) - +new Date(it.start_at)) / 60000)) : it.duration_minutes })
                  }}
                />
                <TransitTimeInput minutes={it.duration_minutes} mode={it.mode_of_transport} onChange={mins => update({ ...it, duration_minutes: mins })} />
                <button type="button" className="btn-secondary btn-small" style={{ marginTop: 8 }} onClick={() => recalcTransit(it)}>Calculate Transit Time</button>
              </>
            )}
            {it.type === 'hotel' && (
              <>
                <label>Hotel Name</label>
                <input value={hotelStayTitle(it.title)} onChange={e => update({ ...it, title: `${e.target.value} (${it.subtype === 'checkout' ? 'Check-out' : 'Check-in'})` })} />
                <label>Place</label><input value={it.place_name} onChange={e => update({ ...it, place_name: shortAddress(e.target.value) || e.target.value })} />
                <p className="place-card-time" style={{ margin: '8px 0' }}>
                  {hotelPhase(it.subtype)}: <b>{fmtWhen(it.start_at)}</b>
                </p>
                <label>{hotelPhase(it.subtype)} Date &amp; Time</label>
                <input type="datetime-local" value={it.start_at} onChange={e => update({ ...it, start_at: e.target.value, end_at: e.target.value })} />
              </>
            )}
            {(it.type === 'activity' || it.type === 'restaurant') && (
              <>
                {it.image_url && <img src={it.image_url} alt="" className="place-card-thumb large" />}
                <label>{it.type === 'restaurant' ? 'Restaurant / Place' : 'Place'}</label>
                <input value={it.place_name} onChange={e => update({ ...it, place_name: e.target.value })} />
                <label>Picture URL</label><input value={it.image_url} onChange={e => update({ ...it, image_url: e.target.value })} />
                <label>Date &amp; Time</label><input type="datetime-local" value={it.start_at} onChange={e => update({ ...it, start_at: e.target.value })} />
              </>
            )}
            <label>Booking Status</label>
            <select value={it.booking_status} onChange={e => update({ ...it, booking_status: e.target.value as ItineraryItem['booking_status'] })}>
              <option value="not_booked">Not Booked</option>
              <option value="partially_booked">Partially Booked</option>
              <option value="booked">Booked</option>
            </select>
            <label>Booking Open Date</label>
            <input type="date" value={it.booking_open_date ?? ''} onChange={e => update({ ...it, booking_open_date: e.target.value })} />
            <label>Book By Date</label>
            <input type="date" value={it.book_by_date ?? ''} onChange={e => update({ ...it, book_by_date: e.target.value })} />
            {it.booking_open_date && it.book_by_date && it.book_by_date < it.booking_open_date && (
              <p className="field-error">Book by date is before the booking open date.</p>
            )}
            {link && (
              <a href={link.url} target="_blank" rel="noreferrer" className="place-booking-link">{link.label} ↗</a>
            )}
            {extra.length > 0 && (
              <div className="travel-link-row" style={{ marginTop: 8 }}>
                {extra.map(l => (
                  <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="travel-chip">{l.label}</a>
                ))}
              </div>
            )}
            {it.lat != null && it.lng != null && (
              <button
                type="button"
                className="btn-secondary btn-small"
                style={{ display: 'block', marginTop: 12 }}
                onClick={() => saveItemPlace(it)}
              >
                Save place
              </button>
            )}
            <button
              type="button"
              className="btn-danger btn-small"
              style={{ display: 'block', marginTop: 12 }}
              onClick={() => { if (window.confirm(`Delete "${it.title || 'this item'}"?`)) remove(it) }}
            >
              Delete Item
            </button>
          </div>
        )}
      </div>
    )
  }

  const gapAfter = (it: ItineraryItem) => {
    const ix = ordered.findIndex(x => x.id === it.id)
    const next = ix >= 0 ? ordered[ix + 1] : undefined
    if (!next || it.type === 'transit' || next.type === 'transit') return null
    const key = `${it.id}->${next.id}`
    const info = gapInfo[key]
    const hasCoords = it.lat != null && it.lng != null && next.lat != null && next.lng != null
    const currentMode = gapModes[key] || info?.mode || 'Driving'
    return (
      <div key={key} className="place-gap">
        <div className="place-gap-line" />
        <div className="place-gap-pill place-gap-editable">
          {hasCoords ? (
            <>
              <select
                className="gap-mode-select"
                value={GAP_MODES.some(m => m.value === currentMode) ? currentMode : 'Driving'}
                aria-label="Travel mode between stops"
                onChange={e => setGapModes(prev => ({ ...prev, [key]: e.target.value }))}
              >
                {GAP_MODES.map(m => (
                  <option key={m.value} value={m.value}>{m.icon} {m.label}</option>
                ))}
              </select>
              <span className="place-gap-time">
                {info ? formatCompactDuration(info.minutes) : '…'}
              </span>
            </>
          ) : 'Travel time unknown'}
        </div>
        <div className="place-gap-line" />
      </div>
    )
  }

  const renderCards = (list: ItineraryItem[]) => list.flatMap(it => [card(it), gapAfter(it)])

  const dateError = trip.start_date && trip.end_date && trip.end_date < trip.start_date
    ? 'End date must be on or after the start date.'
    : null

  const createSidebar = (
    <aside className="panel trip-create-sidebar">
      <button className="btn-outline btn-small" onClick={() => nav('/')}>← All Trips</button>
      <button className="btn-outline btn-small" onClick={deleteThisTrip} style={{ marginLeft: 8, color: '#c00', borderColor: '#c00' }}>Delete Trip</button>
      <h3 style={{ marginTop: 0, color: 'var(--slate-800)' }}>Create Items</h3>
      {saveMsg && <p className="saved-toast">{saveMsg}</p>}

      <div style={{ borderTop: '2px solid var(--orange)', paddingTop: 6 }}>
        <h4>Transit</h4>
        <PlaceSearch
          key={`from-${from?.name ?? 'empty'}-${from?.lat ?? 0}`}
          label="From"
          value={from}
          onPick={r => { setFrom(r); setFlightOptions([]); setFlightStatus('idle') }}
          near={near}
          placeholder="Airport, station…"
        />
        <PlaceSearch
          key={`to-${to?.name ?? 'empty'}-${to?.lat ?? 0}`}
          label="To"
          value={to}
          onPick={r => { setTo(r); setFlightOptions([]); setFlightStatus('idle') }}
          near={near}
          placeholder="Airport, station…"
        />
        <label htmlFor="transit-mode">Mode of transportation</label>
        <select id="transit-mode" value={mode} onChange={e => { setMode(e.target.value); setFlightOptions([]); setFlightStatus('idle') }}>
          {TRANSIT_MODES.map(m => (
            <option key={m.value} value={m.value}>{m.icon} {m.label}</option>
          ))}
        </select>
        {isFlight(mode) && (
          <div className="flight-lookup">
            <div
              className={`flight-shot-drop${shotDragging ? ' dragging' : ''}${shotStatus === 'reading' ? ' reading' : ''}`}
              onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setShotDragging(true) }}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setShotDragging(true) }}
              onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setShotDragging(false) }}
              onDrop={e => {
                e.preventDefault()
                e.stopPropagation()
                setShotDragging(false)
                const file = e.dataTransfer.files?.[0]
                if (file) void ingestFlightScreenshot(file)
              }}
              onPaste={e => {
                const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))
                const file = item?.getAsFile()
                if (file) {
                  e.preventDefault()
                  void ingestFlightScreenshot(file)
                }
              }}
              role="button"
              tabIndex={0}
              onClick={() => shotInputRef.current?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') shotInputRef.current?.click() }}
            >
              <input
                ref={shotInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={e => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void ingestFlightScreenshot(file)
                }}
              />
              <strong>{shotStatus === 'reading' ? 'Reading screenshot…' : 'Drop flight screenshot'}</strong>
              <span>Cirium / FlightAware-style cards · fills airports &amp; times</span>
            </div>
            {shotMsg && <p className="places-hint">{shotMsg}</p>}
            <button
              type="button"
              className="btn-secondary btn-small"
              style={{ width: '100%', marginTop: 8 }}
              disabled={!from || !to || flightStatus === 'loading'}
              onClick={async () => {
                if (!from || !to) return
                setFlightStatus('loading')
                setFlightMsg('')
                try {
                  const res = await lookupFlights({
                    fromName: from.name,
                    toName: to.name,
                    from: { lat: from.lat, lng: from.lng },
                    to: { lat: to.lat, lng: to.lng },
                    date: (tStart || `${trip.start_date}T12:00`).slice(0, 10),
                  })
                  setFlightOptions(res.flights)
                  setFlightLink(res.googleFlights || '')
                  setFlightMsg(res.message || '')
                  // Always apply estimate times when there are no live rows
                  const fill = res.live && res.flights[0] ? null : res.estimate
                  if (fill) {
                    setTStart(fill.departure)
                    setTEnd(fill.arrival)
                    if (res.dep) {
                      setFrom(prev => prev ? {
                        ...prev,
                        name: prev.name.includes(res.dep!.iata) ? prev.name : `${placePrimary(prev.name) || prev.name} (${res.dep!.iata})`,
                      } : prev)
                    }
                    if (res.arr) {
                      setTo(prev => prev ? {
                        ...prev,
                        name: prev.name.includes(res.arr!.iata) ? prev.name : `${placePrimary(prev.name) || prev.name} (${res.arr!.iata})`,
                      } : prev)
                    }
                  }
                  setFlightStatus(res.flights.length ? 'ready' : res.estimate ? 'ready' : 'empty')
                } catch {
                  setFlightStatus('error')
                  setFlightMsg('Could not look up flights.')
                }
              }}
            >
              {flightStatus === 'loading' ? 'Looking up…' : 'Estimate time / find flights'}
            </button>
            {flightLink && (
              <a className="travel-chip" href={flightLink} target="_blank" rel="noreferrer" style={{ marginTop: 6, display: 'inline-flex' }}>
                Open Google Flights
              </a>
            )}
            {flightMsg && <p className="places-hint">{flightMsg}</p>}
            {flightOptions.length > 0 && (
              <div className="pick-list" style={{ marginTop: 8 }}>
                {flightOptions.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    className="pick-row"
                    onClick={() => {
                      setTStart(f.departure)
                      setTEnd(f.arrival)
                      setMode('Airplane')
                      setFrom(prev => prev ? {
                        ...prev,
                        name: prev.name.includes(f.depIata) ? prev.name : `${placePrimary(prev.name) || prev.name} (${f.depIata})`,
                      } : prev)
                      setTo(prev => prev ? {
                        ...prev,
                        name: prev.name.includes(f.arrIata) ? prev.name : `${placePrimary(prev.name) || prev.name} (${f.arrIata})`,
                      } : prev)
                      void addTransit({
                        start: f.departure,
                        end: f.arrival,
                        duration: f.durationMinutes,
                        title: `${f.flightNumber} · ${f.depIata} → ${f.arrIata}`,
                      })
                    }}
                  >
                    <span className="pick-row-main" style={{ pointerEvents: 'none' }}>
                      <span><b>{f.flightNumber}</b> · {f.airline}</span>
                      <span className="pick-row-cat">
                        {f.depIata}→{f.arrIata} · {formatTransitTime(f.durationMinutes, 'Airplane')} · tap to add
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/train|rail/i.test(mode) && from && to && (
          <a
            className="travel-chip"
            style={{ marginTop: 8, display: 'inline-flex' }}
            href={`https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=transit`}
            target="_blank"
            rel="noreferrer"
          >
            Check trains on Google Maps
          </a>
        )}
        <label>Departure</label><input type="datetime-local" value={tStart} onChange={e => setTStart(e.target.value)} />
        <label>Arrival</label><input type="datetime-local" value={tEnd} onChange={e => setTEnd(e.target.value)} />
        <button className="btn-orange" style={{ width: '100%', marginTop: 10 }} onClick={() => addTransit()}>
          Add Transit
        </button>
      </div>

      <div style={{ borderTop: '2px solid var(--orange)', paddingTop: 6, marginTop: 14 }}>
        <h4>Hotel / Stay</h4>
        <div className="stay-kind-toggle" role="group" aria-label="Stay type">
          <button type="button" className={stayKind === 'hotel' ? 'active' : ''} onClick={() => setStayKind('hotel')}>Hotel</button>
          <button type="button" className={stayKind === 'airbnb' ? 'active' : ''} onClick={() => setStayKind('airbnb')}>Airbnb</button>
        </div>

        {stayKind === 'hotel' ? (
          <>
            <p className="places-hint">Pick from nearby hotels (OSM) or Booking / Google Maps links.</p>
            {hotelListStatus === 'loading' && <p className="places-hint">Loading hotels…</p>}
            {hotelListStatus === 'empty' && <p className="places-hint">No hotels found nearby — search below.</p>}
            <div className="pick-list">
              {hotelPicks.slice(0, 8).map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={`pick-row${hotel?.name === p.name ? ' selected' : ''}${hotelPreview?.id === p.id ? ' previewing' : ''}`}
                  onMouseEnter={() => setHotelPreview({ id: p.id, lat: p.lat, lng: p.lng, name: p.name })}
                  onMouseLeave={() => setHotelPreview(null)}
                  onFocus={() => setHotelPreview({ id: p.id, lat: p.lat, lng: p.lng, name: p.name })}
                  onBlur={() => setHotelPreview(null)}
                  onClick={() => addHotelFromList(p)}
                >
                  <span>🛏️ {p.name}</span>
                  <a href={googleMapsUrl({ lat: p.lat, lng: p.lng, name: p.name })} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Maps</a>
                </button>
              ))}
            </div>
            <PlaceSearch
              label="Or search a hotel"
              onPick={r => { setHotel(r); setStayKind('hotel'); setHotelPreview(null) }}
              onHover={r => setHotelPreview(r ? { lat: r.lat, lng: r.lng, name: r.name } : null)}
              near={near}
              placeholder="Hotel name…"
            />
            {hotel && <p className="places-hint">Selected: <b>{hotel.name}</b></p>}
            <div className="travel-link-row" style={{ marginTop: 8 }}>
              <a className="travel-chip" href={`https://www.booking.com/searchresults.html?ss=${encodeURIComponent(trip.place || '')}`} target="_blank" rel="noreferrer">Booking.com</a>
              <a className="travel-chip" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`hotels near ${trip.place || ''}`)}`} target="_blank" rel="noreferrer">Google Hotels</a>
              <a className="travel-chip" href={`https://www.tripadvisor.com/Search?q=${encodeURIComponent(`hotels ${trip.place || ''}`)}`} target="_blank" rel="noreferrer">TripAdvisor</a>
            </div>
          </>
        ) : (
          <>
            <label>Airbnb address</label>
            <input value={airbnbAddress} onChange={e => setAirbnbAddress(e.target.value)} placeholder="Street address or listing name" />
            <div className="travel-link-row" style={{ marginTop: 8 }}>
              <a className="travel-chip" href={`https://www.airbnb.com/s/${encodeURIComponent(trip.place || '')}/homes`} target="_blank" rel="noreferrer">Search Airbnb</a>
            </div>
          </>
        )}

        <label>Beginning of Stay</label><input type="datetime-local" value={hIn} onChange={e => setHIn(e.target.value)} />
        <label>End of Stay</label><input type="datetime-local" value={hOut} onChange={e => setHOut(e.target.value)} />
        <button className="btn-orange" style={{ width: '100%', marginTop: 10 }} onClick={addHotel}>
          {stayKind === 'airbnb' ? 'Add Airbnb Stay' : 'Add Hotel Stay'}
        </button>
        <p style={{ fontSize: 11 }}>Adds a check-in and a check-out card.</p>
      </div>

      <div style={{ borderTop: '2px solid var(--orange)', paddingTop: 6, marginTop: 14 }}>
        <h4>Things to Do</h4>
        <PlaceSearch label="Place" onPick={setAct} near={near} placeholder="Attraction or spot…" />
        <label>Date &amp; Time</label><input type="datetime-local" value={aTime} onChange={e => setATime(e.target.value)} />
        <button className="btn-orange" style={{ width: '100%', marginTop: 10 }} onClick={addActivity}>Add Thing to Do</button>
      </div>

      <div style={{ borderTop: '2px solid var(--orange)', paddingTop: 6, marginTop: 14 }}>
        <h4>Restaurant</h4>
        <PlaceSearch label="Restaurant / Place" onPick={setRest} near={near} placeholder="Restaurant name…" />
        <label>Date &amp; Time</label><input type="datetime-local" value={rTime} onChange={e => setRTime(e.target.value)} />
        <button className="btn-orange" style={{ width: '100%', marginTop: 10 }} onClick={addRestaurant}>Add Restaurant</button>
      </div>

      <div style={{ borderTop: '2px solid var(--orange)', paddingTop: 6, marginTop: 14 }}>
        <h4>Experiences</h4>
        <p className="places-hint">Search an attraction, or pick from nearby results. Set a date &amp; time, then add.</p>
        <PlaceSearch
          label="Search experiences"
          near={near}
          placeholder="Museum, tour, shrine…"
          onPick={r => {
            setExpSelected(r)
            setExpFilter(r.name)
          }}
        />
        <label htmlFor="exp-filter">Filter nearby list</label>
        <input
          id="exp-filter"
          value={expFilter}
          onChange={e => {
            setExpFilter(e.target.value)
            if (expSelected && e.target.value !== expSelected.name) setExpSelected(null)
          }}
          placeholder="Type to filter nearby experiences…"
          autoComplete="off"
        />
        {expSelected && (
          <p className="places-hint">Selected: <b>{expSelected.name}</b></p>
        )}
        <label>Date &amp; Time</label>
        <input type="datetime-local" value={expTime} onChange={e => setExpTime(e.target.value)} />
        <button
          type="button"
          className="btn-orange"
          style={{ width: '100%', marginTop: 10 }}
          onClick={addExperienceFromSearch}
          disabled={!expSelected}
        >
          Add Searched Experience
        </button>
        <div className="travel-link-row" style={{ margin: '8px 0' }}>
          <a className="travel-chip" href={`https://www.tripadvisor.com/Search?q=${encodeURIComponent(expSearchTerm)}`} target="_blank" rel="noreferrer">TripAdvisor</a>
          <a className="travel-chip" href={`https://www.viator.com/searchResults/all?text=${encodeURIComponent(expSearchTerm)}`} target="_blank" rel="noreferrer">Viator</a>
          <a className="travel-chip" href={`https://www.getyourguide.com/s/?q=${encodeURIComponent(expSearchTerm)}`} target="_blank" rel="noreferrer">GetYourGuide</a>
          <a className="travel-chip" href={`https://www.lonelyplanet.com/search?q=${encodeURIComponent(expSearchTerm)}`} target="_blank" rel="noreferrer">Lonely Planet</a>
        </div>
        {expPickStatus === 'loading' && <p className="places-hint">Loading experiences…</p>}
        {expPickStatus === 'empty' && <p className="places-hint">No nearby experiences found — search above or use the links.</p>}
        {expPickStatus === 'ready' && filteredExpPicks.length === 0 && expFilter.trim() && (
          <p className="places-hint">No nearby matches for “{expFilter}” — try Search experiences above.</p>
        )}
        <div className="pick-list">
          {filteredExpPicks.slice(0, 10).map(p => (
            <div key={p.id} className="pick-row experience-pick">
              <button type="button" className="pick-row-main" onClick={() => addExperienceFromList(p)}>
                <span>{poiMeta(p.category).emoji} <TranslatedText text={p.name} /></span>
                <span className="pick-row-cat">{poiMeta(p.category).title}</span>
              </button>
              <button type="button" className="btn-orange btn-small" onClick={() => addExperienceFromList(p)}>Add</button>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )

  const destLinks = destinationTravelLinks(trip.place)

  const placesPanel = (
    <aside className="panel trip-places-sidebar">
      <div className="right-tabs" role="tablist" aria-label="Trip side panel">
        <button type="button" role="tab" aria-selected={rightTab === 'places'} className={rightTab === 'places' ? 'active' : ''} onClick={() => setRightTab('places')}>Your Places</button>
        <button type="button" role="tab" aria-selected={rightTab === 'experiences'} className={rightTab === 'experiences' ? 'active' : ''} onClick={() => setRightTab('experiences')}>Experiences</button>
      </div>

      {rightTab === 'places' && (
        <>
          <div className="places-header">
            <h3>Your Places</h3>
            <label className="places-toggle">
              <span>Divide into days</span>
              <span className="toggle">
                <input type="checkbox" checked={divide} onChange={e => {
                  setDivide(e.target.checked)
                  if (!e.target.checked) setSelectedDay(null)
                }} />
                <span className="slider" />
              </span>
            </label>
          </div>
          {canUseAiSuggest(profile) ? (
            <div className="ai-suggest-block">
              <button
                type="button"
                className="btn-orange suggest-itinerary-btn"
                disabled={aiSuggestLoading}
                onClick={runAiSuggest}
              >
                {aiSuggestLoading ? 'Suggesting…' : 'Suggest itinerary'}
              </button>
              <p className="places-hint" style={{ margin: '8px 0 0' }}>
                Uses AI on your stops and Saved Places to rearrange activities/restaurants and propose new stops.
                Hotels and flights stay fixed.
              </p>
              {aiOrgNote && <p className="places-hint" style={{ marginTop: 8 }}>{aiOrgNote}</p>}
              {aiSuggestErr && <div className="error" style={{ marginTop: 8 }}>{aiSuggestErr}</div>}
              {aiSuggestions.map(s => (
                <div key={s.id} className="ai-suggest-card">
                  <strong>{s.title}</strong>
                  <p>{s.reason || s.place_name}</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="btn-orange" onClick={() => addAiSuggestion(s)}>Add</button>
                    <button type="button" className="btn-ghost" onClick={() => dismissAiSuggestion(s)}>Dismiss</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="places-hint" style={{ marginTop: 8 }}>
              Turn on <b>Advanced</b> in Settings to use Suggest itinerary.
            </p>
          )}
          <p className="places-hint">
            Drag to reorder. <b>All days</b> shows every day’s route in its own color; click a day to focus it.
            Change walking/driving/train between stops with the dropdown on the connector.
            {selectedDay ? <> · Viewing <b>{fmtDate(selectedDay)}</b></> : <> · Showing all days</>}.
          </p>
          {!selectedDay && tripDays.length > 1 && (
            <div className="day-legend" aria-label="Day colors">
              {tripDays.map(day => (
                <span key={day} className="day-legend-item">
                  <span className="day-legend-swatch" style={{ background: dayColor(dayIndexOf(day)) }} />
                  {fmtDate(day)}
                </span>
              ))}
            </div>
          )}

          {savedPlaceSuggestions.length > 0 && (
            <div className="saved-suggest" role="region" aria-label="Saved place suggestions">
              <div className="saved-suggest-header">
                <h4>Suggested from Saved Places</h4>
                <p>Near your booked flights or hotels — not on this trip yet.</p>
              </div>
              {savedPlaceSuggestions.map(s => (
                <div key={s.place.id} className="saved-suggest-row">
                  <div className="saved-suggest-main">
                    <span className="saved-suggest-name">
                      {emojiForKind(s.place.category)} {s.place.name}
                    </span>
                    <span className="saved-suggest-meta">
                      {s.reason}
                      {s.km < 1 ? ' · under 1 km' : ` · ${s.km.toFixed(0)} km away`}
                    </span>
                  </div>
                  <div className="saved-suggest-actions">
                    <button
                      type="button"
                      className="btn-orange btn-small"
                      onClick={() => addSuggestedSavedPlace(s.place, s.when)}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => setDismissedSuggestions(prev => [...prev, s.place.id])}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {days.length > 0 && (
            <div className="day-chip-row" role="tablist" aria-label="Trip days">
              <button
                type="button"
                className={`day-chip${!selectedDay ? ' active' : ''}`}
                onClick={() => setSelectedDay(null)}
              >
                All days
              </button>
              {days.map(day => {
                const load = dayLoad(day)
                return (
                  <button
                    key={day}
                    type="button"
                    className={`day-chip${selectedDay === day ? ' active' : ''}`}
                    onClick={() => selectDay(day)}
                    title={`Show route for ${fmtDate(day)}`}
                    style={{ borderColor: dayColor(dayIndexOf(day)) }}
                  >
                    <span className="day-chip-dot" style={{ background: dayColor(dayIndexOf(day)) }} aria-hidden />
                    {fmtDate(day)}
                    <span>{load.count}</span>
                  </button>
                )
              })}
            </div>
          )}

          {ordered.length === 0 && !divide && (
            <div className="places-empty">
              <div className="places-empty-icon" aria-hidden>
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
                  <path d="M20 10v12M14 18l6 8 6-8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h4>No places yet</h4>
              <p>Search for transit, hotels, activities, or restaurants on the left to pin them here and on the map.</p>
            </div>
          )}

          {!divide && renderCards(ordered)}
          {divide && days.map(day => {
            const load = dayLoad(day)
            const over = load.count > 5 || load.mins > 480
            const active = selectedDay === day
            return (
              <div key={day} className={`places-day${active ? ' active-day' : ''}`}>
                <button type="button" className="places-day-title" onClick={() => selectDay(day)}>
                  <span>
                    {fmtDate(day)} <span className="places-day-count">({load.count} items)</span>
                  </span>
                  <span className="places-day-route-hint">{active ? 'Route on map' : 'Show route'}</span>
                </button>
                {over && (
                  <div className="places-day-warning">
                    This day looks full. Suggestion: move an item to <b>{fmtDate(leastFullDay)}</b>.
                    {load.items.length > 0 && (
                      <button type="button" className="btn-orange btn-small" style={{ marginLeft: 8 }} onClick={() => moveItem(load.items[load.items.length - 1], leastFullDay)}>
                        Move last item there
                      </button>
                    )}
                  </div>
                )}
                {renderCards(load.items)}
                {load.items.length === 0 && <p className="places-day-empty">No items this day.</p>}
              </div>
            )
          })}
          {divide && ordered.filter(i => !days.includes(i.start_at.slice(0, 10))).length > 0 && (
            <>
              <div className="places-day-title static">Outside trip dates</div>
              {renderCards(ordered.filter(i => !days.includes(i.start_at.slice(0, 10))))}
            </>
          )}
        </>
      )}

      {rightTab === 'experiences' && (
        <div className="experiences-panel">
          <h3>Experiences</h3>
          <p className="places-hint">
            Attractions and points of interest near {trip.place || 'your destination'}. Open TripAdvisor or Lonely Planet for reviews and booking, or add one to your itinerary.
          </p>

          {destLinks.length > 0 && (
            <div className="travel-link-row" style={{ marginBottom: 14 }}>
              {destLinks.map(l => (
                <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="travel-chip" title={l.blurb}>{l.label}</a>
              ))}
            </div>
          )}

          {expStatus === 'need-place' && (
            <div className="places-empty">
              <h4>Set a destination</h4>
              <p>Choose a trip place with a map location so we can find nearby experiences.</p>
            </div>
          )}
          {expStatus === 'loading' && <p className="places-hint">Finding experiences…</p>}
          {expStatus === 'empty' && (
            <div className="places-empty">
              <h4>No experiences found</h4>
              <p>Try TripAdvisor or Lonely Planet above, or zoom the map and use Nearby places.</p>
            </div>
          )}
          {experiences.map(poi => {
            const meta = poiMeta(poi.category)
            const links = poiTravelLinks(poi.name, trip.place, poi.category)
            return (
              <div key={poi.id} className="experience-card">
                <div className="experience-card-top">
                  <span className="experience-badge" style={{ background: meta.color }}>{meta.emoji}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <TranslatedText text={poi.name} as="div" className="experience-title" />
                    <div className="experience-cat">{meta.title}</div>
                  </div>
                </div>
                <div className="travel-link-row">
                  {links.map(l => (
                    <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="travel-chip">{l.label}</a>
                  ))}
                </div>
                <button type="button" className="btn-orange btn-small" style={{ width: '100%', marginTop: 8 }} onClick={() => addExperienceToTrip(poi)}>
                  Add to itinerary
                </button>
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )

  return (
    <div className="app-shell trip-page">
      <TopBar />
      <div className="trip-mobile-tabs" role="tablist" aria-label="Trip panels">
        <button type="button" role="tab" aria-selected={mobilePanel === 'create'} className={mobilePanel === 'create' ? 'active' : ''} onClick={() => setMobilePanel('create')}>Create</button>
        <button type="button" role="tab" aria-selected={mobilePanel === 'map'} className={mobilePanel === 'map' ? 'active' : ''} onClick={() => setMobilePanel('map')}>Map</button>
        <button type="button" role="tab" aria-selected={mobilePanel === 'places'} className={mobilePanel === 'places' ? 'active' : ''} onClick={() => setMobilePanel('places')}>Places</button>
      </div>
      <div className="trip-body">
        <div className={`trip-col trip-col-create${mobilePanel === 'create' ? ' mobile-show' : ''}`}>
          {createSidebar}
        </div>

        <div className={`trip-col trip-col-center${mobilePanel === 'map' ? ' mobile-show' : ''}`}>
          {(trip.image_url || trip.place) && (
            <div className="trip-hero-strip">
              <DestinationThumb
                place={trip.place}
                name={trip.name}
                lat={trip.place_lat}
                lng={trip.place_lng}
                imageUrl={trip.image_url}
                size={56}
                className="trip-hero-thumb"
              />
              <div className="trip-hero-copy">
                <strong>{trip.name || 'Untitled Trip'}</strong>
                <span>{shortAddress(trip.place) || 'No destination yet'}</span>
              </div>
              {destLinks.slice(0, 3).map(l => (
                <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="travel-chip">{l.label}</a>
              ))}
            </div>
          )}
          {!selectedDay && tripDays.length > 0 && (
            <div className="day-route-banner">
              <span>All days on the map — each day uses a different color</span>
            </div>
          )}
          {selectedDay && (
            <div className="day-route-banner" style={{ borderLeft: `4px solid ${dayColor(dayIndexOf(selectedDay))}` }}>
              <span>
                Day route: <strong>{fmtDate(selectedDay)}</strong>
                {mapSourceItems.length > 1
                  ? ` · ${mapSourceItems.map(i => shortAddress(i.title || i.place_name, 1) || 'Stop').join(' → ')}`
                  : ' · Add stops with locations to draw a path'}
              </span>
              <button type="button" className="btn-secondary btn-small" onClick={() => setSelectedDay(null)}>All days</button>
            </div>
          )}
          <div className="trip-meta-bar">
            <div className="trip-meta-field trip-meta-name">
              <label htmlFor="trip-name-field">Trip Name</label>
              <input id="trip-name-field" value={trip.name} onChange={e => saveT({ ...trip, name: e.target.value })} />
            </div>
            <div className="trip-meta-field trip-meta-dates">
              <label>Dates</label>
              <div className="trip-meta-dates-row">
                <input type="date" aria-label="Start date" value={trip.start_date} onChange={e => saveT({ ...trip, start_date: e.target.value })} />
                <span className="trip-meta-sep">to</span>
                <input type="date" aria-label="End date" value={trip.end_date} onChange={e => saveT({ ...trip, end_date: e.target.value })} />
              </div>
              {dateError && <p className="field-error">{dateError}</p>}
            </div>
            <div className="trip-meta-field trip-meta-stops">
              <label>Major Stops</label>
              <MajorStopsInput value={trip.major_stops} onChange={stops => saveT({ ...trip, major_stops: stops })} />
            </div>
          </div>
          {saveMsg && <p className="saved-toast trip-save-toast">{saveMsg}</p>}
          <MapView
            pins={pins}
            segments={segments}
            showRoute={false}
            enableNearbyPois
            showUserLocation
            placeContext={shortAddress(trip.place) || trip.place}
            displayLanguage={profile.preferred_language || 'en'}
            previewPin={hotelPreview}
            onSavePlace={persistSavePlace}
            onAddToItinerary={addPlaceToItinerary}
          />
        </div>

        <div className={`trip-col trip-col-places${mobilePanel === 'places' ? ' mobile-show' : ''}`}>
          {placesPanel}
        </div>
      </div>
    </div>
  )
}
