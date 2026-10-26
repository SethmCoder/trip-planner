/**
 * Resolve place names / coords to IATA airport codes (free, no key).
 * Dataset: AirportMiles CC0 dump (OurAirports + Wikidata) — see src/data/airports.json
 */

import airportsData from '../data/airports.json'
import type { LatLng } from './routing'
import { haversineKm } from './routing'

export interface AirportRef {
  iata: string
  name: string
  city: string
  lat: number
  lng: number
  size?: 'large' | 'medium' | 'small'
}

type AirportRow = {
  iata: string
  name: string
  city: string
  lat: number
  lng: number
  size?: 'large' | 'medium' | 'small'
}

const AIRPORTS: AirportRef[] = (airportsData as { airports: AirportRow[] }).airports.map(a => ({
  iata: a.iata,
  name: a.name,
  city: a.city,
  lat: a.lat,
  lng: a.lng,
  size: a.size,
}))

const BY_IATA = new Map(AIRPORTS.map(a => [a.iata, a]))

const SIZE_SCORE: Record<string, number> = { large: 3, medium: 2, small: 1 }

export function airportByIata(iata: string | null | undefined): AirportRef | null {
  if (!iata) return null
  return BY_IATA.get(iata.trim().toUpperCase()) || null
}

export function airportCount(): number {
  return AIRPORTS.length
}

/** Typeahead search by IATA, city, or airport name. Best matches first. */
export function searchAirports(query: string, limit = 12): AirportRef[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return AIRPORTS
      .filter(a => a.size === 'large')
      .slice(0, limit)
  }
  const scored: { a: AirportRef; score: number }[] = []
  for (const a of AIRPORTS) {
    const iata = a.iata.toLowerCase()
    const city = (a.city || '').toLowerCase()
    const name = (a.name || '').toLowerCase()
    let score = 0
    if (iata === q) score = 1000
    else if (iata.startsWith(q)) score = 800
    else if (city === q) score = 700
    else if (city.startsWith(q)) score = 600
    else if (name.startsWith(q)) score = 500
    else if (city.includes(q)) score = 400
    else if (name.includes(q)) score = 300
    else if (iata.includes(q)) score = 200
    else continue
    score += (SIZE_SCORE[a.size || ''] || 0) * 10
    scored.push({ a, score })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored.slice(0, limit).map(s => s.a)
}

export function formatAirportOption(a: AirportRef): string {
  const where = a.city && a.city !== a.name ? `${a.city} — ${a.name}` : a.name
  return `${a.iata} · ${where}`
}

/** Prefer larger airports when several match the same city/name text. */
function bestScored(candidates: AirportRef[]): AirportRef | null {
  if (!candidates.length) return null
  return candidates.reduce((best, a) => {
    const bs = SIZE_SCORE[best.size || ''] || 0
    const as = SIZE_SCORE[a.size || ''] || 0
    return as > bs ? a : best
  })
}

export function resolveAirport(name: string | null | undefined, coords?: LatLng | null): AirportRef | null {
  const raw = (name || '').trim()
  if (!raw && !coords) return null

  // Explicit IATA in the string (SEA, HND, "Tokyo (HND)")
  const codeMatches = [...raw.toUpperCase().matchAll(/\b([A-Z]{3})\b/g)].map(m => m[1])
  for (const code of codeMatches) {
    const hit = BY_IATA.get(code)
    if (hit) return hit
  }

  const lower = raw.toLowerCase()

  if (lower.length >= 2) {
    // Special aliases for multi-airport cities / local names
    if (/haneda|東京国際|羽田/.test(lower)) return BY_IATA.get('HND') || null
    if (/narita|成田/.test(lower)) return BY_IATA.get('NRT') || null
    if (/sea-?tac|tacoma/.test(lower)) return BY_IATA.get('SEA') || null
    if (/heathrow/.test(lower)) return BY_IATA.get('LHR') || null
    if (/incheon|인천/.test(lower)) return BY_IATA.get('ICN') || null
    if (/\bseoul\b|서울/.test(lower) && !/gimpo/.test(lower)) return BY_IATA.get('ICN') || null
    if (/gimpo|김포/.test(lower)) return BY_IATA.get('GMP') || null
    if (/\btokyo\b|東京/.test(lower) && !/narita|成田/.test(lower)) return BY_IATA.get('HND') || null
    if (/\blondon\b/.test(lower) && !/gatwick|stansted|luton|city/.test(lower)) return BY_IATA.get('LHR') || null
    if (/\bparis\b/.test(lower) && !/orly/.test(lower)) return BY_IATA.get('CDG') || null
    if (/\bnew york\b|\bnyc\b/.test(lower) && !/newark|laguardia|lga|ewr/.test(lower)) return BY_IATA.get('JFK') || null

    // Name contains full airport name (strong)
    const nameHits = AIRPORTS.filter(a => lower.includes(a.name.toLowerCase()))
    if (nameHits.length) return bestScored(nameHits)

    // City / municipality match — prefer large hubs
    const cityHits = AIRPORTS.filter(a => {
      const city = a.city.toLowerCase()
      if (city.length < 3) return false
      return lower === city || lower.includes(city) || (lower.length >= 4 && city.includes(lower))
    })
    if (cityHits.length === 1) return cityHits[0]
    if (cityHits.length > 1) {
      const exact = cityHits.filter(a => a.city.toLowerCase() === lower)
      return bestScored(exact.length ? exact : cityHits)
    }
  }

  if (coords) {
    let best: AirportRef | null = null
    let bestScore = -Infinity
    for (const a of AIRPORTS) {
      const km = haversineKm(coords, { lat: a.lat, lng: a.lng })
      if (km > 80) continue
      // Closer + larger wins
      const score = (SIZE_SCORE[a.size || ''] || 0) * 30 - km
      if (score > bestScore) {
        bestScore = score
        best = a
      }
    }
    if (best) return best
  }

  return null
}

export function googleFlightsUrl(depIata: string, arrIata: string, date?: string) {
  const d = date || new Date().toISOString().slice(0, 10)
  return `https://www.google.com/travel/flights?q=Flights%20to%20${encodeURIComponent(arrIata)}%20from%20${encodeURIComponent(depIata)}%20on%20${encodeURIComponent(d)}`
}

export function googleTransitUrl(from: LatLng, to: LatLng) {
  return `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=transit`
}
