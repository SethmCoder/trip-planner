import { supabase, isSupabaseConfigured } from './supabase'
import { newId, type AwardSearch } from './types'

const KEY = 'travel-log-awards-v1'

function loadLocal(): AwardSearch[] {
  try {
    const r = localStorage.getItem(KEY)
    return r ? JSON.parse(r) : []
  } catch {
    return []
  }
}
function saveLocal(rows: AwardSearch[]) { localStorage.setItem(KEY, JSON.stringify(rows)) }

export const BOOKING_APPS = [
  { id: 'roame', label: 'Roame', url: (o: string, d: string, date: string) => `https://www.roame.travel/?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&date=${encodeURIComponent(date)}` },
  { id: 'google_flights', label: 'Google Flights', url: (o: string, d: string, date: string) => `https://www.google.com/travel/flights?q=Flights%20to%20${encodeURIComponent(d)}%20from%20${encodeURIComponent(o)}%20on%20${encodeURIComponent(date)}` },
  { id: 'awardhacker', label: 'AwardHacker', url: (o: string, d: string) => `https://awardhacker.com/?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}` },
  { id: 'seats_aero', label: 'Seats.aero', url: (o: string, d: string) => `https://seats.aero/?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}` },
] as const

export function awardDeepLink(appId: string, origin: string, destination: string, date: string): string {
  const app = BOOKING_APPS.find(a => a.id === appId) || BOOKING_APPS[0]
  return app.url(origin, destination, date || new Date().toISOString().slice(0, 10))
}

export function emptyAwardSearch(userId: string): AwardSearch {
  const today = new Date().toISOString().slice(0, 10)
  return {
    id: newId(),
    user_id: userId,
    origin: '',
    destination: '',
    date_start: today,
    date_end: today,
    time_pref: 'any',
    points_min: 0,
    points_max: 150000,
    preferred_airline: '',
    cabin: 'economy',
    seats: 1,
    booking_app: 'roame',
    active: true,
    notify: true,
    best_summary: null,
    best_points: null,
    best_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

export async function listAwardSearches(userId: string): Promise<AwardSearch[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('award_searches')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) {
      if (/relation|does not exist|award_searches/i.test(error.message)) return loadLocal().filter(s => s.user_id === userId)
      throw new Error(error.message)
    }
    return data ?? []
  }
  return loadLocal().filter(s => s.user_id === userId)
}

export async function saveAwardSearch(search: AwardSearch): Promise<AwardSearch> {
  const row = { ...search, updated_at: new Date().toISOString() }
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('award_searches').upsert(row).select().single()
    if (error) {
      if (/relation|does not exist/i.test(error.message)) {
        const all = loadLocal(); const i = all.findIndex(x => x.id === row.id)
        if (i >= 0) all[i] = row; else all.unshift(row); saveLocal(all); return row
      }
      throw new Error(error.message)
    }
    return data
  }
  const all = loadLocal(); const i = all.findIndex(x => x.id === row.id)
  if (i >= 0) all[i] = row; else all.unshift(row); saveLocal(all); return row
}

export async function deleteAwardSearch(id: string): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('award_searches').delete().eq('id', id)
    if (error && !/relation|does not exist/i.test(error.message)) throw new Error(error.message)
  }
  saveLocal(loadLocal().filter(s => s.id !== id))
}

/** Client-side deep-link / paste path when Seats.aero overnight poll is unavailable. */
export function parseAwardPaste(text: string): { summary: string; points: number | null } | null {
  const t = text.trim()
  if (!t) return null
  const pointsMatch = t.match(/(\d{2,6})\s*(?:pts|points|miles)/i) || t.match(/\b(\d{4,6})\b/)
  const points = pointsMatch ? Number(pointsMatch[1]) : null
  return { summary: t.slice(0, 240), points: Number.isFinite(points) ? points : null }
}
