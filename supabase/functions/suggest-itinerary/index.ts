/**
 * Suggest itinerary: reorder non-protected stops + propose restaurants/activities.
 * Never edits hotels or flights.
 *
 * Deploy: supabase functions deploy suggest-itinerary
 * Secrets: GROQ_API_KEY (or AI_API_KEY)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { chatJson } from '../_shared/ai.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: cors })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const userClient = createClient(supabaseUrl, anon, { global: { headers: { Authorization: authHeader } } })
    const admin = createClient(supabaseUrl, serviceKey)

    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: cors })

    const body = await req.json().catch(() => ({}))
    const tripId = body.trip_id as string
    if (!tripId) return new Response(JSON.stringify({ error: 'trip_id required' }), { status: 400, headers: cors })

    const { data: profile } = await admin.from('profiles').select('settings_mode').eq('id', userData.user.id).single()
    if (profile?.settings_mode !== 'advanced') {
      return new Response(JSON.stringify({ error: 'Turn on Advanced in Settings to use Suggest itinerary' }), { status: 403, headers: cors })
    }

    const { data: trip } = await admin.from('trips').select('*').eq('id', tripId).single()
    if (!trip) return new Response(JSON.stringify({ error: 'Trip not found' }), { status: 404, headers: cors })

    const { data: items } = await admin.from('itinerary_items').select('*').eq('trip_id', tripId).order('sort_order')
    const { data: saved } = await admin.from('saved_places').select('*').eq('user_id', userData.user.id).limit(40)

    const protectedIds = (items ?? [])
      .filter((i: any) => i.type === 'hotel' || (i.type === 'transit' && /plane|flight|air/i.test(i.mode_of_transport || i.subtype || '')))
      .map((i: any) => i.id)

    const movableIds = (items ?? []).filter((i: any) => !protectedIds.includes(i.id)).map((i: any) => i.id)

    const summary = {
      trip: { name: trip.name, place: trip.place, start: trip.start_date, end: trip.end_date, lat: trip.place_lat, lng: trip.place_lng },
      items: (items ?? []).map((i: any) => ({
        id: i.id, type: i.type, title: i.title, place: i.place_name, start: i.start_at, end: i.end_at,
        sort_order: i.sort_order,
        protected: protectedIds.includes(i.id),
      })),
      movable_ids: movableIds,
      saved_places: (saved ?? []).slice(0, 20).map((p: any) => ({
        name: p.name, category: p.category, lat: p.lat, lng: p.lng, place_name: p.place_name,
      })),
    }

    let suggestions: any[] = []
    let reorderIds: string[] = []
    let organizationNote = ''

    try {
      const ai = await chatJson(
        `You organize a trip itinerary using existing items and saved places.
Return JSON:
{
  "organization_note": "short explanation",
  "reorder_ids": ["uuid...", "..."],
  "suggestions":[{"title":"","place_name":"","type":"restaurant"|"activity","suggested_start":"","lat":null,"lng":null,"reason":""}]
}
Rules:
- reorder_ids may only include movable (non-protected) item ids from movable_ids; put them in a sensible geographic/time order.
- Never include hotel or flight ids in reorder_ids; never delete or change hotels/flights.
- Prefer promoting nearby saved_places into suggestions when not already on the trip.
- suggestions: max 5, only restaurant or activity.`,
        JSON.stringify(summary),
      ) as { suggestions?: any[]; reorder_ids?: string[]; organization_note?: string }

      suggestions = Array.isArray(ai.suggestions) ? ai.suggestions.slice(0, 5) : []
      const allowed = new Set(movableIds)
      reorderIds = Array.isArray(ai.reorder_ids)
        ? ai.reorder_ids.filter((id: string) => allowed.has(id))
        : []
      organizationNote = String(ai.organization_note || '').slice(0, 400)
    } catch (e) {
      suggestions = [
        {
          title: 'Local lunch spot',
          place_name: (saved?.[0]?.name) || trip.place || 'Nearby restaurant',
          type: 'restaurant',
          suggested_start: '',
          lat: saved?.[0]?.lat ?? trip.place_lat,
          lng: saved?.[0]?.lng ?? trip.place_lng,
          reason: String(e).includes('GROQ') ? 'AI key missing — add GROQ_API_KEY for smarter plans.' : 'Gap-fill from saved places / destination.',
        },
        {
          title: 'Saved-place stop',
          place_name: saved?.[1]?.name || trip.place || 'Activity',
          type: 'activity',
          suggested_start: '',
          lat: saved?.[1]?.lat ?? trip.place_lat,
          lng: saved?.[1]?.lng ?? trip.place_lng,
          reason: 'Pattern from your saved places between fixed hotels/flights.',
        },
      ]
      reorderIds = movableIds
      organizationNote = 'Heuristic order — deploy suggest-itinerary with GROQ_API_KEY for AI rearranging.'
    }

    await admin.from('itinerary_suggestions').update({ status: 'dismissed' }).eq('trip_id', tripId).eq('status', 'suggested')

    const rows = suggestions
      .filter(s => s.type === 'restaurant' || s.type === 'activity')
      .map(s => ({
        trip_id: tripId,
        user_id: userData.user.id,
        title: String(s.title || 'Suggested stop').slice(0, 120),
        place_name: String(s.place_name || s.title || '').slice(0, 200),
        lat: typeof s.lat === 'number' ? s.lat : trip.place_lat,
        lng: typeof s.lng === 'number' ? s.lng : trip.place_lng,
        type: s.type === 'restaurant' ? 'restaurant' : 'activity',
        suggested_start: s.suggested_start || null,
        reason: String(s.reason || '').slice(0, 500),
        status: 'suggested',
      }))

    const { data: inserted, error: insErr } = rows.length
      ? await admin.from('itinerary_suggestions').insert(rows).select()
      : { data: [], error: null }
    if (insErr) throw insErr

    return new Response(JSON.stringify({
      suggestions: inserted ?? [],
      reorder_ids: reorderIds,
      organization_note: organizationNote,
      protected_item_ids: protectedIds,
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
