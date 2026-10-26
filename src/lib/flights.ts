/**
 * Flight / train lookup for transit planning.
 * Flights: Aviationstack when VITE_AVIATIONSTACK_KEY is set; otherwise estimated
 * options + Google Flights deep link (no scraping of airline sites).
 */

import { resolveAirport, googleFlightsUrl, googleTransitUrl, type AirportRef } from './airports'
import { haversineKm, addMinutes, type LatLng } from './routing'

export interface FlightOption {
  id: string
  flightNumber: string
  airline: string
  depIata: string
  arrIata: string
  /** Local datetime-local value */
  departure: string
  arrival: string
  durationMinutes: number
  source: string
  deepLink?: string
}

export interface TransportLookupResult {
  dep: AirportRef | null
  arr: AirportRef | null
  flights: FlightOption[]
  googleFlights?: string
  googleTransit?: string
  message?: string
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parseTimeOnDate(date: string, time: string): string {
  // time like "14:35:00" or "1435"
  const day = date.slice(0, 10)
  const cleaned = time.replace(/:/g, '')
  if (cleaned.length >= 4) {
    const h = cleaned.slice(0, 2)
    const m = cleaned.slice(2, 4)
    return `${day}T${h}:${m}`
  }
  return `${day}T12:00`
}

/** Estimated block time from great-circle distance. */
export function estimateFlightMinutes(from: LatLng, to: LatLng): number {
  const km = haversineKm(from, to)
  // ~850 km/h cruise + 45 min taxi/climb/descent
  return Math.max(45, Math.round(km / 850 * 60) + 45)
}

/**
 * Known nonstop SEA↔HND style samples used only when no API key is configured,
 * so the UI can still show real flight numbers users recognize.
 */
const SAMPLE_FLIGHTS: Record<string, { flight: string; airline: string; dep: string; arr: string }[]> = {
  'SEA-HND': [
    { flight: 'NH118', airline: 'ANA', dep: '13:15', arr: '15:45+1' },
    { flight: 'DL167', airline: 'Delta', dep: '12:50', arr: '15:20+1' },
    { flight: 'NH116', airline: 'ANA', dep: '17:00', arr: '19:30+1' },
  ],
  'HND-SEA': [
    { flight: 'NH117', airline: 'ANA', dep: '17:45', arr: '10:55' },
    { flight: 'DL166', airline: 'Delta', dep: '16:55', arr: '10:10' },
  ],
  'SEA-NRT': [
    { flight: 'UA875', airline: 'United', dep: '12:20', arr: '14:55+1' },
  ],
  'NRT-SEA': [
    { flight: 'UA876', airline: 'United', dep: '17:05', arr: '10:25' },
  ],
}

function applySampleTime(date: string, hhmm: string): { local: string; dayOffset: number } {
  const plus = hhmm.includes('+1') ? 1 : 0
  const t = hhmm.replace('+1', '')
  const [h, m] = t.split(':').map(Number)
  const d = new Date(`${date.slice(0, 10)}T12:00:00`)
  d.setDate(d.getDate() + plus)
  d.setHours(h, m, 0, 0)
  return { local: toLocalInput(d), dayOffset: plus }
}

async function aviationstackFlights(dep: string, arr: string, date: string): Promise<FlightOption[]> {
  const key = (import.meta.env.VITE_AVIATIONSTACK_KEY as string | undefined)?.trim()
  if (!key) return []
  try {
    const url =
      `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(key)}` +
      `&dep_iata=${encodeURIComponent(dep)}&arr_iata=${encodeURIComponent(arr)}` +
      `&flight_date=${encodeURIComponent(date.slice(0, 10))}&limit=12`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    const rows: any[] = data?.data ?? []
    return rows
      .filter(r => r?.flight?.iata || r?.flight?.number)
      .map((r, i) => {
        const flightNumber = (r.flight?.iata || `${r.airline?.iata || ''}${r.flight?.number || ''}`).replace(/\s/g, '')
        const depTime = r.departure?.scheduled || r.departure?.estimated
        const arrTime = r.arrival?.scheduled || r.arrival?.estimated
        let departure = `${date.slice(0, 10)}T12:00`
        let arrival = departure
        if (depTime) departure = depTime.slice(0, 16)
        else if (r.departure?.timezone) departure = parseTimeOnDate(date, String(r.departure?.scheduled || '12:00'))
        if (arrTime) arrival = arrTime.slice(0, 16)
        const durationMinutes = Math.max(
          30,
          Math.round((+new Date(arrival) - +new Date(departure)) / 60000) || estimateFlightMinutes(
            { lat: 0, lng: 0 },
            { lat: 0, lng: 0 },
          ),
        )
        return {
          id: `avs-${flightNumber}-${i}`,
          flightNumber,
          airline: r.airline?.name || r.airline?.iata || 'Airline',
          depIata: dep,
          arrIata: arr,
          departure,
          arrival,
          durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0
            ? durationMinutes
            : 600,
          source: 'Aviationstack live schedule',
        } as FlightOption
      })
  } catch {
    return []
  }
}

function sampleRouteOptions(dep: AirportRef, arr: AirportRef, date: string): FlightOption[] {
  const key = `${dep.iata}-${arr.iata}`
  const samples = SAMPLE_FLIGHTS[key]
  const mins = estimateFlightMinutes({ lat: dep.lat, lng: dep.lng }, { lat: arr.lat, lng: arr.lng })
  const link = googleFlightsUrl(dep.iata, arr.iata, date)

  if (samples?.length) {
    return samples.map((s, i) => {
      const depT = applySampleTime(date, s.dep)
      let arrLocal: string
      if (s.arr.includes('+')) {
        arrLocal = applySampleTime(date, s.arr).local
      } else {
        // arrival same calendar day or overnight from duration
        const start = new Date(depT.local)
        const end = new Date(addMinutes(depT.local, mins))
        // Prefer published arrival clock when same-day
        const [ah, am] = s.arr.split(':').map(Number)
        end.setHours(ah, am, 0, 0)
        if (end <= start) end.setDate(end.getDate() + 1)
        arrLocal = toLocalInput(end)
      }
      const durationMinutes = Math.max(30, Math.round((+new Date(arrLocal) - +new Date(depT.local)) / 60000))
      return {
        id: `sample-${s.flight}-${i}`,
        flightNumber: s.flight,
        airline: s.airline,
        depIata: dep.iata,
        arrIata: arr.iata,
        departure: depT.local,
        arrival: arrLocal,
        durationMinutes,
        source: 'Typical nonstop (verify times — add Aviationstack key for live data)',
        deepLink: link,
      }
    })
  }

  const departure = `${date.slice(0, 10)}T11:00`
  const arrival = addMinutes(departure, mins)
  return [{
    id: `est-${dep.iata}-${arr.iata}`,
    flightNumber: `${dep.iata}${arr.iata}`,
    airline: 'Estimated nonstop',
    depIata: dep.iata,
    arrIata: arr.iata,
    departure,
    arrival,
    durationMinutes: mins,
    source: 'Great-circle estimate — open Google Flights for real options',
    deepLink: link,
  }]
}

export async function lookupFlights(opts: {
  fromName: string
  toName: string
  from?: LatLng | null
  to?: LatLng | null
  date: string
}): Promise<TransportLookupResult> {
  const dep = resolveAirport(opts.fromName, opts.from)
  const arr = resolveAirport(opts.toName, opts.to)
  const date = opts.date || new Date().toISOString().slice(0, 10)

  if (!dep || !arr) {
    return {
      dep,
      arr,
      flights: [],
      message: 'Could not resolve airport codes — try names like “Seattle (SEA)” and “Haneda (HND)”.',
      googleFlights: dep && arr ? googleFlightsUrl(dep.iata, arr.iata, date) : undefined,
      googleTransit: opts.from && opts.to ? googleTransitUrl(opts.from, opts.to) : undefined,
    }
  }

  const live = await aviationstackFlights(dep.iata, arr.iata, date)
  const flights = live.length ? live : sampleRouteOptions(dep, arr, date)

  return {
    dep,
    arr,
    flights,
    googleFlights: googleFlightsUrl(dep.iata, arr.iata, date),
    googleTransit: opts.from && opts.to ? googleTransitUrl(opts.from, opts.to) : undefined,
    message: live.length
      ? undefined
      : 'Showing typical / estimated flights. Set VITE_AVIATIONSTACK_KEY for live schedules.',
  }
}

export async function estimateTrainMinutes(from: LatLng, to: LatLng): Promise<{ minutes: number; source: string }> {
  const km = haversineKm(from, to)
  // ~90 km/h average including transfers for intercity rail estimate
  const minutes = Math.max(20, Math.round(km / 90 * 60) + 15)
  return { minutes, source: 'Estimated rail time — check Google Maps Transit for schedules' }
}
