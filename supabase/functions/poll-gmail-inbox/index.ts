/**
 * Cron: poll shared Gmail for +token addresses, store inbound_emails, invoke process-booking-email.
 *
 * Secrets:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   BOOKING_GMAIL_USER (local part before +token, e.g. bookings)
 * Schedule every few minutes.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID')
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET')
  const refresh = Deno.env.get('GMAIL_REFRESH_TOKEN')
  if (!clientId || !clientSecret || !refresh) throw new Error('Gmail OAuth secrets not configured')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${await res.text()}`)
  const j = await res.json()
  return j.access_token as string
}

function extractTokenFromHeaders(toHeader: string, baseUser: string): string | null {
  const re = new RegExp(`${baseUser}\\+([a-zA-Z0-9]+)@`, 'i')
  const m = toHeader.match(re)
  return m?.[1] ?? null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)
    const baseUser = Deno.env.get('BOOKING_GMAIL_USER') || 'bookings'

    let access: string
    try {
      access = await getAccessToken()
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, reason: String(e), processed: 0 }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    const listRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread newer_than:7d&maxResults=20',
      { headers: { Authorization: `Bearer ${access}` } },
    )
    if (!listRes.ok) throw new Error(await listRes.text())
    const list = await listRes.json()
    const messages: { id: string }[] = list.messages || []
    let processed = 0

    for (const m of messages) {
      const fullRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
        { headers: { Authorization: `Bearer ${access}` } },
      )
      if (!fullRes.ok) continue
      const full = await fullRes.json()
      const headers: { name: string; value: string }[] = full.payload?.headers || []
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || ''
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || ''
      const to = headers.find(h => h.name.toLowerCase() === 'to')?.value
        || headers.find(h => h.name.toLowerCase() === 'delivered-to')?.value
        || ''
      const token = extractTokenFromHeaders(to, baseUser)
      if (!token) {
        // Mark read so we don't loop forever on unrelated mail
        await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/modify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
        })
        continue
      }

      const { data: profile } = await admin.from('profiles').select('id, feature_ai_email').eq('forwarding_token', token).maybeSingle()
      if (!profile) continue

      let bodyText = ''
      const walk = (part: any) => {
        if (!part) return
        if (part.mimeType === 'text/plain' && part.body?.data) {
          bodyText += atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))
        } else if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
          bodyText += atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))
        }
        for (const p of part.parts || []) walk(p)
      }
      walk(full.payload)

      const { data: inbound, error: insErr } = await admin.from('inbound_emails').upsert({
        user_id: profile.id,
        gmail_message_id: m.id,
        subject,
        from_addr: from,
        received_at: full.internalDate ? new Date(Number(full.internalDate)).toISOString() : new Date().toISOString(),
        redacted_body: bodyText.slice(0, 50000),
        status: 'pending',
      }, { onConflict: 'gmail_message_id' }).select().single()

      if (insErr) continue

      // Store raw privately (best-effort)
      try {
        await admin.storage.from('inbound-emails').upload(
          `${profile.id}/${inbound.id}.txt`,
          new Blob([bodyText], { type: 'text/plain' }),
          { upsert: true },
        )
      } catch { /* bucket optional */ }

      await fetch(`${supabaseUrl}/functions/v1/process-booking-email`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inbound_email_id: inbound.id, raw_body: bodyText }),
      })

      await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/modify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      })
      processed++
    }

    return new Response(JSON.stringify({ ok: true, processed }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
