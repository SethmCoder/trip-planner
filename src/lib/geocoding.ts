import { placePrimary, placeSecondary, shortAddress } from './formatPlace'
import { googlePlacesSearch, isGoogleMapsEnabled } from './googleConfig'

export interface GeoResult {
  name: string
  display: string
  lat: number
  lng: number
  /** Short secondary line for search UI (city, country). */
  detail?: string
}

export interface SearchPlacesOpts {
  /** Bias results toward this location (trip destination). */
  near?: { lat: number; lng: number } | null
  limit?: number
}

export async function searchPlaces(q: string, opts: SearchPlacesOpts = {}): Promise<GeoResult[]> {
  const query = q.trim()
  if (!query) return []
  const limit = opts.limit ?? 7

  if (isGoogleMapsEnabled()) {
    try {
      const near = opts.near ? { lat: opts.near.lat, lng: opts.near.lng } : undefined
      const google = await googlePlacesSearch(query, near)
      if (google.length) {
        return dedupeResults(
          google.slice(0, limit).map(g => ({
            name: g.name,
            display: g.address ? `${g.name}, ${g.address}` : g.name,
            detail: g.address,
            lat: g.lat,
            lng: g.lng,
          })),
        )
      }
    } catch {
      /* fall through to Nominatim */
    }
  }

  try {
    const params = new URLSearchParams({
      format: 'json',
      addressdetails: '1',
      limit: String(limit),
      q: query,
    })
    if (opts.near) {
      const { lat, lng } = opts.near
      const pad = 0.35
      params.set('viewbox', `${lng - pad},${lat + pad},${lng + pad},${lat - pad}`)
      params.set('bounded', '0')
    }
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { Accept: 'application/json' },
    })
    const j = await r.json()
    const mapped: GeoResult[] = (j as any[]).map(x => {
      const primary = primaryFromNominatim(x)
      const detail = detailFromNominatim(x)
      return {
        name: primary,
        display: detail ? `${primary}, ${detail}` : primary,
        detail,
        lat: parseFloat(x.lat),
        lng: parseFloat(x.lon),
      }
    })
    return dedupeResults(mapped)
  } catch {
    return []
  }
}

function primaryFromNominatim(x: any): string {
  const a = x.address || {}
  const named =
    a.tourism ||
    a.amenity ||
    a.leisure ||
    a.historic ||
    a.railway ||
    a.aeroway ||
    a.building ||
    a.shop ||
    a.attraction ||
    a.hotel ||
    a.museum ||
    a.park ||
    a.natural ||
    a.road ||
    a.hamlet ||
    a.village ||
    a.town ||
    a.city ||
    a.municipality ||
    a.county
  if (named) return shortAddress(String(named), 1) || String(named)
  const first = String(x.display_name || '').split(',')[0]?.trim()
  return placePrimary(first || x.display_name) || 'Place'
}

function detailFromNominatim(x: any): string {
  const a = x.address || {}
  const city = a.city || a.town || a.village || a.municipality || a.suburb || a.county || a.state
  const country = a.country
  const parts = [city, country].filter(Boolean).map(String)
  if (parts.length) return placeSecondary(parts.join(', ')) || parts.join(', ')
  return placeSecondary(x.display_name) || shortAddress(x.display_name, 2)
}

function dedupeResults(list: GeoResult[]): GeoResult[] {
  const seen = new Set<string>()
  const out: GeoResult[] = []
  for (const r of list) {
    const key = `${r.name.toLowerCase()}|${r.lat.toFixed(3)}|${r.lng.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}
