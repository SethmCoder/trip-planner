import { supabase, isSupabaseConfigured } from './supabase'
import { newId, type Friendship, type TripCollaborator, type SavedPlace } from './types'
import { listSavedPlaces } from './data'

const LOCAL_FRIENDS = 'travel-log-friends-v1'
const LOCAL_COLLAB = 'travel-log-collab-v1'
const LOCAL_SHARED = 'travel-log-shared-places-v1'

interface LocalSocial {
  friendships: Friendship[]
  collaborators: TripCollaborator[]
  shared: { id: string; place_id: string; owner_id: string; shared_with_id: string; created_at: string }[]
}

function loadSocial(): LocalSocial {
  try {
    const r = localStorage.getItem(LOCAL_FRIENDS)
    const c = localStorage.getItem(LOCAL_COLLAB)
    const s = localStorage.getItem(LOCAL_SHARED)
    return {
      friendships: r ? JSON.parse(r) : [],
      collaborators: c ? JSON.parse(c) : [],
      shared: s ? JSON.parse(s) : [],
    }
  } catch {
    return { friendships: [], collaborators: [], shared: [] }
  }
}
function saveFriends(f: Friendship[]) { localStorage.setItem(LOCAL_FRIENDS, JSON.stringify(f)) }
function saveCollab(c: TripCollaborator[]) { localStorage.setItem(LOCAL_COLLAB, JSON.stringify(c)) }
function saveShared(s: LocalSocial['shared']) { localStorage.setItem(LOCAL_SHARED, JSON.stringify(s)) }

async function profileByUsername(username: string): Promise<{ id: string; username: string; avatar_url: string | null } | null> {
  if (isSupabaseConfigured && supabase) {
    const { data } = await supabase.from('profiles').select('id, username, avatar_url').ilike('username', username.trim()).maybeSingle()
    return data
  }
  try {
    const raw = localStorage.getItem('travel-log-db-v2')
    if (!raw) return null
    const db = JSON.parse(raw)
    const u = (db.users || []).find((x: any) => x.username.toLowerCase() === username.trim().toLowerCase())
    return u ? { id: u.id, username: u.username, avatar_url: u.avatar_url } : null
  } catch {
    return null
  }
}

async function profilesByIds(ids: string[]): Promise<Record<string, { username: string; avatar_url: string | null }>> {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return {}
  if (isSupabaseConfigured && supabase) {
    const { data } = await supabase.from('profiles').select('id, username, avatar_url').in('id', uniq)
    const map: Record<string, { username: string; avatar_url: string | null }> = {}
    for (const p of data ?? []) map[p.id] = { username: p.username, avatar_url: p.avatar_url }
    return map
  }
  try {
    const raw = localStorage.getItem('travel-log-db-v2')
    const users = raw ? JSON.parse(raw).users || [] : []
    const map: Record<string, { username: string; avatar_url: string | null }> = {}
    for (const u of users) if (uniq.includes(u.id)) map[u.id] = { username: u.username, avatar_url: u.avatar_url }
    return map
  } catch {
    return {}
  }
}

export async function listFriendships(userId: string): Promise<Friendship[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('friendships')
      .select('*')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      .order('created_at', { ascending: false })
    if (error) {
      if (/relation|does not exist|friendships/i.test(error.message)) return decorateLocal(loadSocial().friendships, userId)
      throw new Error(error.message)
    }
    const rows = data ?? []
    const otherIds = rows.map(r => (r.requester_id === userId ? r.addressee_id : r.requester_id))
    const profiles = await profilesByIds(otherIds)
    return rows.map(r => {
      const oid = r.requester_id === userId ? r.addressee_id : r.requester_id
      return { ...r, other_username: profiles[oid]?.username, other_avatar_url: profiles[oid]?.avatar_url ?? null }
    })
  }
  return decorateLocal(loadSocial().friendships.filter(f => f.requester_id === userId || f.addressee_id === userId), userId)
}

async function decorateLocal(rows: Friendship[], userId: string): Promise<Friendship[]> {
  const otherIds = rows.map(r => (r.requester_id === userId ? r.addressee_id : r.requester_id))
  const profiles = await profilesByIds(otherIds)
  return rows.map(r => {
    const oid = r.requester_id === userId ? r.addressee_id : r.requester_id
    return { ...r, other_username: profiles[oid]?.username, other_avatar_url: profiles[oid]?.avatar_url ?? null }
  })
}

export async function sendFriendRequest(fromUserId: string, username: string): Promise<Friendship> {
  const target = await profileByUsername(username)
  if (!target) throw new Error('User not found')
  if (target.id === fromUserId) throw new Error('You cannot friend yourself')
  const row: Friendship = {
    id: newId(),
    requester_id: fromUserId,
    addressee_id: target.id,
    status: 'pending',
    created_at: new Date().toISOString(),
    other_username: target.username,
    other_avatar_url: target.avatar_url,
  }
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('friendships').insert({
      id: row.id, requester_id: row.requester_id, addressee_id: row.addressee_id, status: 'pending',
    }).select().single()
    if (error) {
      if (/duplicate|unique/i.test(error.message)) throw new Error('Friend request already exists')
      if (/relation|does not exist/i.test(error.message)) {
        const s = loadSocial(); s.friendships.unshift(row); saveFriends(s.friendships); return row
      }
      throw new Error(error.message)
    }
    return { ...data, other_username: target.username, other_avatar_url: target.avatar_url }
  }
  const s = loadSocial()
  if (s.friendships.some(f =>
    (f.requester_id === fromUserId && f.addressee_id === target.id) ||
    (f.requester_id === target.id && f.addressee_id === fromUserId),
  )) throw new Error('Friend request already exists')
  s.friendships.unshift(row); saveFriends(s.friendships); return row
}

export async function respondFriendRequest(id: string, accept: boolean): Promise<void> {
  const status = accept ? 'accepted' : 'declined'
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('friendships').update({ status }).eq('id', id)
    if (error && !/relation|does not exist/i.test(error.message)) throw new Error(error.message)
  }
  const s = loadSocial()
  const i = s.friendships.findIndex(f => f.id === id)
  if (i >= 0) { s.friendships[i] = { ...s.friendships[i], status }; saveFriends(s.friendships) }
}

export async function listAcceptedFriends(userId: string): Promise<Friendship[]> {
  return (await listFriendships(userId)).filter(f => f.status === 'accepted')
}

export async function inviteCollaborator(tripId: string, friendUserId: string, role: 'editor' | 'viewer' = 'editor'): Promise<TripCollaborator> {
  const row: TripCollaborator = {
    id: newId(), trip_id: tripId, user_id: friendUserId, role, created_at: new Date().toISOString(),
  }
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('trip_collaborators').upsert({
      trip_id: tripId, user_id: friendUserId, role,
    }, { onConflict: 'trip_id,user_id' }).select().single()
    if (error) {
      if (/relation|does not exist/i.test(error.message)) {
        const s = loadSocial(); s.collaborators.push(row); saveCollab(s.collaborators); return row
      }
      throw new Error(error.message)
    }
    return data
  }
  const s = loadSocial()
  const i = s.collaborators.findIndex(c => c.trip_id === tripId && c.user_id === friendUserId)
  if (i >= 0) s.collaborators[i] = row; else s.collaborators.push(row)
  saveCollab(s.collaborators)
  return row
}

export async function listCollaborators(tripId: string): Promise<TripCollaborator[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('trip_collaborators').select('*').eq('trip_id', tripId)
    if (error) {
      if (/relation|does not exist/i.test(error.message)) return loadSocial().collaborators.filter(c => c.trip_id === tripId)
      throw new Error(error.message)
    }
    const profiles = await profilesByIds((data ?? []).map(c => c.user_id))
    return (data ?? []).map(c => ({ ...c, username: profiles[c.user_id]?.username }))
  }
  const rows = loadSocial().collaborators.filter(c => c.trip_id === tripId)
  const profiles = await profilesByIds(rows.map(c => c.user_id))
  return rows.map(c => ({ ...c, username: profiles[c.user_id]?.username }))
}

export async function shareSavedPlace(placeId: string, ownerId: string, friendUserId: string): Promise<void> {
  const row = { id: newId(), place_id: placeId, owner_id: ownerId, shared_with_id: friendUserId, created_at: new Date().toISOString() }
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('shared_saved_places').upsert({
      place_id: placeId, owner_id: ownerId, shared_with_id: friendUserId,
    }, { onConflict: 'place_id,shared_with_id' })
    if (error && !/relation|does not exist/i.test(error.message)) throw new Error(error.message)
    if (error && /relation|does not exist/i.test(error.message)) {
      const s = loadSocial(); s.shared.push(row); saveShared(s.shared)
    }
    return
  }
  const s = loadSocial(); s.shared.push(row); saveShared(s.shared)
}

export async function listSharedWithMe(userId: string): Promise<SavedPlace[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('shared_saved_places').select('place_id').eq('shared_with_id', userId)
    if (error) {
      if (/relation|does not exist/i.test(error.message)) return localSharedPlaces(userId)
      throw new Error(error.message)
    }
    const ids = (data ?? []).map(r => r.place_id)
    if (!ids.length) return []
    const { data: places } = await supabase.from('saved_places').select('*').in('id', ids)
    return places ?? []
  }
  return localSharedPlaces(userId)
}

async function localSharedPlaces(userId: string): Promise<SavedPlace[]> {
  const s = loadSocial()
  const ids = s.shared.filter(x => x.shared_with_id === userId).map(x => x.place_id)
  const all = await listSavedPlaces('') // won't filter well locally — scan storage
  try {
    const raw = localStorage.getItem('travel-log-db-v2')
    const places: SavedPlace[] = raw ? (JSON.parse(raw).savedPlaces || []) : []
    return places.filter(p => ids.includes(p.id))
  } catch {
    return all.filter(p => ids.includes(p.id))
  }
}
