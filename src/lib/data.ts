import { supabase, isSupabaseConfigured } from './supabase'
import { newId, type Trip, type ItineraryItem, type Profile, type SavedPlace } from './types'

// ---------- Local (localStorage) fallback store, used only when Supabase is not configured ----------
interface LocalUser extends Profile { password: string }
interface DB { users: LocalUser[]; trips: Trip[]; items: ItineraryItem[]; savedPlaces: SavedPlace[]; sessionUserId: string | null }
const KEY = 'travel-log-db-v2'
function seed(): DB {
  return { users: [], sessionUserId: null, trips: [], items: [], savedPlaces: [] }
}
function load(): DB {
  try {
    const r = localStorage.getItem(KEY)
    if (r) {
      const parsed = JSON.parse(r)
      if (!parsed.savedPlaces) parsed.savedPlaces = []
      return parsed
    }
  } catch {}
  const d = seed(); save(d); return d
}
function save(d: DB) { localStorage.setItem(KEY, JSON.stringify(d)) }
function ensureForwardingToken(): string {
  return (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now()).replace(/-/g, '')
}

export function normalizeProfile(p: Profile | null | undefined): Profile | null {
  if (!p) return null
  const apps = Array.isArray(p.preferred_booking_apps) ? p.preferred_booking_apps : ['roame', 'google_flights']
  return {
    id: p.id,
    username: p.username,
    email: p.email,
    avatar_url: p.avatar_url ?? null,
    booking_alerts_enabled: p.booking_alerts_enabled !== false,
    preferred_language: p.preferred_language || 'en',
    settings_mode: p.settings_mode === 'advanced' ? 'advanced' : 'basic',
    feature_ai_email: Boolean(p.feature_ai_email),
    feature_ai_suggest: Boolean(p.feature_ai_suggest),
    forwarding_token: p.forwarding_token || null,
    award_alerts_enabled: p.award_alerts_enabled !== false,
    preferred_booking_apps: apps,
    google_places_connected: Boolean(p.google_places_connected),
  }
}
const strip = (u: LocalUser): Profile => normalizeProfile(u)!

// ---------- Auth ----------
export async function getSessionProfile(): Promise<Profile | null> {
  if (isSupabaseConfigured && supabase) {
    const { data } = await supabase.auth.getSession(); if (!data.session) return null
    const { data: p } = await supabase.from('profiles').select('*').eq('id', data.session.user.id).single()
    const normalized = normalizeProfile(p)
    if (normalized && !normalized.forwarding_token) {
      try {
        return await regenerateForwardingToken(normalized)
      } catch {
        return { ...normalized, forwarding_token: ensureForwardingToken() }
      }
    }
    return normalized
  }
  const d = load(); const u = d.users.find(x => x.id === d.sessionUserId)
  if (!u) return null
  if (!u.forwarding_token) { u.forwarding_token = ensureForwardingToken(); save(d) }
  return strip(u)
}
export async function login(identifier: string, password: string): Promise<Profile> {
  if (isSupabaseConfigured && supabase) {
    let email = identifier.trim()
    if (!email.includes('@')) { const { data } = await supabase.from('profiles').select('email').eq('username', email).single(); if (!data) throw new Error('User not found'); email = data.email }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password }); if (error) throw new Error(error.message)
    const { data: p } = await supabase.from('profiles').select('*').eq('id', data.user.id).single(); return normalizeProfile(p)!
  }
  const d = load(); const u = d.users.find(x => x.username.toLowerCase() === identifier.trim().toLowerCase() || x.email.toLowerCase() === identifier.trim().toLowerCase())
  if (!u || u.password !== password) throw new Error('Invalid username/email or password')
  d.sessionUserId = u.id; save(d); return strip(u)
}
export async function createAccount(email: string, username: string, password: string): Promise<Profile> {
  if (password.length < 6) throw new Error('Password must be at least 6 characters')
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.auth.signUp({ email, password }); if (error) throw new Error(error.message)
    if (!data.user) throw new Error('Account created — please confirm your email, then log in.')
    const row: Profile = {
      id: data.user.id, email, username, avatar_url: null, booking_alerts_enabled: true, preferred_language: 'en',
      settings_mode: 'basic', feature_ai_email: false, feature_ai_suggest: false,
      forwarding_token: ensureForwardingToken(), award_alerts_enabled: true,
      preferred_booking_apps: ['roame', 'google_flights'], google_places_connected: false,
    }
    const { error: e2 } = await supabase.from('profiles').upsert(row)
    if (e2) {
      if (/booking_alerts|preferred_language|settings_mode|feature_ai|forwarding|award_|preferred_booking|google_places/i.test(e2.message)) {
        const { error: e3 } = await supabase.from('profiles').upsert({ id: data.user.id, email, username, avatar_url: null })
        if (e3) throw new Error(e3.message)
      } else throw new Error(e2.message)
    }
    return normalizeProfile(row)!
  }
  const d = load()
  if (d.users.some(x => x.username.toLowerCase() === username.toLowerCase())) throw new Error('Username already taken')
  if (d.users.some(x => x.email.toLowerCase() === email.toLowerCase())) throw new Error('Email already registered')
  const u: LocalUser = {
    id: newId(), username, email, password, avatar_url: null, booking_alerts_enabled: true, preferred_language: 'en',
    settings_mode: 'basic', feature_ai_email: false, feature_ai_suggest: false,
    forwarding_token: ensureForwardingToken(), award_alerts_enabled: true,
    preferred_booking_apps: ['roame', 'google_flights'], google_places_connected: false,
  }
  d.users.push(u); d.sessionUserId = u.id; save(d); return strip(u)
}
export async function requestPasswordReset(identifier: string): Promise<void> {
  const value = identifier.trim()
  if (!value) throw new Error('Enter your username or email above, then click Forgot password')
  if (isSupabaseConfigured && supabase) {
    let email = value
    if (!email.includes('@')) {
      const { data } = await supabase.from('profiles').select('email').eq('username', email).maybeSingle()
      // Don't reveal whether the account exists — send (or pretend to) either way
      if (!data?.email) return
      email = data.email
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` })
    if (error) throw new Error(error.message)
    return
  }
  throw new Error('Password reset by email is unavailable — no email service is connected')
}
export async function updatePasswordFromRecovery(newPassword: string): Promise<void> {
  if (newPassword.length < 6) throw new Error('Password must be at least 6 characters')
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) throw new Error(error.message)
    return
  }
  throw new Error('Password reset by email is unavailable — no email service is connected')
}
export async function hasRecoverySession(): Promise<boolean> {
  if (isSupabaseConfigured && supabase) {
    if (window.location.hash.includes('type=recovery') || window.location.search.includes('type=recovery')) return true
    const { data } = await supabase.auth.getSession(); return Boolean(data.session)
  }
  return false
}
export async function logout(): Promise<void> {
  // All writes are persisted immediately, so logging out is inherently "saved"; flush local DB once more.
  if (isSupabaseConfigured && supabase) { await supabase.auth.signOut(); return }
  const d = load(); d.sessionUserId = null; save(d)
}
export async function verifyPassword(profile: Profile, password: string): Promise<boolean> {
  if (isSupabaseConfigured && supabase) { const { error } = await supabase.auth.signInWithPassword({ email: profile.email, password }); return !error }
  const d = load(); return d.users.find(x => x.id === profile.id)?.password === password
}
export async function updateProfile(profile: Profile, patch: Partial<Profile> & { newPassword?: string }): Promise<Profile> {
  if (isSupabaseConfigured && supabase) {
    if (patch.newPassword) await supabase.auth.updateUser({ password: patch.newPassword })
    if (patch.email && patch.email !== profile.email) await supabase.auth.updateUser({ email: patch.email })
    const full = {
      username: patch.username ?? profile.username,
      email: patch.email ?? profile.email,
      avatar_url: patch.avatar_url !== undefined ? patch.avatar_url : profile.avatar_url,
      booking_alerts_enabled: patch.booking_alerts_enabled !== undefined ? patch.booking_alerts_enabled : profile.booking_alerts_enabled !== false,
      preferred_language: patch.preferred_language ?? profile.preferred_language ?? 'en',
      settings_mode: patch.settings_mode ?? profile.settings_mode ?? 'basic',
      feature_ai_email: patch.feature_ai_email !== undefined ? patch.feature_ai_email : Boolean(profile.feature_ai_email),
      feature_ai_suggest: patch.feature_ai_suggest !== undefined ? patch.feature_ai_suggest : Boolean(profile.feature_ai_suggest),
      forwarding_token: patch.forwarding_token !== undefined ? patch.forwarding_token : profile.forwarding_token ?? null,
      award_alerts_enabled: patch.award_alerts_enabled !== undefined ? patch.award_alerts_enabled : profile.award_alerts_enabled !== false,
      preferred_booking_apps: patch.preferred_booking_apps ?? profile.preferred_booking_apps ?? ['roame', 'google_flights'],
      google_places_connected: patch.google_places_connected !== undefined ? patch.google_places_connected : Boolean(profile.google_places_connected),
    }
    const { data, error } = await supabase.from('profiles').update(full).eq('id', profile.id).select().single()
    if (error) {
      if (/booking_alerts|preferred_language|settings_mode|feature_ai|forwarding|award_|preferred_booking|google_places/i.test(error.message)) {
        const {
          booking_alerts_enabled, preferred_language, settings_mode, feature_ai_email, feature_ai_suggest,
          forwarding_token, award_alerts_enabled, preferred_booking_apps, google_places_connected, ...rest
        } = full
        const retry = await supabase.from('profiles').update(rest).eq('id', profile.id).select().single()
        if (retry.error) throw new Error(retry.error.message)
        console.warn('Profile prefs columns missing — run the latest supabase/schema.sql')
        return normalizeProfile({
          ...retry.data, booking_alerts_enabled, preferred_language, settings_mode, feature_ai_email,
          feature_ai_suggest, forwarding_token, award_alerts_enabled, preferred_booking_apps, google_places_connected,
        })!
      }
      throw new Error(error.message)
    }
    return normalizeProfile(data)!
  }
  const d = load(); const u = d.users.find(x => x.id === profile.id); if (!u) throw new Error('User not found')
  if (patch.username && d.users.some(x => x.id !== u.id && x.username.toLowerCase() === patch.username!.toLowerCase())) throw new Error('Username already taken')
  Object.assign(u, {
    username: patch.username ?? u.username,
    email: patch.email ?? u.email,
    avatar_url: patch.avatar_url !== undefined ? patch.avatar_url : u.avatar_url,
    booking_alerts_enabled: patch.booking_alerts_enabled !== undefined ? patch.booking_alerts_enabled : u.booking_alerts_enabled !== false,
    preferred_language: patch.preferred_language ?? u.preferred_language ?? 'en',
    settings_mode: patch.settings_mode ?? u.settings_mode ?? 'basic',
    feature_ai_email: patch.feature_ai_email !== undefined ? patch.feature_ai_email : Boolean(u.feature_ai_email),
    feature_ai_suggest: patch.feature_ai_suggest !== undefined ? patch.feature_ai_suggest : Boolean(u.feature_ai_suggest),
    forwarding_token: patch.forwarding_token !== undefined ? patch.forwarding_token : u.forwarding_token ?? ensureForwardingToken(),
    award_alerts_enabled: patch.award_alerts_enabled !== undefined ? patch.award_alerts_enabled : u.award_alerts_enabled !== false,
    preferred_booking_apps: patch.preferred_booking_apps ?? u.preferred_booking_apps ?? ['roame', 'google_flights'],
    google_places_connected: patch.google_places_connected !== undefined ? patch.google_places_connected : Boolean(u.google_places_connected),
  })
  if (patch.newPassword) u.password = patch.newPassword
  save(d); return strip(u)
}

/** Regenerate the plus-address forwarding token used for booking emails. */
export async function regenerateForwardingToken(profile: Profile): Promise<Profile> {
  return updateProfile(profile, { forwarding_token: ensureForwardingToken() })
}
const fileToDataUrl = (file: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(file) })
export async function uploadAvatar(profile: Profile, file: File): Promise<string> {
  if (isSupabaseConfigured && supabase) {
    try {
      const path = `${profile.id}/${Date.now()}-${file.name}`; const { error } = await supabase.storage.from('avatars').upload(path, file, { upsert: true }); if (error) throw error
      return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl
    } catch { return await fileToDataUrl(file) /* avatars bucket not created yet — store inline so the app still works */ }
  }
  return await fileToDataUrl(file)
}

// ---------- Trips / Items ----------
export async function listTrips(userId: string): Promise<Trip[]> {
  if (isSupabaseConfigured && supabase) {
    const { data: owned } = await supabase.from('trips').select('*').eq('user_id', userId).order('start_date')
    let collab: Trip[] = []
    try {
      const { data: links } = await supabase.from('trip_collaborators').select('trip_id').eq('user_id', userId)
      const ids = (links ?? []).map(l => l.trip_id).filter(Boolean)
      if (ids.length) {
        const { data } = await supabase.from('trips').select('*').in('id', ids)
        collab = data ?? []
      }
    } catch { /* table may not exist yet */ }
    const map = new Map<string, Trip>()
    for (const t of [...(owned ?? []), ...collab]) map.set(t.id, t)
    return [...map.values()].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''))
  }
  return load().trips.filter(t => t.user_id === userId).sort((a, b) => a.start_date.localeCompare(b.start_date))
}
export async function getTrip(id: string): Promise<Trip | null> {
  if (isSupabaseConfigured && supabase) { const { data } = await supabase.from('trips').select('*').eq('id', id).single(); return data ?? null }
  return load().trips.find(t => t.id === id) ?? null
}
export async function saveTrip(trip: Trip): Promise<Trip> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('trips').upsert(trip).select().single()
    if (error) {
      // Older schemas may not have image_url yet — save without it rather than failing
      if (/image_url/.test(error.message)) {
        const { image_url, ...rest } = trip
        const retry = await supabase.from('trips').upsert(rest).select().single()
        if (retry.error) throw new Error(retry.error.message)
        console.warn('Saved trip without image_url: run the latest supabase/schema.sql to enable destination photos')
        return { ...retry.data, image_url: image_url ?? null }
      }
      throw new Error(error.message)
    }
    return data
  }
  const d = load(); const i = d.trips.findIndex(t => t.id === trip.id); if (i >= 0) d.trips[i] = trip; else d.trips.push(trip); save(d); return trip
}
export async function deleteTrip(id: string) {
  if (isSupabaseConfigured && supabase) { await supabase.from('trips').delete().eq('id', id); return }
  const d = load(); d.trips = d.trips.filter(t => t.id !== id); d.items = d.items.filter(i => i.trip_id !== id); save(d)
}
const normalizeItem = (i: ItineraryItem): ItineraryItem => ({ ...i, booking_open_date: i.booking_open_date ?? '', book_by_date: i.book_by_date ?? '' })
export async function listItems(tripId: string): Promise<ItineraryItem[]> {
  if (isSupabaseConfigured && supabase) { const { data } = await supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('sort_order'); return (data ?? []).map(normalizeItem) }
  return load().items.filter(i => i.trip_id === tripId).sort((a, b) => a.sort_order - b.sort_order).map(normalizeItem)
}
export async function saveItem(item: ItineraryItem): Promise<ItineraryItem> {
  if (isSupabaseConfigured && supabase) {
    // Empty strings are not valid Postgres dates — send null instead
    const payload = { ...item, booking_open_date: item.booking_open_date || null, book_by_date: item.book_by_date || null }
    const { data, error } = await supabase.from('itinerary_items').upsert(payload).select().single()
    if (error) {
      // Database has not been migrated yet (booking date columns missing) — save without them rather than failing
      if (/booking_open_date|book_by_date/.test(error.message)) {
        const { booking_open_date, book_by_date, ...rest } = payload
        const retry = await supabase.from('itinerary_items').upsert(rest).select().single()
        if (retry.error) throw new Error(retry.error.message)
        console.warn('Saved without booking dates: run the latest supabase/schema.sql to enable them')
        return normalizeItem(retry.data)
      }
      throw new Error(error.message)
    }
    return normalizeItem(data)
  }
  const d = load(); const i = d.items.findIndex(x => x.id === item.id); if (i >= 0) d.items[i] = item; else d.items.push(item); save(d); return item
}
export async function saveItems(items: ItineraryItem[]) { for (const i of items) await saveItem(i) }
export async function deleteItem(id: string) {
  if (isSupabaseConfigured && supabase) { await supabase.from('itinerary_items').delete().eq('id', id); return }
  const d = load(); d.items = d.items.filter(i => i.id !== id); save(d)
}

// ---------- Saved places ----------
export async function listSavedPlaces(userId: string): Promise<SavedPlace[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('saved_places').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    if (error) {
      if (/relation|does not exist|saved_places/i.test(error.message)) return load().savedPlaces.filter(p => p.user_id === userId)
      throw new Error(error.message)
    }
    return data ?? []
  }
  return load().savedPlaces.filter(p => p.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at))
}
export async function saveSavedPlace(place: SavedPlace): Promise<SavedPlace> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('saved_places').upsert(place).select().single()
    if (error) {
      // Fall back to local storage if table not migrated yet
      if (/relation|does not exist|saved_places/i.test(error.message)) {
        const d = load(); const i = d.savedPlaces.findIndex(x => x.id === place.id)
        if (i >= 0) d.savedPlaces[i] = place; else d.savedPlaces.unshift(place); save(d)
        return place
      }
      throw new Error(error.message)
    }
    return data
  }
  const d = load(); const i = d.savedPlaces.findIndex(x => x.id === place.id)
  if (i >= 0) d.savedPlaces[i] = place; else d.savedPlaces.unshift(place); save(d); return place
}
export async function deleteSavedPlace(id: string) {
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('saved_places').delete().eq('id', id)
    if (error && !/relation|does not exist|saved_places/i.test(error.message)) throw new Error(error.message)
  }
  const d = load(); d.savedPlaces = d.savedPlaces.filter(p => p.id !== id); save(d)
}
