/**
 * Parse flight-status screenshots (OAG / Cirium / FlightAware-style cards) via
 * client-side OCR (Tesseract) — no API key.
 */

import { createWorker } from 'tesseract.js'
import { airportByIata, type AirportRef } from './airports'

export interface ParsedFlightScreenshot {
  depIata: string | null
  arrIata: string | null
  depAirport: AirportRef | null
  arrAirport: AirportRef | null
  /** datetime-local strings */
  departure: string | null
  arrival: string | null
  durationMinutes: number | null
  rawText: string
  confidence: number
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

/** Words OCR often misreads as airport codes — skip these. */
const IATA_BLOCKLIST = new Set([
  'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HAD', 'HER',
  'WAS', 'ONE', 'OUR', 'OUT', 'DAY', 'GET', 'HAS', 'HIM', 'HIS', 'HOW', 'MAN',
  'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'BOY', 'DID', 'ITS', 'LET', 'PUT',
  'SAY', 'SHE', 'TOO', 'USE', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN',
  'OCT', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR', 'APR', 'JUN', 'JUL', 'AUG', 'SEP',
  'PM', 'AM', 'UTC', 'GMT', 'EST', 'PST', 'CST', 'MST', 'EDT', 'PDT', 'AGO',
  'GATE', 'TERM', 'SRC', 'APP', 'IOS', 'API', 'PDF', 'PNG', 'JPG', 'OAG',
  'INFO', 'AIR', // fragments of "Airport info"
])

/** City / label hints that map to a preferred hub IATA. */
const CITY_HINTS: { re: RegExp; iata: string }[] = [
  { re: /\bseattle\b/i, iata: 'SEA' },
  { re: /\btacoma\b/i, iata: 'SEA' },
  { re: /\btokyo\b/i, iata: 'HND' },
  { re: /\bhaneda\b/i, iata: 'HND' },
  { re: /\bnarita\b/i, iata: 'NRT' },
  { re: /\bincheon\b/i, iata: 'ICN' },
  { re: /\bseoul\b/i, iata: 'ICN' },
  { re: /\blos angeles\b/i, iata: 'LAX' },
  { re: /\bsan francisco\b/i, iata: 'SFO' },
  { re: /\bnew york\b/i, iata: 'JFK' },
  { re: /\blondon\b/i, iata: 'LHR' },
  { re: /\bparis\b/i, iata: 'CDG' },
  { re: /\bamsterdam\b/i, iata: 'AMS' },
  { re: /\bvancouver\b/i, iata: 'YVR' },
  { re: /\bhonolulu\b/i, iata: 'HNL' },
  { re: /\bportland\b/i, iata: 'PDX' },
]

/** Common OCR misreads of major airport codes. */
const OCR_IATA_FIX: Record<string, string> = {
  UIN: 'SEA', // S→U, E→I on dark cards
  SE4: 'SEA',
  SFA: 'SEA',
  HNO: 'HND',
  HNDD: 'HND',
  TMC: 'HND', // H→T, N→M, D→C on some invert passes
  HMC: 'HND',
  ICN: 'ICN',
  '1CN': 'ICN',
  LHR: 'LHR',
  LH8: 'LHR',
}

const SIZE_SCORE: Record<string, number> = { large: 3, medium: 1, small: 0 }

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function toLocalInput(year: number, month: number, day: number, hour: number, minute: number): string {
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`
}

function parseClock(raw: string): { hour: number; minute: number } | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM|A\.M\.|P\.M\.)?$/i)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  const minute = parseInt(m[2], 10)
  if (minute > 59) return null // reject OCR junk like 3:65
  const ap = (m[3] || '').replace(/\./g, '').toUpperCase()
  if (ap === 'PM' && hour < 12) hour += 12
  if (ap === 'AM' && hour === 12) hour = 0
  if (!ap && hour > 23) return null
  if (hour > 23) return null
  return { hour, minute }
}

function parseMonthDay(raw: string, fallbackYear: number): { year: number; month: number; day: number } | null {
  const withYear = raw.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?\b/)
  if (!withYear) return null
  const month = MONTHS[withYear[1].toLowerCase()]
  if (!month) return null
  const day = parseInt(withYear[2], 10)
  const year = withYear[3] ? parseInt(withYear[3], 10) : fallbackYear
  if (day < 1 || day > 31) return null
  return { year, month, day }
}

function parseDurationMinutes(text: string): number | null {
  const m = text.match(/\b(\d{1,2})\s*h(?:ours?)?\s*(\d{1,2})\s*m(?:in(?:utes?)?)?\b/i)
    || text.match(/\b(\d{1,2})h\s*(\d{1,2})m\b/i)
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

function normalizeCode(raw: string): string {
  const up = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (OCR_IATA_FIX[up] && airportByIata(OCR_IATA_FIX[up])) return OCR_IATA_FIX[up]
  return up
}

function scoreAirport(code: string): number {
  const a = airportByIata(code)
  if (!a) return -1
  return SIZE_SCORE[a.size || ''] || 0
}

function citiesFromText(text: string): string[] {
  const hits: string[] = []
  for (const h of CITY_HINTS) {
    if (h.re.test(text) && !hits.includes(h.iata)) hits.push(h.iata)
  }
  return hits
}

function extractIataPair(text: string): { dep: string; arr: string } | null {
  const upper = text.toUpperCase()

  // Strongest: "SEA » HND" / "SEA → HND" / "SEA - HND" on the route header
  const arrow = upper.match(/\b([A-Z0-9]{3})\s*(?:»|›|>|→|->|—|–|-|TO|➔)\s*([A-Z0-9]{3})\b/)
  if (arrow) {
    const dep = normalizeCode(arrow[1])
    const arr = normalizeCode(arrow[2])
    if (airportByIata(dep) && airportByIata(arr) && dep !== arr) return { dep, arr }
  }

  // City labels on the card (Seattle … Tokyo) — very reliable for Google/OAG cards
  const cityPair = citiesFromText(text)
  if (cityPair.length >= 2) return { dep: cityPair[0], arr: cityPair[1] }

  // Collect candidate IATA codes, prefer large hubs
  const codes: string[] = []
  const re = /\b([A-Z0-9]{3})\b/g
  let match: RegExpExecArray | null
  while ((match = re.exec(upper))) {
    const c = normalizeCode(match[1])
    if (IATA_BLOCKLIST.has(c)) continue
    if (!airportByIata(c)) continue
    if (!codes.includes(c)) codes.push(c)
  }

  if (codes.length >= 2) {
    // Prefer two large airports when present
    const large = codes.filter(c => scoreAirport(c) >= 3)
    if (large.length >= 2) return { dep: large[0], arr: large[1] }
    // Otherwise highest-scored pair in order
    const ranked = [...codes].sort((a, b) => scoreAirport(b) - scoreAirport(a))
    if (scoreAirport(ranked[0]) >= 3 && scoreAirport(ranked[1]) >= 1) {
      // Keep reading order for dep/arr when both are decent
      const first = codes.find(c => scoreAirport(c) >= 1)
      const second = codes.find(c => c !== first && scoreAirport(c) >= 1)
      if (first && second) return { dep: first, arr: second }
    }
    return { dep: codes[0], arr: codes[1] }
  }

  if (cityPair.length === 1 && codes.length >= 1) {
    const other = codes.find(c => c !== cityPair[0])
    if (other) return { dep: cityPair[0], arr: other }
  }

  return null
}

function extractTimes(text: string): string[] {
  const times: string[] = []
  // Allow "12:15PM" with no space (common in OCR)
  const re = /\b(\d{1,2}:\d{2})\s*(AM|PM|A\.M\.|P\.M\.)?\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const stamp = `${m[1]}${m[2] ? ` ${m[2]}` : ''}`
    if (parseClock(stamp)) times.push(stamp.replace(/\s+/g, ' ').trim())
  }
  return times
}

function extractDates(text: string, year: number): { year: number; month: number; day: number }[] {
  const dates: { year: number; month: number; day: number }[] = []
  const re = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const d = parseMonthDay(m[1], year)
    if (d) dates.push(d)
  }
  if (dates.length < 2) {
    const loose = text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)
    for (const hit of loose) {
      const d = parseMonthDay(`${hit[1]} ${hit[2]}`, year)
      if (d && !dates.some(x => x.month === d.month && x.day === d.day)) dates.push(d)
      if (dates.length >= 2) break
    }
  }
  return dates
}

/**
 * Turn OCR text from a flight card into structured fields.
 * @param yearFallback Used when the screenshot omits the year (e.g. trip start year).
 */
export function parseFlightScreenshotText(text: string, yearFallback = new Date().getFullYear()): ParsedFlightScreenshot {
  const cleaned = text.replace(/\u00a0/g, ' ').replace(/[|]/g, ' ')
  const pair = extractIataPair(cleaned)
  const depIata = pair?.dep || null
  const arrIata = pair?.arr || null
  const times = extractTimes(cleaned)
  const dates = extractDates(cleaned, yearFallback)
  const durationMinutes = parseDurationMinutes(cleaned)

  let departure: string | null = null
  let arrival: string | null = null

  const clocks = times.map(parseClock).filter(Boolean) as { hour: number; minute: number }[]

  if (dates[0] && clocks[0]) {
    departure = toLocalInput(dates[0].year, dates[0].month, dates[0].day, clocks[0].hour, clocks[0].minute)
  }
  if (dates[1] && clocks[1]) {
    arrival = toLocalInput(dates[1].year, dates[1].month, dates[1].day, clocks[1].hour, clocks[1].minute)
  } else if (departure && clocks[1] && dates[0]) {
    let y = dates[0].year, mo = dates[0].month, da = dates[0].day
    const depM = clocks[0]!.hour * 60 + clocks[0]!.minute
    const arrM = clocks[1].hour * 60 + clocks[1].minute
    if (arrM <= depM || (durationMinutes != null && durationMinutes >= 8 * 60)) {
      const dt = new Date(y, mo - 1, da)
      dt.setDate(dt.getDate() + 1)
      y = dt.getFullYear(); mo = dt.getMonth() + 1; da = dt.getDate()
    }
    arrival = toLocalInput(y, mo, da, clocks[1].hour, clocks[1].minute)
  } else if (departure && durationMinutes != null) {
    const start = new Date(departure)
    start.setMinutes(start.getMinutes() + durationMinutes)
    arrival = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`
  }

  return {
    depIata,
    arrIata,
    depAirport: airportByIata(depIata),
    arrAirport: airportByIata(arrIata),
    departure,
    arrival,
    durationMinutes,
    rawText: cleaned,
    confidence: [depIata, arrIata, departure, arrival].filter(Boolean).length / 4,
  }
}

function scoreParse(p: ParsedFlightScreenshot): number {
  let s = p.confidence * 10
  if (p.depAirport) s += SIZE_SCORE[p.depAirport.size || ''] || 0
  if (p.arrAirport) s += SIZE_SCORE[p.arrAirport.size || ''] || 0
  if (p.depIata && p.arrIata && p.depIata !== p.arrIata) s += 2
  // Penalize tiny airports when duration looks long-haul
  if (p.durationMinutes != null && p.durationMinutes >= 360) {
    if (p.depAirport?.size === 'small') s -= 3
    if (p.arrAirport?.size === 'small') s -= 3
  }
  return s
}

/** Optional light grayscale — no invert (invert was misreading SEA→UIN, HND→TMC). */
async function toCanvas(file: Blob, mode: 'raw' | 'gray'): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  // Upscale small screenshots for sharper glyphs
  const scale = Math.max(1, Math.min(2, 1200 / Math.max(bitmap.width, 1)))
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  if (mode === 'gray') {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
      // Mild contrast stretch only — keep dark-on-light / light-on-dark readable
      const v = y < 40 ? 0 : y > 220 ? 255 : y
      d[i] = d[i + 1] = d[i + 2] = v
    }
    ctx.putImageData(img, 0, 0)
  }
  bitmap.close()
  return canvas
}

let workerPromise: ReturnType<typeof createWorker> | null = null

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      logger: () => {},
    })
  }
  return workerPromise
}

export async function ocrFlightScreenshot(
  file: Blob,
  yearFallback = new Date().getFullYear(),
): Promise<ParsedFlightScreenshot> {
  const worker = await getWorker()
  // Try original first (best for OAG/Cirium dark cards), then mild grayscale
  const attempts: ParsedFlightScreenshot[] = []
  for (const mode of ['raw', 'gray'] as const) {
    try {
      const canvas = await toCanvas(file, mode)
      const { data } = await worker.recognize(canvas)
      attempts.push(parseFlightScreenshotText(data.text || '', yearFallback))
    } catch {
      /* try next */
    }
  }
  if (!attempts.length) {
    return {
      depIata: null, arrIata: null, depAirport: null, arrAirport: null,
      departure: null, arrival: null, durationMinutes: null, rawText: '', confidence: 0,
    }
  }
  attempts.sort((a, b) => scoreParse(b) - scoreParse(a))
  return attempts[0]
}

/** Quick check for image drag/drop. */
export function isImageFile(file: File | null | undefined): boolean {
  if (!file) return false
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name)
}
