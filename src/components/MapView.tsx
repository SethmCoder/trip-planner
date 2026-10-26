import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { buildPinPopup, emojiForKind, fetchNearbyPois, poiLabelWithDisplayName, type MapPoi } from '../lib/pois'
import { translateLabel } from '../lib/translate'

export interface SavePlacePayload {
  name: string
  place_name?: string
  lat: number
  lng: number
  category?: string
}

export interface MapPin {
  id: string
  lat: number
  lng: number
  label: string
  number?: number
  kind?: string
  name?: string
  savable?: boolean
  /** Day / route color (multi-day itineraries). */
  color?: string
}
export interface MapSegment {
  id: string
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  label: string
  path?: { lat: number; lng: number }[]
  color?: string
}

/** Keep consecutive longitudes continuous (e.g. Japan → Pacific → Seattle). */
function unwrapLng(lng: number, refLng: number) {
  let out = lng
  while (out - refLng > 180) out -= 360
  while (out - refLng < -180) out += 360
  return out
}

function unwrapPath(points: L.LatLng[]): L.LatLng[] {
  if (points.length === 0) return []
  const out: L.LatLng[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    out.push(L.latLng(points[i].lat, unwrapLng(points[i].lng, out[i - 1].lng)))
  }
  return out
}

/** Draw the same geometry on ±360° world copies so routes stay visible when panning. */
const WORLD_OFFSETS = [0, -360, 360] as const

function shiftPath(line: L.LatLng[], offset: number): L.LatLng[] {
  if (offset === 0) return line
  return line.map(p => L.latLng(p.lat, p.lng + offset))
}

const arrowAt = (a: L.LatLng, b: L.LatLng) => {
  const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2)
  const angle = Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180 / Math.PI
  return L.marker(mid, { icon: L.divIcon({ className: 'arrow-icon', html: `<div style="transform:rotate(${angle - 90}deg)">➤</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false })
}

function previewHotelIcon(selected: boolean) {
  return L.divIcon({
    className: 'hotel-preview-pin',
    html: `<div class="hotel-preview-body${selected ? ' selected' : ''}"><span>🛏️</span></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 36],
  })
}

function emojiPinIcon(kind: string | undefined, number: number | undefined, selected: boolean, color?: string) {
  const emoji = emojiForKind(kind)
  const num = number != null ? `<span class="emoji-pin-num">${number}</span>` : ''
  const ring = color ? ` style="border-color:${color};box-shadow:0 0 0 2px ${color}55, 0 2px 8px rgba(15,23,42,0.35)"` : ''
  return L.divIcon({
    className: 'emoji-pin',
    html: `<div class="emoji-pin-body${selected ? ' selected' : ''}"${ring}><span class="emoji-pin-glyph">${emoji}</span>${num}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 34],
  })
}

function userLocationIcon() {
  return L.divIcon({
    className: 'user-loc-pin',
    html: `<div class="user-loc-pulse"></div><div class="user-loc-dot"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

export type PreviewPin = {
  id?: string
  lat: number
  lng: number
  name: string
  category?: string
}

export default function MapView({
  pins,
  segments = [],
  onPinClick,
  showRoute = false,
  selectedId,
  enableNearbyPois = false,
  showUserLocation = false,
  placeContext = '',
  displayLanguage = 'en',
  previewPin = null,
  onPoisLoaded,
  onSavePlace,
  onAddToItinerary,
  children,
}: {
  pins: MapPin[]
  segments?: MapSegment[]
  onPinClick?: (id: string) => void
  showRoute?: boolean
  selectedId?: string | null
  enableNearbyPois?: boolean
  showUserLocation?: boolean
  placeContext?: string
  /** From Settings — translate pin / POI names in popups. */
  displayLanguage?: string
  /** Temporary highlight (e.g. hotel search hover). */
  previewPin?: PreviewPin | null
  onPoisLoaded?: (pois: MapPoi[]) => void
  onSavePlace?: (place: SavePlacePayload) => void
  onAddToItinerary?: (place: SavePlacePayload) => void
  children?: React.ReactNode
}) {
  const el = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const poiLayerRef = useRef<L.LayerGroup | null>(null)
  const userLayerRef = useRef<L.LayerGroup | null>(null)
  const previewLayerRef = useRef<L.LayerGroup | null>(null)
  const userMarkerRef = useRef<L.Marker | null>(null)
  const accuracyRef = useRef<L.Circle | null>(null)
  const watchIdRef = useRef<number | null>(null)
  const markersRef = useRef<Record<string, L.Marker>>({})
  const pinMetaRef = useRef<Record<string, { number?: number; kind?: string; name?: string; savable?: boolean; lat: number; lng: number; color?: string }>>({})
  const poiCacheByTileRef = useRef<Record<string, MapPoi[]>>({})
  const poiCacheRef = useRef<Record<string, MapPoi>>({})
  const onPinClickRef = useRef(onPinClick)
  const onPoisLoadedRef = useRef(onPoisLoaded)
  const onSavePlaceRef = useRef(onSavePlace)
  const onAddToItineraryRef = useRef(onAddToItinerary)
  const selectedIdRef = useRef(selectedId)
  const placeContextRef = useRef(placeContext)
  const displayLanguageRef = useRef(displayLanguage)
  const knownFocusIdsRef = useRef<Set<string>>(new Set())
  const routeBoundsRef = useRef<L.LatLngBounds | null>(null)
  const focusBoundsRef = useRef<L.LatLngBounds | null>(null)
  const [poisOn, setPoisOn] = useState(true)
  const [poiStatus, setPoiStatus] = useState<'idle' | 'loading' | 'ready' | 'zoom' | 'empty' | 'error'>('idle')
  const [poiCount, setPoiCount] = useState(0)
  const [locStatus, setLocStatus] = useState<'off' | 'pending' | 'on' | 'denied'>('off')
  const [hasRoute, setHasRoute] = useState(false)

  const pinsKey = pins.map(p => `${p.id}:${p.lat}:${p.lng}:${p.number ?? ''}:${p.kind ?? ''}:${p.savable ? 1 : 0}:${p.name ?? ''}`).join('|')
  const segmentsKey = segments.map(s => `${s.id}:${s.fromLat},${s.fromLng}->${s.toLat},${s.toLng}:${s.path?.length ?? 0}`).join('|')

  useEffect(() => { onPinClickRef.current = onPinClick }, [onPinClick])
  useEffect(() => { onPoisLoadedRef.current = onPoisLoaded }, [onPoisLoaded])
  useEffect(() => { onSavePlaceRef.current = onSavePlace }, [onSavePlace])
  useEffect(() => { onAddToItineraryRef.current = onAddToItinerary }, [onAddToItinerary])
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  useEffect(() => { placeContextRef.current = placeContext }, [placeContext])
  useEffect(() => { displayLanguageRef.current = displayLanguage }, [displayLanguage])

  useEffect(() => {
    if (!el.current || mapRef.current) return
    const map = L.map(el.current, {
      zoomControl: false,
      // Jump markers onto the visible world copy when panning across ±180°
      worldCopyJump: true,
      // No maxBounds — longitude wraps so Japan → Seattle can cross the Pacific
      minZoom: 2,
    }).setView([20, 0], 2)
    mapRef.current = map
    L.control.zoom({ position: 'topleft' }).addTo(map)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics | © OpenStreetMap contributors',
      maxZoom: 19,
      // Repeat tiles horizontally so Japan ↔ Seattle can cross the Pacific
      noWrap: false,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    poiLayerRef.current = L.layerGroup().addTo(map)
    previewLayerRef.current = L.layerGroup().addTo(map)
    userLayerRef.current = L.layerGroup().addTo(map)

    const resolvePlacePayload = (btn: HTMLElement): SavePlacePayload | null => {
      const id = btn.getAttribute('data-place-pin') || btn.getAttribute('data-save-pin')
      if (id) {
        const pin = pinMetaRef.current[id]
        if (pin) {
          return {
            name: pin.name || 'Saved place',
            place_name: pin.name,
            lat: pin.lat,
            lng: pin.lng,
            category: pin.kind || 'other',
          }
        }
        const poi = poiCacheRef.current[id]
        if (poi) {
          return {
            name: poi.name,
            place_name: poi.name,
            lat: poi.lat,
            lng: poi.lng,
            category: poi.category,
          }
        }
      }
      const lat = parseFloat(btn.getAttribute('data-place-lat') || btn.getAttribute('data-save-lat') || '')
      const lng = parseFloat(btn.getAttribute('data-place-lng') || btn.getAttribute('data-save-lng') || '')
      const name = btn.getAttribute('data-place-name') || btn.getAttribute('data-save-name') || 'Place'
      const category = btn.getAttribute('data-place-category') || btn.getAttribute('data-save-category') || 'other'
      const place_name = btn.getAttribute('data-place-place') || btn.getAttribute('data-save-place') || name
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return { name, place_name, lat, lng, category }
    }

    const onPopupClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      const saveBtn = t?.closest?.('.map-save-btn') as HTMLElement | null
      const itinBtn = t?.closest?.('.map-itin-btn') as HTMLElement | null
      const btn = saveBtn || itinBtn
      if (!btn) return
      e.preventDefault()
      e.stopPropagation()
      const payload = resolvePlacePayload(btn)
      if (!payload) return
      if (itinBtn) {
        if (!onAddToItineraryRef.current) return
        onAddToItineraryRef.current(payload)
        btn.textContent = 'Added ✓'
        btn.setAttribute('disabled', 'true')
        return
      }
      if (!onSavePlaceRef.current) return
      onSavePlaceRef.current(payload)
      btn.textContent = 'Saved ✓'
      btn.setAttribute('disabled', 'true')
    }
    el.current.addEventListener('click', onPopupClick)

    const syncSize = () => { map.invalidateSize({ animate: false }) }
    requestAnimationFrame(syncSize)
    const t1 = window.setTimeout(syncSize, 50)
    const t2 = window.setTimeout(syncSize, 250)

    let ro: ResizeObserver | null = null
    if (wrapRef.current && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => syncSize())
      ro.observe(wrapRef.current)
    }
    window.addEventListener('resize', syncSize)

    return () => {
      el.current?.removeEventListener('click', onPopupClick)
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.removeEventListener('resize', syncSize)
      ro?.disconnect()
      if (watchIdRef.current != null && navigator.geolocation) navigator.geolocation.clearWatch(watchIdRef.current)
      map.remove()
      mapRef.current = null
      layerRef.current = null
      poiLayerRef.current = null
      previewLayerRef.current = null
      userLayerRef.current = null
      markersRef.current = {}
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    let cancelled = false
    layer.clearLayers()
    markersRef.current = {}
    pinMetaRef.current = {}
    const allPts: L.LatLng[] = []
    const newFocusPts: L.LatLng[] = []
    const nextKnown = new Set<string>()

    const addLineCopies = (line: L.LatLng[], style: L.PolylineOptions, popup?: string) => {
      if (line.length < 2) return
      for (const off of WORLD_OFFSETS) {
        const shifted = shiftPath(line, off)
        const pl = L.polyline(shifted, style)
        if (popup) pl.bindPopup(popup)
        pl.addTo(layer)
        if (off === 0) {
          const midIdx = Math.floor(shifted.length / 2)
          arrowAt(shifted[Math.max(0, midIdx - 1)], shifted[midIdx]).addTo(layer)
        }
      }
    }

    segments.forEach(s => {
      const a = L.latLng(s.fromLat, s.fromLng)
      const raw: L.LatLng[] = s.path && s.path.length > 1
        ? s.path.map(p => L.latLng(p.lat, p.lng))
        : [a, L.latLng(s.toLat, s.toLng)]
      const line = unwrapPath(raw)
      const isNew = !knownFocusIdsRef.current.has(`s:${s.id}`)
      nextKnown.add(`s:${s.id}`)
      line.forEach(p => {
        allPts.push(p)
        if (isNew) newFocusPts.push(p)
      })
      addLineCopies(line, { color: s.color || '#F97316', weight: 5, opacity: 0.95 }, s.label)
      const start = line[0] || a
      const end = line[line.length - 1] || L.latLng(s.toLat, unwrapLng(s.toLng, s.fromLng))
      for (const off of WORLD_OFFSETS) {
        const sPos = L.latLng(start.lat, start.lng + off)
        const ePos = L.latLng(end.lat, end.lng + off)
        L.marker(sPos, {
          icon: L.divIcon({ className: 'endpoint-icon', html: `<div class="endpoint-label start">1</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
          zIndexOffset: 1000,
          interactive: off === 0,
        }).bindPopup(s.label).addTo(layer)
        L.marker(ePos, {
          icon: L.divIcon({ className: 'endpoint-icon', html: `<div class="endpoint-label finish">2</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
          zIndexOffset: 1000,
          interactive: off === 0,
        }).bindPopup(s.label).addTo(layer)
      }
    })

    const pinRefLng = pins[0]?.lng ?? 0
    const lang = displayLanguageRef.current || 'en'

    pins.forEach(p => {
      const lng = unwrapLng(p.lng, pinRefLng)
      const isNew = !knownFocusIdsRef.current.has(`p:${p.id}`)
      nextKnown.add(`p:${p.id}`)
      allPts.push(L.latLng(p.lat, lng))
      if (isNew) newFocusPts.push(L.latLng(p.lat, lng))
      const selected = selectedIdRef.current === p.id
      // Primary interactive pin; worldCopyJump handles wrap for markers
      const m = L.marker([p.lat, lng], {
        icon: emojiPinIcon(p.kind, p.number, selected, p.color),
        zIndexOffset: selected ? 800 : 200,
      }).bindPopup(p.label, { maxWidth: 280, className: 'ttl-popup' })
      m.on('click', () => onPinClickRef.current?.(p.id))
      m.addTo(layer)
      markersRef.current[p.id] = m
      pinMetaRef.current[p.id] = { number: p.number, kind: p.kind, name: p.name, savable: p.savable, lat: p.lat, lng: p.lng, color: p.color }
      // Extra visual copies so pin numbers stay visible on adjacent world frames
      for (const off of WORLD_OFFSETS) {
        if (off === 0) continue
        L.marker([p.lat, lng + off], {
          icon: emojiPinIcon(p.kind, p.number, false, p.color),
          zIndexOffset: 150,
          interactive: false,
        }).addTo(layer)
      }
    })

    if (showRoute && pins.length > 1) {
      const routePts = unwrapPath(pins.map(p => L.latLng(p.lat, p.lng)))
      const color = pins[0]?.color || '#1F2937'
      addLineCopies(routePts, { color, weight: 2, dashArray: '6 6', opacity: 0.75 })
    }

    const routeBounds = allPts.length ? L.latLngBounds(allPts) : null
    routeBoundsRef.current = routeBounds
    const focusBounds = newFocusPts.length
      ? L.latLngBounds(newFocusPts)
      : routeBounds
    focusBoundsRef.current = focusBounds
    setHasRoute(!!routeBounds)

    // Only auto-zoom to newly added stops/segments — never jump out to the full multi-day path
    knownFocusIdsRef.current = nextKnown
    if (allPts.length === 0) {
      knownFocusIdsRef.current = new Set()
    } else if (newFocusPts.length > 0) {
      map.invalidateSize({ animate: false })
      const focusBox = L.latLngBounds(newFocusPts)
      const lonSpan = Math.abs(focusBox.getEast() - focusBox.getWest())
      // Bulk load (trip open / day switch with many pins) → stay tight on the first stop
      const bulk = newFocusPts.length >= 3 && lonSpan > 8
      if (bulk || (newFocusPts.length === allPts.length && lonSpan > 8)) {
        map.setView(newFocusPts[newFocusPts.length - 1], 12, { animate: false })
        focusBoundsRef.current = L.latLngBounds([newFocusPts[newFocusPts.length - 1]])
      } else if (newFocusPts.length === 1) {
        map.setView(newFocusPts[0], Math.max(map.getZoom(), 13), { animate: true })
      } else {
        map.fitBounds(focusBox.pad(0.35), { maxZoom: 14, animate: true })
      }
    }

    ;(async () => {
      for (const p of pins) {
        if (cancelled || !p.name) continue
        const display = await translateLabel(p.name, lang)
        if (cancelled || display === p.name) continue
        const m = markersRef.current[p.id]
        if (!m) continue
        m.setPopupContent(buildPinPopup({
          title: p.name,
          displayTitle: display,
          category: p.kind || 'other',
          lat: p.lat,
          lng: p.lng,
          savable: p.savable,
          itinerary: false,
          pinId: p.id,
        }))
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsKey, segmentsKey, showRoute, displayLanguage])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!selectedId) map.closePopup()
    Object.entries(markersRef.current).forEach(([id, m]) => {
      const selected = selectedId === id
      const meta = pinMetaRef.current[id]
      m.setIcon(emojiPinIcon(meta?.kind, meta?.number, selected, meta?.color))
      m.setZIndexOffset(selected ? 800 : 200)
      if (selected) {
        m.openPopup()
        map.panTo(m.getLatLng(), { animate: true })
      }
    })
  }, [selectedId, pinsKey])

  useEffect(() => {
    const map = mapRef.current
    const previewLayer = previewLayerRef.current
    if (!map || !previewLayer) return
    previewLayer.clearLayers()
    if (!previewPin) return
    const marker = L.marker([previewPin.lat, previewPin.lng], {
      icon: previewHotelIcon(true),
      zIndexOffset: 900,
    }).bindPopup(
      `<div class="map-popup"><div class="map-popup-title">🛏️ <b>${previewPin.name.replace(/</g, '&lt;')}</b></div><div class="map-popup-cat">Hotel preview</div></div>`,
      { maxWidth: 240, className: 'ttl-popup' },
    )
    marker.addTo(previewLayer)
    marker.openPopup()
    map.panTo([previewPin.lat, previewPin.lng], { animate: true })
  }, [previewPin?.id, previewPin?.lat, previewPin?.lng, previewPin?.name])

  const centerOnRoute = () => {
    const map = mapRef.current
    let target = focusBoundsRef.current || routeBoundsRef.current
    if (!map || !target || !target.isValid()) return
    // Avoid zooming out across oceans — if the full path is huge, stick to the latest focus
    const span = Math.abs(target.getEast() - target.getWest())
    if (span > 25 && focusBoundsRef.current?.isValid()) {
      target = focusBoundsRef.current
    } else if (span > 25 && routeBoundsRef.current?.isValid()) {
      // Fall back to map center of the route’s last drawn pin cluster
      const c = routeBoundsRef.current.getCenter()
      map.setView(c, 11, { animate: true })
      return
    }
    map.invalidateSize({ animate: false })
    if (target.getNorthEast().equals(target.getSouthWest())) {
      map.setView(target.getCenter(), Math.max(map.getZoom(), 13), { animate: true })
    } else {
      map.fitBounds(target.pad(0.3), { maxZoom: 14, animate: true })
    }
  }

  useEffect(() => {
    const map = mapRef.current
    const poiLayer = poiLayerRef.current
    if (!map || !poiLayer || !enableNearbyPois) return

    let aborted = false
    let timer: number | undefined
    let controller: AbortController | null = null

    const clearPois = () => { poiLayer.clearLayers() }

    const load = () => {
      if (!poisOn) {
        clearPois()
        setPoiStatus('idle')
        setPoiCount(0)
        onPoisLoadedRef.current?.([])
        return
      }
      const zoom = map.getZoom()
      if (zoom < 11) {
        clearPois()
        setPoiStatus('zoom')
        setPoiCount(0)
        return
      }
      const b = map.getBounds()
      // Keep requests small — wide views are slow and noisy
      if (Math.abs(b.getEast() - b.getWest()) > 2.5 || Math.abs(b.getNorth() - b.getSouth()) > 2.5) {
        clearPois()
        setPoiStatus('zoom')
        setPoiCount(0)
        return
      }
      controller?.abort()
      controller = new AbortController()
      const tileKey = [
        zoom,
        b.getSouth().toFixed(2), b.getWest().toFixed(2),
        b.getNorth().toFixed(2), b.getEast().toFixed(2),
      ].join('|')
      const cached = poiCacheByTileRef.current[tileKey]
      const paint = (pois: MapPoi[]) => {
        if (aborted) return
        clearPois()
        poiCacheRef.current = {}
        pois.forEach((p, i) => {
          poiCacheRef.current[p.id] = p
          L.marker([p.lat, p.lng], {
            icon: emojiPinIcon(p.category, undefined, false),
            zIndexOffset: 50 + Math.max(0, 40 - i),
          }).bindPopup(p.label, { maxWidth: 280, className: 'ttl-popup' }).addTo(poiLayer)
        })
        setPoiCount(pois.length)
        setPoiStatus(pois.length ? 'ready' : 'empty')
        onPoisLoadedRef.current?.(pois)

        // Translate popup titles in the background (don't block pins)
        const lang = displayLanguageRef.current || 'en'
        const ctx = placeContextRef.current
        void Promise.all(pois.map(async p => {
          const display = await translateLabel(p.name, lang)
          if (display === p.name) return p
          return { ...p, label: poiLabelWithDisplayName(p, display, ctx) }
        })).then(localized => {
          if (aborted) return
          localized.forEach(p => {
            poiCacheRef.current[p.id] = p
            poiLayer.eachLayer(layer => {
              const marker = layer as L.Marker
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ll = (marker as any).getLatLng?.()
              if (!ll || Math.abs(ll.lat - p.lat) > 1e-5 || Math.abs(ll.lng - p.lng) > 1e-5) return
              marker.setPopupContent?.(p.label)
            })
          })
        })
      }

      if (cached) {
        paint(cached)
        return
      }

      setPoiStatus('loading')
      fetchNearbyPois({
        south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast(),
      }, {
        signal: controller.signal,
        placeContext: placeContextRef.current,
        zoom,
      }).then(pois => {
        if (aborted) return
        poiCacheByTileRef.current[tileKey] = pois
        paint(pois)
      }).catch(err => {
        if (aborted || err?.name === 'AbortError') return
        setPoiStatus('error')
        setPoiCount(0)
      })
    }

    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(load, 280)
    }

    map.on('moveend', schedule)
    map.on('zoomend', schedule)
    schedule()

    return () => {
      aborted = true
      window.clearTimeout(timer)
      controller?.abort()
      map.off('moveend', schedule)
      map.off('zoomend', schedule)
      clearPois()
    }
  }, [enableNearbyPois, poisOn, displayLanguage])

  const stopWatching = () => {
    if (watchIdRef.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    userMarkerRef.current = null
    accuracyRef.current = null
    userLayerRef.current?.clearLayers()
    setLocStatus('off')
  }

  const applyPosition = (pos: GeolocationPosition, fly: boolean) => {
    const map = mapRef.current
    const userLayer = userLayerRef.current
    if (!map || !userLayer) return
    const { latitude, longitude, accuracy } = pos.coords
    const latlng = L.latLng(latitude, longitude)
    if (!userMarkerRef.current) {
      userMarkerRef.current = L.marker(latlng, { icon: userLocationIcon(), zIndexOffset: 1200 })
        .bindPopup('<b>You are here</b>')
        .addTo(userLayer)
    } else userMarkerRef.current.setLatLng(latlng)
    if (!accuracyRef.current) {
      accuracyRef.current = L.circle(latlng, {
        radius: Math.min(accuracy || 40, 400), color: '#3B82F6', fillColor: '#3B82F6', fillOpacity: 0.15, weight: 1,
      }).addTo(userLayer)
    } else {
      accuracyRef.current.setLatLng(latlng)
      accuracyRef.current.setRadius(Math.min(accuracy || 40, 400))
    }
    setLocStatus('on')
    if (fly) map.flyTo(latlng, Math.max(map.getZoom(), 14), { duration: 0.8 })
  }

  const locateMe = () => {
    if (!navigator.geolocation) { alert('Geolocation is not supported in this browser.'); return }
    if (locStatus === 'on' || locStatus === 'pending') { stopWatching(); return }
    setLocStatus('pending')
    navigator.geolocation.getCurrentPosition(
      pos => {
        applyPosition(pos, true)
        watchIdRef.current = navigator.geolocation.watchPosition(p => applyPosition(p, false), () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 })
      },
      err => {
        setLocStatus('denied')
        alert(err.code === 1
          ? 'Location permission was denied. Enable it in your browser settings to see yourself on the map.'
          : 'Could not get your location. Try again outdoors or check device settings.')
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    )
  }

  useEffect(() => {
    if (!showUserLocation) stopWatching()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showUserLocation])

  return (
    <div className="map-stage" ref={wrapRef}>
      <div ref={el} className="map-leaflet-host" />
      <div className="map-toolbar">
        {hasRoute && (
          <button type="button" className="btn-secondary btn-small map-center-route-btn" onClick={centerOnRoute}>
            Center on route
          </button>
        )}
        {showUserLocation && (
          <button type="button" className={`btn-secondary btn-small map-loc-btn${locStatus === 'on' ? ' active' : ''}`} onClick={locateMe} aria-pressed={locStatus === 'on'}>
            {locStatus === 'pending' ? 'Locating…' : locStatus === 'on' ? 'Hide my location' : 'My location'}
          </button>
        )}
        {enableNearbyPois && (
          <>
            <button type="button" className={`btn-secondary btn-small map-poi-toggle${poisOn ? ' active' : ''}`} onClick={() => setPoisOn(v => !v)} aria-pressed={poisOn}>
              {poisOn ? 'Nearby places on' : 'Nearby places off'}
            </button>
            {poisOn && poiStatus === 'zoom' && <span className="map-poi-hint">Zoom in closer to load map pins</span>}
            {poisOn && poiStatus === 'loading' && <span className="map-poi-hint">Loading places…</span>}
            {poisOn && poiStatus === 'ready' && <span className="map-poi-hint">{poiCount} popular places</span>}
            {poisOn && poiStatus === 'empty' && <span className="map-poi-hint">No places found here — try another area</span>}
            {poisOn && poiStatus === 'error' && <span className="map-poi-hint">Couldn’t load places — try again in a moment</span>}
          </>
        )}
      </div>
      {children}
    </div>
  )
}
