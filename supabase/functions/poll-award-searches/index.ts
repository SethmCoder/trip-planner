/**
 * Overnight award poll via Seats.aero Partner API when SEATS_AERO_API_KEY is set.
 * Ranks with AI when GROQ_API_KEY present; writes notifications + best result.
 *
 * Cron: e.g. 0 8 * * * (08:00 UTC)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { chatJson } from '../_shared/ai.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function deepLink(app: string, origin: string, dest: string, date: string): string {
  if (app === 'google_flights') {
    return `https://www.google.com/travel/flights?q=Flights%20to%20${encodeURIComponent(dest)}%20from%20${encodeURIComponent(origin)}%20on%20${encodeURIComponent(date)}`
  }
  if (app === 'seats_aero') {
    return `https://seats.aero/?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`
  }
  return `https://www.roame.travel/?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&date=${encodeURIComponent(date)}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)
    const seatsKey = Deno.env.get('SEATS_AERO_API_KEY')

    const { data: searches } = await admin
      .from('award_searches')
      .select('*')
      .eq('active', true)
      .eq('notify', true)

    let updated = 0
    if (!seatsKey) {
      return new Response(JSON.stringify({
        ok: true,
        updated: 0,
        note: 'SEATS_AERO_API_KEY not set — UI deep links / paste only',
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    for (const s of searches ?? []) {
      const url = `https://seats.aero/partnerapi/search?origin_airport=${encodeURIComponent(s.origin)}&destination_airport=${encodeURIComponent(s.destination)}&cabin=${encodeURIComponent(s.cabin || 'economy')}&start_date=${encodeURIComponent(s.date_start || '')}&end_date=${encodeURIComponent(s.date_end || s.date_start || '')}`
      let raw: any = null
      try {
        const res = await fetch(url, { headers: { 'Partner-Authorization': seatsKey, Accept: 'application/json' } })
        if (!res.ok) continue
        raw = await res.json()
      } catch {
        continue
      }

      const candidates = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : raw?.results || []
      let best: { summary: string; points: number | null; deep_link: string } | null = null

      try {
        const ranked = await chatJson(
          `Pick the best award flight matching user prefs. Return JSON: {"viable":true|false,"summary":"","points":0,"reason":""}`,
          JSON.stringify({
            prefs: {
              points_min: s.points_min, points_max: s.points_max,
              airline: s.preferred_airline, cabin: s.cabin, seats: s.seats, time_pref: s.time_pref,
            },
            candidates: candidates.slice(0, 25),
          }),
        ) as any
        if (ranked?.viable) {
          best = {
            summary: String(ranked.summary || 'Award availability found').slice(0, 240),
            points: Number(ranked.points) || null,
            deep_link: deepLink(s.booking_app, s.origin, s.destination, s.date_start),
          }
        }
      } catch {
        const first = candidates[0]
        if (first) {
          const pts = Number(first.miles || first.points || first.Taxes || 0) || null
          if (pts == null || (pts >= s.points_min && pts <= s.points_max)) {
            best = {
              summary: String(first.flight || first.Route || first.airline || 'Seats.aero result').slice(0, 240),
              points: pts,
              deep_link: deepLink(s.booking_app, s.origin, s.destination, s.date_start),
            }
          }
        }
      }

      if (!best) continue

      await admin.from('award_results').insert({
        search_id: s.id,
        summary: best.summary,
        points: best.points,
        airline: s.preferred_airline || null,
        cabin: s.cabin,
        deep_link: best.deep_link,
        raw: { sample: candidates.slice(0, 3) },
      })

      await admin.from('award_searches').update({
        best_summary: best.summary,
        best_points: best.points,
        best_url: best.deep_link,
        updated_at: new Date().toISOString(),
      }).eq('id', s.id)

      const { data: prof } = await admin.from('profiles').select('award_alerts_enabled').eq('id', s.user_id).single()
      if (prof?.award_alerts_enabled !== false) {
        await admin.from('notifications').insert({
          user_id: s.user_id,
          title: 'Award flight alert',
          body: `${s.origin} → ${s.destination}: ${best.summary}${best.points != null ? ` (${best.points} pts)` : ''}`,
          kind: 'award_alert',
          trip_id: null,
          item_id: null,
        })
      }
      updated++
    }

    return new Response(JSON.stringify({ ok: true, updated }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
