/** Shared Groq / OpenAI-compatible chat completion for Edge Functions. */

export async function chatJson(system: string, user: string): Promise<unknown> {
  const key = Deno.env.get('GROQ_API_KEY') || Deno.env.get('AI_API_KEY')
  if (!key) throw new Error('GROQ_API_KEY (or AI_API_KEY) is not configured')

  const base = Deno.env.get('AI_API_BASE') || 'https://api.groq.com/openai/v1'
  const model = Deno.env.get('AI_MODEL') || 'llama-3.3-70b-versatile'

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`AI API error ${res.status}: ${t.slice(0, 400)}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || '{}'
  try {
    return JSON.parse(content)
  } catch {
    return { raw: content }
  }
}

export function redactBookingText(raw: string): string {
  let t = raw
  // Strip HTML tags roughly
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  t = t.replace(/<[^>]+>/g, ' ')
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  // Card numbers
  t = t.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD_REDACTED]')
  // Passport-ish
  t = t.replace(/\b[A-Z]{1,2}\d{6,9}\b/g, '[ID_REDACTED]')
  // Phone
  t = t.replace(/\+?\d[\d\s().-]{8,}\d/g, '[PHONE_REDACTED]')
  // Emails (keep domain of booking systems loosely)
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL_REDACTED]')
  // Names after Passenger:/Guest:
  t = t.replace(/(passenger|guest|traveler|name)\s*[:#]?\s*[A-Za-z][A-Za-z' -]{1,60}/gi, '$1: [NAME_REDACTED]')
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim()
  return t.slice(0, 12000)
}
