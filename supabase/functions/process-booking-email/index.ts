/**
 * Redact + AI-extract a stored inbound email; match or create itinerary items.
 * Invoked by poll-gmail-inbox (service role) or manually with { inbound_email_id }.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { chatJson, redactBookingText } from '../_shared/ai.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)
    const body = await req.json()
    const inboundId = body.inbound_email_id as string
    if (!inboundId) return new Response(JSON.stringify({ error: 'inbound_email_id required' }), { status: 400, headers: cors })

    const { data: email, error } = await admin.from('inbound_emails').select('*').eq('id', inboundId).single()
    if (error || !email) throw error || new Error('Email not found')

    const redacted = redactBookingText(email.redacted_body || body.raw_body || '')
    await admin.from('inbound_emails').update({ redacted_body: redacted, status: 'processing' }).eq('id', inboundId)

    const { data: profile } = await admin.from('profiles').select('*').eq('id', email.user_id).single()
    if (profile?.settings_mode !== 'advanced' || !profile?.feature_ai_email) {
      await admin.from('inbound_emails').update({ status: 'skipped', error: 'advanced or feature_ai_email off' }).eq('id', inboundId)
      return new Response(JSON.stringify({ skipped: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const { data: items } = await admin.from('itinerary_items').select('*').eq('user_id', email.user_id)
    const { data: trips } = await admin.from('trips').select('id, name, place, start_date, end_date').eq('user_id', email.user_id)

    let extracted: any = {}
    try {
      extracted = await chatJson(
        `Extract booking details from redacted email text. Return JSON:
{"type":"flight"|"hotel"|"other","confirmation_code":"","title":"","place_name":"","from_name":"","to_name":"","start_at":"","end_at":"","booking_status":"booked","confidence":0-1,"match_item_id":null,"trip_id":null}
Use confirmation codes as tokens only (already may be present). Prefer matching an existing item id from the list when obvious.`,
        JSON.stringify({ subject: email.subject, body: redacted, items: items ?? [], trips: trips ?? [] }),
      )
    } catch (e) {
      await admin.from('inbound_emails').update({ status: 'error', error: String(e) }).eq('id', inboundId)
      throw e
    }

    const confidence = Number(extracted.confidence ?? 0)
    let action = 'none'
    let itemId: string | null = extracted.match_item_id || null
    let tripId: string | null = extracted.trip_id || null

    const patch: Record<string, unknown> = {}
    if (extracted.confirmation_code) patch.confirmation_code = String(extracted.confirmation_code).slice(0, 64)
    if (extracted.start_at) patch.start_at = extracted.start_at
    if (extracted.end_at) patch.end_at = extracted.end_at
    if (extracted.booking_status) patch.booking_status = extracted.booking_status
    if (extracted.title) patch.title = String(extracted.title).slice(0, 200)
    if (extracted.place_name) patch.place_name = String(extracted.place_name).slice(0, 200)
    if (extracted.from_name) patch.from_name = String(extracted.from_name).slice(0, 200)
    if (extracted.to_name) patch.to_name = String(extracted.to_name).slice(0, 200)
    patch.booking_source = 'email'
    patch.source_email_id = inboundId

    if (itemId && confidence >= 0.7) {
      const existing = (items ?? []).find((i: any) => i.id === itemId)
      if (existing) {
        // Never auto-delete; only update fields
        await admin.from('itinerary_items').update(patch).eq('id', itemId)
        action = 'updated'
        tripId = existing.trip_id
      }
    } else if (confidence >= 0.75 && tripId) {
      const type = extracted.type === 'hotel' ? 'hotel' : extracted.type === 'flight' ? 'transit' : 'activity'
      const { data: created } = await admin.from('itinerary_items').insert({
        trip_id: tripId,
        user_id: email.user_id,
        type,
        subtype: extracted.type === 'flight' ? 'flight' : null,
        title: patch.title || email.subject || 'Booked item',
        place_name: patch.place_name || '',
        from_name: patch.from_name || '',
        to_name: patch.to_name || '',
        start_at: patch.start_at || null,
        end_at: patch.end_at || null,
        booking_status: 'booked',
        confirmation_code: patch.confirmation_code || null,
        booking_source: 'email',
        source_email_id: inboundId,
        mode_of_transport: extracted.type === 'flight' ? 'Airplane' : '',
        sort_order: 999,
      }).select().single()
      itemId = created?.id ?? null
      action = 'created'
    }

    await admin.from('booking_email_matches').insert({
      inbound_email_id: inboundId,
      item_id: itemId,
      trip_id: tripId,
      confidence,
      action,
      extracted,
    })

    if (action !== 'none') {
      await admin.from('notifications').insert({
        user_id: email.user_id,
        title: action === 'created' ? 'Booking added from email' : 'Booking updated from email',
        body: `${extracted.title || email.subject || 'A booking'} was ${action} from a forwarded confirmation.`,
        kind: 'booking_email',
        item_id: itemId,
        trip_id: tripId,
      })
    }

    await admin.from('inbound_emails').update({ status: 'done', error: null }).eq('id', inboundId)
    return new Response(JSON.stringify({ action, item_id: itemId, confidence }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
