/** Resolve place names / coords to IATA airport codes (free, no key). */

import type { LatLng } from './routing'
import { haversineKm } from './routing'

export interface AirportRef {
  iata: string
  name: string
  city: string
  lat: number
  lng: number
}

/** Common airports (incl. SEA / HND) for fast local resolve. */
const AIRPORTS: AirportRef[] = [
  { iata: 'SEA', name: 'Seattle-Tacoma International', city: 'Seattle', lat: 47.4502, lng: -122.3088 },
  { iata: 'HND', name: 'Tokyo Haneda', city: 'Tokyo', lat: 35.5494, lng: 139.7798 },
  { iata: 'NRT', name: 'Narita International', city: 'Tokyo', lat: 35.7720, lng: 140.3929 },
  { iata: 'LAX', name: 'Los Angeles International', city: 'Los Angeles', lat: 33.9425, lng: -118.4081 },
  { iata: 'SFO', name: 'San Francisco International', city: 'San Francisco', lat: 37.6213, lng: -122.3790 },
  { iata: 'JFK', name: 'John F. Kennedy International', city: 'New York', lat: 40.6413, lng: -73.7781 },
  { iata: 'EWR', name: 'Newark Liberty International', city: 'Newark', lat: 40.6895, lng: -74.1745 },
  { iata: 'ORD', name: "O'Hare International", city: 'Chicago', lat: 41.9742, lng: -87.9073 },
  { iata: 'DFW', name: 'Dallas/Fort Worth International', city: 'Dallas', lat: 32.8998, lng: -97.0403 },
  { iata: 'ATL', name: 'Hartsfield-Jackson Atlanta', city: 'Atlanta', lat: 33.6407, lng: -84.4277 },
  { iata: 'BOS', name: 'Logan International', city: 'Boston', lat: 42.3656, lng: -71.0096 },
  { iata: 'LHR', name: 'London Heathrow', city: 'London', lat: 51.4700, lng: -0.4543 },
  { iata: 'CDG', name: 'Paris Charles de Gaulle', city: 'Paris', lat: 49.0097, lng: 2.5479 },
  { iata: 'FRA', name: 'Frankfurt Airport', city: 'Frankfurt', lat: 50.0379, lng: 8.5622 },
  { iata: 'AMS', name: 'Amsterdam Schiphol', city: 'Amsterdam', lat: 52.3105, lng: 4.7683 },
  { iata: 'ICN', name: 'Incheon International', city: 'Seoul', lat: 37.4602, lng: 126.4407 },
  { iata: 'GMP', name: 'Gimpo International', city: 'Seoul', lat: 37.5583, lng: 126.7906 },
  { iata: 'PEK', name: 'Beijing Capital', city: 'Beijing', lat: 40.0799, lng: 116.6031 },
  { iata: 'PVG', name: 'Shanghai Pudong', city: 'Shanghai', lat: 31.1443, lng: 121.8083 },
  { iata: 'HKG', name: 'Hong Kong International', city: 'Hong Kong', lat: 22.3080, lng: 113.9185 },
  { iata: 'SIN', name: 'Singapore Changi', city: 'Singapore', lat: 1.3644, lng: 103.9915 },
  { iata: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', lat: 13.6900, lng: 100.7501 },
  { iata: 'SYD', name: 'Sydney Kingsford Smith', city: 'Sydney', lat: -33.9399, lng: 151.1753 },
  { iata: 'MEL', name: 'Melbourne Airport', city: 'Melbourne', lat: -37.6690, lng: 144.8410 },
  { iata: 'YVR', name: 'Vancouver International', city: 'Vancouver', lat: 49.1967, lng: -123.1815 },
  { iata: 'YYZ', name: 'Toronto Pearson', city: 'Toronto', lat: 43.6777, lng: -79.6248 },
  { iata: 'DXB', name: 'Dubai International', city: 'Dubai', lat: 25.2532, lng: 55.3657 },
  { iata: 'DOH', name: 'Hamad International', city: 'Doha', lat: 25.2731, lng: 51.6081 },
  { iata: 'KIX', name: 'Kansai International', city: 'Osaka', lat: 34.4347, lng: 135.2440 },
  { iata: 'ITM', name: 'Osaka Itami', city: 'Osaka', lat: 34.7855, lng: 135.4382 },
  { iata: 'CTS', name: 'New Chitose', city: 'Sapporo', lat: 42.7752, lng: 141.6925 },
  { iata: 'FUK', name: 'Fukuoka Airport', city: 'Fukuoka', lat: 33.5859, lng: 130.4507 },
  { iata: 'OKA', name: 'Naha Airport', city: 'Okinawa', lat: 26.1958, lng: 127.6458 },
  { iata: 'NGO', name: 'Chubu Centrair', city: 'Nagoya', lat: 34.8584, lng: 136.8054 },
  { iata: 'HNL', name: 'Daniel K. Inouye International', city: 'Honolulu', lat: 21.3245, lng: -157.9251 },
  { iata: 'PDX', name: 'Portland International', city: 'Portland', lat: 45.5898, lng: -122.5951 },
  { iata: 'SAN', name: 'San Diego International', city: 'San Diego', lat: 32.7336, lng: -117.1897 },
  { iata: 'LAS', name: 'Harry Reid International', city: 'Las Vegas', lat: 36.0840, lng: -115.1537 },
  { iata: 'DEN', name: 'Denver International', city: 'Denver', lat: 39.8561, lng: -104.6737 },
  { iata: 'MIA', name: 'Miami International', city: 'Miami', lat: 25.7959, lng: -80.2870 },
  { iata: 'IAH', name: 'George Bush Intercontinental', city: 'Houston', lat: 29.9902, lng: -95.3368 },
  { iata: 'PHX', name: 'Phoenix Sky Harbor', city: 'Phoenix', lat: 33.4373, lng: -112.0078 },
  { iata: 'MSP', name: 'Minneapolis–Saint Paul', city: 'Minneapolis', lat: 44.8848, lng: -93.2223 },
  { iata: 'DTW', name: 'Detroit Metro', city: 'Detroit', lat: 42.2162, lng: -83.3554 },
  { iata: 'SLC', name: 'Salt Lake City International', city: 'Salt Lake City', lat: 40.7899, lng: -111.9791 },
]

const BY_IATA = new Map(AIRPORTS.map(a => [a.iata, a]))

export function resolveAirport(name: string | null | undefined, coords?: LatLng | null): AirportRef | null {
  const raw = (name || '').trim()
  if (!raw && !coords) return null

  // Explicit IATA in the string (SEA, HND, "Tokyo (HND)")
  const codeMatch = raw.toUpperCase().match(/\b([A-Z]{3})\b/)
  if (codeMatch && BY_IATA.has(codeMatch[1])) return BY_IATA.get(codeMatch[1])!

  const lower = raw.toLowerCase()
  for (const a of AIRPORTS) {
    if (
      lower.includes(a.iata.toLowerCase()) ||
      lower.includes(a.city.toLowerCase()) ||
      lower.includes(a.name.toLowerCase().split(' ')[0].toLowerCase())
    ) {
      // Prefer city hits that aren't too generic unless coords confirm
      if (lower.includes(a.city.toLowerCase()) || lower.includes(a.iata.toLowerCase())) return a
    }
  }

  // Special aliases
  if (/haneda|東京国際|羽田/.test(lower)) return BY_IATA.get('HND')!
  if (/narita|成田/.test(lower)) return BY_IATA.get('NRT')!
  if (/sea-?tac|tacoma/.test(lower)) return BY_IATA.get('SEA')!
  if (/heathrow/.test(lower)) return BY_IATA.get('LHR')!
  if (/incheon/.test(lower)) return BY_IATA.get('ICN')!

  if (coords) {
    let best: AirportRef | null = null
    let bestKm = Infinity
    for (const a of AIRPORTS) {
      const km = haversineKm(coords, { lat: a.lat, lng: a.lng })
      if (km < bestKm) { bestKm = km; best = a }
    }
    if (best && bestKm < 80) return best
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
