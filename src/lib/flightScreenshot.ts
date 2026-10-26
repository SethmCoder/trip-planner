/**
 * Parse flight-status screenshots (Cirium / FlightAware-style cards) via
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
  'GATE', 'TERM', 'SRC', 'APP', 'IOS', 'API', 'PDF', 'PNG', 'JPG',
])

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
  const ap = (m[3] || '').replace(/\./g, '').toUpperCase()
  if (ap === 'PM' && hour < 12) hour += 12
  if (ap === 'AM' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function parseMonthDay(raw: string, fallbackYear: number): { year: number; month: number; day: number } | null {
  // "Mon, Oct 26" / "Oct 26" / "October 26, 2026"
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

function extractIataPair(text: string): { dep: string; arr: string } | null {
  const upper = text.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ')
  const codes: string[] = []
  const re = /\b([A-Z]{3})\b/g
  let match: RegExpExecArray | null
  while ((match = re.exec(upper))) {
    const c = match[1]
    if (IATA_BLOCKLIST.has(c)) continue
    if (airportByIata(c)) codes.push(c)
  }
  // Prefer first two distinct known airports in reading order (dep then arr on card)
  const uniq: string[] = []
  for (const c of codes) {
    if (!uniq.includes(c)) uniq.push(c)
    if (uniq.length >= 2) break
  }
  if (uniq.length >= 2) return { dep: uniq[0], arr: uniq[1] }

  // Explicit "SEA HND" / "SEA → HND" style after normalizing OCR noise
  const arrow = text.toUpperCase().match(/\b([A-Z]{3})\s*(?:→|->|—|-|TO|➔)\s*([A-Z]{3})\b/)
  if (arrow && !IATA_BLOCKLIST.has(arrow[1]) && !IATA_BLOCKLIST.has(arrow[2])) {
    return { dep: arrow[1], arr: arrow[2] }
  }
  return null
}

function extractTimes(text: string): string[] {
  const times: string[] = []
  const re = /\b(\d{1,2}:\d{2}\s*(?:AM|PM|A\.M\.|P\.M\.)?)\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    // Skip duration-like leftovers; keep clock times
    if (parseClock(m[1])) times.push(m[1].replace(/\s+/g, ' ').trim())
  }
  return times
}

function extractDates(text: string, year: number): { year: number; month: number; day: number }[] {
  const dates: { year: number; month: number; day: number }[] = []
  // "Mon, Oct 26" or "Seattle · Mon, Oct 26"
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

  // Prefer first two distinct clock times (dep left, arr right on Cirium cards)
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

/** Boost contrast / invert dark UI cards so Tesseract reads green/white text better. */
async function preprocessForOcr(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    // Luma, then invert dark backgrounds and stretch contrast
    let y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    y = 255 - y
    y = y < 90 ? 0 : y > 160 ? 255 : (y - 90) * (255 / 70)
    d[i] = d[i + 1] = d[i + 2] = y
  }
  ctx.putImageData(img, 0, 0)
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
  const canvas = await preprocessForOcr(file)
  const worker = await getWorker()
  const { data } = await worker.recognize(canvas)
  return parseFlightScreenshotText(data.text || '', yearFallback)
}

/** Quick check for image drag/drop. */
export function isImageFile(file: File | null | undefined): boolean {
  if (!file) return false
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name)
}
