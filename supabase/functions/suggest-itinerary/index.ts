/**
 * Suggest restaurants/activities for free-time gaps. Never edits hotels or flights.
 *
 * Deploy: supabase functions deploy suggest-itinerary
 * Secrets: GROQ_API_KEY (or AI_API_KEY); optional GOOGLE_MAPS_API_KEY for Places
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

    const { data: profile } = await admin.from('profiles').select('settings_mode, feature_ai_suggest').eq('id', userData.user.id).single()
    if (profile?.settings_mode !== 'advanced' || !profile?.feature_ai_suggest) {
      return new Response(JSON.stringify({ error: 'Turn on Advanced settings and enable Suggest New Stops' }), { status: 403, headers: cors })
    }

    const { data: trip } = await admin.from('trips').select('*').eq('id', tripId).single()
    if (!trip) return new Response(JSON.stringify({ error: 'Trip not found' }), { status: 404, headers: cors })

    const { data: items } = await admin.from('itinerary_items').select('*').eq('trip_id', tripId).order('sort_order')
    const { data: saved } = await admin.from('saved_places').select('*').eq('user_id', userData.user.id).limit(40)

    // Mark protected items — AI must not touch hotel / airplane transit
    const protectedIds = (items ?? [])
      .filter((i: any) => i.type === 'hotel' || (i.type === 'transit' && /plane|flight|air/i.test(i.mode_of_transport || i.subtype || '')))
      .map((i: any) => i.id)

    const summary = {
      trip: { name: trip.name, place: trip.place, start: trip.start_date, end: trip.end_date, lat: trip.place_lat, lng: trip.place_lng },
      items: (items ?? []).map((i: any) => ({
        id: i.id, type: i.type, title: i.title, place: i.place_name, start: i.start_at, end: i.end_at,
        protected: protectedIds.includes(i.id),
      })),
      saved_places: (saved ?? []).slice(0, 20).map((p: any) => ({ name: p.name, category: p.category, lat: p.lat, lng: p.lng })),
    }

    let suggestions: any[] = []
    try {
      const ai = await chatJson(
        `You suggest trip stops. Return JSON: {"suggestions":[{"title":"","place_name":"","type":"restaurant"|"activity","suggested_start":"ISO or empty","lat":null,"lng":null,"reason":""}]}.
Rules: only restaurant or activity; never change hotels or flights; fill free gaps; max 5 suggestions.`,
        JSON.stringify(summary),
      ) as { suggestions?: any[] }
      suggestions = Array.isArray(ai.suggestions) ? ai.suggestions.slice(0, 5) : []
    } catch (e) {
      // Heuristic fallback without AI key
      suggestions = [
        { title: 'Local lunch spot', place_name: trip.place || 'Nearby restaurant', type: 'restaurant', suggested_start: '', lat: trip.place_lat, lng: trip.place_lng, reason: String(e).includes('GROQ') ? 'AI key missing — generic gap fill.' : 'Café/restaurant gap fill.' },
        { title: 'Neighborhood walk', place_name: trip.place || 'City stroll', type: 'activity', suggested_start: '', lat: trip.place_lat, lng: trip.place_lng, reason: 'Light activity between fixed bookings.' },
      ]
    }

    // Persist; dismiss prior suggested rows for this trip
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

    const { data: inserted, error: insErr } = await admin.from('itinerary_suggestions').insert(rows).select()
    if (insErr) throw insErr

    return new Response(JSON.stringify({ suggestions: inserted ?? [], protected_item_ids: protectedIds }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
