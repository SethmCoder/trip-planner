/**
 * Flight / train lookup for transit planning.
 *
 * Live schedules: optional Aviationstack when VITE_AVIATIONSTACK_KEY is set.
 * Without a key: airport resolve + great-circle duration estimate + Google Flights
 * deep link — no hardcoded sample flight numbers.
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
  /** True when from a live schedule API (not a distance estimate). */
  live?: boolean
}

export interface TransportLookupResult {
  dep: AirportRef | null
  arr: AirportRef | null
  /** Live schedule rows when an API key returns data; otherwise empty. */
  flights: FlightOption[]
  /** Distance-based block time when no live rows — for filling dep/arr fields. */
  estimate?: FlightOption | null
  googleFlights?: string
  googleTransit?: string
  message?: string
  live: boolean
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function parseTimeOnDate(date: string, time: string): string {
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

function estimatedOption(dep: AirportRef, arr: AirportRef, date: string): FlightOption {
  const mins = estimateFlightMinutes({ lat: dep.lat, lng: dep.lng }, { lat: arr.lat, lng: arr.lng })
  const link = googleFlightsUrl(dep.iata, arr.iata, date)
  const departure = `${date.slice(0, 10)}T11:00`
  const arrival = addMinutes(departure, mins)
  return {
    id: `est-${dep.iata}-${arr.iata}`,
    flightNumber: `${dep.iata}→${arr.iata}`,
    airline: 'Duration estimate',
    depIata: dep.iata,
    arrIata: arr.iata,
    departure,
    arrival,
    durationMinutes: mins,
    source: 'Great-circle estimate — verify on Google Flights',
    deepLink: link,
    live: false,
  }
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
          Math.round((+new Date(arrival) - +new Date(departure)) / 60000),
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
          live: true,
        } as FlightOption
      })
  } catch {
    return []
  }
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
      estimate: null,
      live: false,
      message: 'Could not resolve airport codes — try names like “Seattle (SEA)” and “Incheon (ICN)”.',
      googleFlights: dep && arr ? googleFlightsUrl(dep.iata, arr.iata, date) : undefined,
      googleTransit: opts.from && opts.to ? googleTransitUrl(opts.from, opts.to) : undefined,
    }
  }

  const live = await aviationstackFlights(dep.iata, arr.iata, date)
  const estimate = estimatedOption(dep, arr, date)
  const hasKey = !!(import.meta.env.VITE_AVIATIONSTACK_KEY as string | undefined)?.trim()

  if (live.length) {
    return {
      dep,
      arr,
      flights: live,
      estimate,
      live: true,
      googleFlights: googleFlightsUrl(dep.iata, arr.iata, date),
      googleTransit: opts.from && opts.to ? googleTransitUrl(opts.from, opts.to) : undefined,
    }
  }

  return {
    dep,
    arr,
    flights: [],
    estimate,
    live: false,
    googleFlights: estimate.deepLink,
    googleTransit: opts.from && opts.to ? googleTransitUrl(opts.from, opts.to) : undefined,
    message: hasKey
      ? 'No live flights returned for this date — applied a duration estimate. Open Google Flights for real options.'
      : 'No flight API key — applied a duration estimate. Open Google Flights to pick a real flight, then adjust times.',
  }
}

export async function estimateTrainMinutes(from: LatLng, to: LatLng): Promise<{ minutes: number; source: string }> {
  const km = haversineKm(from, to)
  const minutes = Math.max(20, Math.round(km / 90 * 60) + 15)
  return { minutes, source: 'Estimated rail time — check Google Maps Transit for schedules' }
}
