import { supabase, isSupabaseConfigured } from './supabase'
import { newId, type SavedPlace } from './types'
import { listSavedPlaces } from './data'

export interface PlaceList {
  id: string
  user_id: string
  name: string
  created_at: string
  place_ids?: string[]
  shared?: boolean
}

const KEY = 'travel-log-place-lists-v1'
const SHARE_KEY = 'travel-log-shared-lists-v1'

interface LocalStore {
  lists: PlaceList[]
  items: { list_id: string; place_id: string; sort_order: number }[]
  shares: { id: string; list_id: string; owner_id: string; shared_with_id: string; created_at: string }[]
}

function load(): LocalStore {
  try {
    const a = localStorage.getItem(KEY)
    const b = localStorage.getItem(SHARE_KEY)
    const parsed = a ? JSON.parse(a) : { lists: [], items: [] }
    return { lists: parsed.lists || [], items: parsed.items || [], shares: b ? JSON.parse(b) : [] }
  } catch {
    return { lists: [], items: [], shares: [] }
  }
}
function save(s: LocalStore) {
  localStorage.setItem(KEY, JSON.stringify({ lists: s.lists, items: s.items }))
  localStorage.setItem(SHARE_KEY, JSON.stringify(s.shares))
}

export async function listPlaceLists(userId: string): Promise<PlaceList[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('saved_place_lists')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) {
      if (/relation|does not exist/i.test(error.message)) return localOwned(userId)
      throw new Error(error.message)
    }
    const lists = data ?? []
    const withItems: PlaceList[] = []
    for (const l of lists) {
      const { data: items } = await supabase
        .from('saved_place_list_items')
        .select('place_id')
        .eq('list_id', l.id)
        .order('sort_order')
      withItems.push({ ...l, place_ids: (items ?? []).map(i => i.place_id), shared: false })
    }
    return withItems
  }
  return localOwned(userId)
}

function localOwned(userId: string): PlaceList[] {
  const s = load()
  return s.lists
    .filter(l => l.user_id === userId)
    .map(l => ({
      ...l,
      place_ids: s.items.filter(i => i.list_id === l.id).sort((a, b) => a.sort_order - b.sort_order).map(i => i.place_id),
      shared: false,
    }))
}

export async function createPlaceList(userId: string, name: string): Promise<PlaceList> {
  const row: PlaceList = {
    id: newId(),
    user_id: userId,
    name: name.trim() || 'Untitled list',
    created_at: new Date().toISOString(),
    place_ids: [],
  }
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.from('saved_place_lists').insert({
      id: row.id, user_id: userId, name: row.name,
    }).select().single()
    if (error) {
      if (/relation|does not exist/i.test(error.message)) {
        const s = load(); s.lists.unshift(row); save(s); return row
      }
      throw new Error(error.message)
    }
    return { ...data, place_ids: [], shared: false }
  }
  const s = load(); s.lists.unshift(row); save(s); return row
}

export async function deletePlaceList(id: string): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('saved_place_lists').delete().eq('id', id)
    if (error && !/relation|does not exist/i.test(error.message)) throw new Error(error.message)
  }
  const s = load()
  s.lists = s.lists.filter(l => l.id !== id)
  s.items = s.items.filter(i => i.list_id !== id)
  s.shares = s.shares.filter(x => x.list_id !== id)
  save(s)
}

export async function addPlaceToList(listId: string, placeId: string): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('saved_place_list_items').upsert({
      list_id: listId, place_id: placeId, sort_order: Date.now() % 100000,
    }, { onConflict: 'list_id,place_id' })
    if (error) {
      if (/relation|does not exist/i.test(error.message)) {
        const s = load()
        if (!s.items.some(i => i.list_id === listId && i.place_id === placeId)) {
          s.items.push({ list_id: listId, place_id: placeId, sort_order: s.items.length })
          save(s)
        }
        return
      }
      throw new Error(error.message)
    }
    return
  }
  const s = load()
  if (!s.items.some(i => i.list_id === listId && i.place_id === placeId)) {
    s.items.push({ list_id: listId, place_id: placeId, sort_order: s.items.length })
    save(s)
  }
}

export async function removePlaceFromList(listId: string, placeId: string): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('saved_place_list_items').delete().eq('list_id', listId).eq('place_id', placeId)
    if (error && !/relation|does not exist/i.test(error.message)) throw new Error(error.message)
  }
  const s = load()
  s.items = s.items.filter(i => !(i.list_id === listId && i.place_id === placeId))
  save(s)
}

export async function sharePlaceList(listId: string, ownerId: string, friendUserId: string): Promise<void> {
  const row = { id: newId(), list_id: listId, owner_id: ownerId, shared_with_id: friendUserId, created_at: new Date().toISOString() }
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('shared_saved_lists').upsert({
      list_id: listId, owner_id: ownerId, shared_with_id: friendUserId,
    }, { onConflict: 'list_id,shared_with_id' })
    if (error) {
      if (/relation|does not exist/i.test(error.message)) {
        const s = load(); s.shares.push(row); save(s); return
      }
      throw new Error(error.message)
    }
    return
  }
  const s = load(); s.shares.push(row); save(s)
}

export async function listSharedWithMe(userId: string): Promise<PlaceList[]> {
  if (isSupabaseConfigured && supabase) {
    const { data: shares, error } = await supabase
      .from('shared_saved_lists')
      .select('list_id')
      .eq('shared_with_id', userId)
    if (error) {
      if (/relation|does not exist/i.test(error.message)) return localShared(userId)
      throw new Error(error.message)
    }
    const ids = (shares ?? []).map(s => s.list_id)
    if (!ids.length) return []
    const { data: lists } = await supabase.from('saved_place_lists').select('*').in('id', ids)
    const out: PlaceList[] = []
    for (const l of lists ?? []) {
      const { data: items } = await supabase.from('saved_place_list_items').select('place_id').eq('list_id', l.id).order('sort_order')
      out.push({ ...l, place_ids: (items ?? []).map(i => i.place_id), shared: true })
    }
    return out
  }
  return localShared(userId)
}

function localShared(userId: string): PlaceList[] {
  const s = load()
  const ids = s.shares.filter(x => x.shared_with_id === userId).map(x => x.list_id)
  return s.lists
    .filter(l => ids.includes(l.id))
    .map(l => ({
      ...l,
      place_ids: s.items.filter(i => i.list_id === l.id).map(i => i.place_id),
      shared: true,
    }))
}

export async function placesForList(list: PlaceList, userId: string): Promise<SavedPlace[]> {
  const ids = list.place_ids || []
  if (!ids.length) return []
  if (isSupabaseConfigured && supabase) {
    const { data } = await supabase.from('saved_places').select('*').in('id', ids)
    const map = new Map((data ?? []).map(p => [p.id, p]))
    return ids.map(id => map.get(id)).filter(Boolean) as SavedPlace[]
  }
  const all = await listSavedPlaces(userId)
  // Also scan local DB for places owned by others (shared lists)
  try {
    const raw = localStorage.getItem('travel-log-db-v2')
    const places: SavedPlace[] = raw ? (JSON.parse(raw).savedPlaces || []) : all
    return ids.map(id => places.find(p => p.id === id)).filter(Boolean) as SavedPlace[]
  } catch {
    return all.filter(p => ids.includes(p.id))
  }
}
