import { supabase, isSupabaseConfigured } from './supabase'
import { newId, type ItinerarySuggestion } from './types'

const LOCAL_SUGGESTIONS = 'travel-log-suggestions-v1'

function loadSuggestions(): ItinerarySuggestion[] {
  try {
    const r = localStorage.getItem(LOCAL_SUGGESTIONS)
    return r ? JSON.parse(r) : []
  } catch {
    return []
  }
}
function saveSuggestions(rows: ItinerarySuggestion[]) {
  localStorage.setItem(LOCAL_SUGGESTIONS, JSON.stringify(rows))
}

export async function listSuggestions(tripId: string): Promise<ItinerarySuggestion[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('itinerary_suggestions')
      .select('*')
      .eq('trip_id', tripId)
      .eq('status', 'suggested')
      .order('created_at', { ascending: false })
    if (error) {
      if (/relation|does not exist/i.test(error.message)) return loadSuggestions().filter(s => s.trip_id === tripId && s.status === 'suggested')
      throw new Error(error.message)
    }
    return data ?? []
  }
  return loadSuggestions().filter(s => s.trip_id === tripId && s.status === 'suggested')
}

export async function updateSuggestionStatus(id: string, status: 'added' | 'dismissed'): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('itinerary_suggestions').update({ status }).eq('id', id)
    if (error && !/relation|does not exist/i.test(error.message)) throw new Error(error.message)
  }
  const all = loadSuggestions()
  const i = all.findIndex(s => s.id === id)
  if (i >= 0) { all[i] = { ...all[i], status }; saveSuggestions(all) }
}

/**
 * Call the suggest-itinerary Edge Function. Falls back to a local gap-fill heuristic
 * when the function / AI key is unavailable so Basic mode still works without Advanced.
 */
export interface SuggestItineraryResult {
  suggestions: ItinerarySuggestion[]
  /** Ordered item ids for non-protected stops; hotels/flights stay anchored. */
  reorder_ids?: string[]
  organization_note?: string
}

export async function requestSuggestStops(tripId: string): Promise<SuggestItineraryResult> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.functions.invoke('suggest-itinerary', { body: { trip_id: tripId } })
    if (!error && data?.suggestions) {
      return {
        suggestions: data.suggestions as ItinerarySuggestion[],
        reorder_ids: Array.isArray(data.reorder_ids) ? data.reorder_ids : undefined,
        organization_note: data.organization_note || undefined,
      }
    }
    if (error && !/FunctionsFetchError|Failed to send|not found|404/i.test(String(error.message || error))) {
      console.warn('suggest-itinerary:', error)
    }
  }
  const suggestions = await localHeuristicSuggestions(tripId)
  return { suggestions }
}

async function localHeuristicSuggestions(tripId: string): Promise<ItinerarySuggestion[]> {
  // Lightweight client fallback — real ranking happens in the Edge Function when GROQ is set
  const rows: ItinerarySuggestion[] = [
    {
      id: newId(),
      trip_id: tripId,
      user_id: '',
      title: 'Local café stop',
      place_name: 'Nearby café',
      lat: null,
      lng: null,
      type: 'restaurant',
      suggested_start: '',
      reason: 'Fill a free gap with a short café break (enable Advanced AI + GROQ_API_KEY for smarter picks).',
      status: 'suggested',
      created_at: new Date().toISOString(),
    },
    {
      id: newId(),
      trip_id: tripId,
      user_id: '',
      title: 'Walking viewpoint',
      place_name: 'Scenic overlook',
      lat: null,
      lng: null,
      type: 'activity',
      suggested_start: '',
      reason: 'A short activity that fits between booked hotels/flights without moving them.',
      status: 'suggested',
      created_at: new Date().toISOString(),
    },
  ]
  const all = loadSuggestions().filter(s => s.trip_id !== tripId || s.status !== 'suggested')
  saveSuggestions([...rows, ...all])
  return rows
}

/** Booking forward address shown in Advanced settings. */
export function bookingForwardAddress(token: string | null | undefined): string {
  const base = (import.meta as any).env?.VITE_BOOKING_GMAIL_USER || 'bookings'
  const domain = 'gmail.com'
  if (!token) return `${base}+(generate-token)@${domain}`
  return `${base}+${token}@${domain}`
}
