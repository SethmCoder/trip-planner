export type BookingStatus = 'not_booked' | 'partially_booked' | 'booked'
export type ItemType = 'transit' | 'hotel' | 'activity' | 'restaurant'
export type DisplayLanguage = 'en' | 'es' | 'fr' | 'de' | 'ja' | 'ko' | 'zh-CN' | 'pt' | 'it'

export type SettingsMode = 'basic' | 'advanced'

export interface Profile {
  id: string
  username: string
  email: string
  avatar_url: string | null
  /** When true, alert when an item's booking window opens. */
  booking_alerts_enabled?: boolean
  /** Language used to display place / item names. */
  preferred_language?: DisplayLanguage | string
  /** Settings panel: Basic vs Advanced (AI/Gmail). */
  settings_mode?: SettingsMode
  /** Advanced: process forwarded booking emails with AI. */
  feature_ai_email?: boolean
  /** Advanced: show Suggest New Stops on trip pages. */
  feature_ai_suggest?: boolean
  /** Unique plus-address token for booking@…+token@gmail.com */
  forwarding_token?: string | null
  /** Notify when overnight award search finds a viable flight. */
  award_alerts_enabled?: boolean
  /** Preferred award booking apps (e.g. roame, google_flights). */
  preferred_booking_apps?: string[]
  /** Google OAuth refresh for Saved Places import (server-side only; client may see connected flag). */
  google_places_connected?: boolean
}

export interface AppNotification {
  id: string
  user_id: string
  title: string
  body: string
  kind: string
  item_id: string | null
  trip_id: string | null
  read: boolean
  created_at: string
}

export const LANGUAGE_OPTIONS: { code: DisplayLanguage; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
]
export interface Stop { name: string; lat?: number; lng?: number }
export interface Trip {
  id: string; user_id: string; name: string; place: string; place_lat: number | null; place_lng: number | null
  start_date: string; end_date: string; major_stops: Stop[]; booking_status: BookingStatus; created_at: string
  /** Destination photo URL resolved from Wikipedia/Wikimedia when a place is set. */
  image_url?: string | null
}
export interface ItineraryItem {
  id: string; trip_id: string; user_id: string; type: ItemType; group_id: string | null; subtype?: string | null
  title: string; place_name: string; lat: number | null; lng: number | null
  from_name: string; from_lat: number | null; from_lng: number | null; to_name: string; to_lat: number | null; to_lng: number | null
  start_at: string; end_at: string; duration_minutes: number | null; mode_of_transport: string
  booking_status: BookingStatus; booking_open_date: string; book_by_date: string; image_url: string; sort_order: number; created_at: string
  confirmation_code?: string | null
  booking_source?: string | null
  source_email_id?: string | null
}

export type FriendshipStatus = 'pending' | 'accepted' | 'declined'
export interface Friendship {
  id: string
  requester_id: string
  addressee_id: string
  status: FriendshipStatus
  created_at: string
  /** Joined for UI */
  other_username?: string
  other_avatar_url?: string | null
}

export interface TripCollaborator {
  id: string
  trip_id: string
  user_id: string
  role: 'editor' | 'viewer'
  created_at: string
  username?: string
}

export interface ItinerarySuggestion {
  id: string
  trip_id: string
  user_id: string
  title: string
  place_name: string
  lat: number | null
  lng: number | null
  type: 'restaurant' | 'activity'
  suggested_start: string
  reason: string
  status: 'suggested' | 'added' | 'dismissed'
  created_at: string
}

export interface AwardSearch {
  id: string
  user_id: string
  origin: string
  destination: string
  date_start: string
  date_end: string
  time_pref: string
  points_min: number
  points_max: number
  preferred_airline: string
  cabin: string
  seats: number
  booking_app: string
  active: boolean
  notify: boolean
  best_summary: string | null
  best_points: number | null
  best_url: string | null
  created_at: string
  updated_at: string
}
/** User bookmark of a map/search place (persisted in localStorage or Supabase). */
export interface SavedPlace {
  id: string
  user_id: string
  name: string
  place_name: string
  lat: number
  lng: number
  category: string
  created_at: string
}
export const newId = () => (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now())
export const fmtDate = (d: string) => d ? new Date(d.length <= 10 ? d + 'T12:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''
export const bookingStatusLabel = (s: BookingStatus) =>
  s === 'booked' ? 'Booked' : s === 'partially_booked' ? 'Partially Booked' : 'Not Booked'
export const tripDurationDays = (start: string, end: string) => {
  if (!start || !end) return null
  const a = new Date(start + 'T12:00:00')
  const b = new Date(end + 'T12:00:00')
  if (Number.isNaN(+a) || Number.isNaN(+b) || b < a) return null
  return Math.round((+b - +a) / 86400000) + 1
}
export const formatDateRange = (start: string, end: string) => {
  if (!start && !end) return 'Dates TBD'
  if (start && end && start === end) return fmtDate(start)
  if (start && end) return `${fmtDate(start)} – ${fmtDate(end)}`
  return fmtDate(start || end)
}
/** Satellite tile thumbnail from the same Esri imagery used on the map (only when coords exist). */
export const destinationThumbUrl = (lat: number, lng: number, zoom = 11) => {
  const n = 2 ** zoom
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`
}
