# Supabase Setup — The Travel Log

To connect real Supabase (users create their own account):

1. Create a free project at https://supabase.com/dashboard
2. In the project, open **SQL Editor**, paste all of `supabase/schema.sql`, and run it. This creates `profiles`, `trips`, `itinerary_items`, friends/collaborators, award searches, inbound email tables, Row Level Security, the new-user trigger, and storage buckets (`avatars`, `inbound-emails`).
3. Go to **Settings → API** and copy the Project URL and anon public key.
4. In this project, copy `.env.example` to `.env` and set:
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```
5. Restart `npm run dev`. The app automatically switches to Supabase when the keys are present — no code changes needed.

Notes:
- Auth uses Supabase Auth (email + password). Username login works by looking up the email for the username in `profiles`.
- If email confirmation is enabled in Supabase Auth settings, new users must confirm their email before first login; you can disable it under **Authentication → Providers → Email** for easier testing.
- Avatars upload to the `avatars` bucket under a folder named by user id.

## Feature secrets (Dashboard → Edge Functions → Secrets)

| Secret | Required for |
|---|---|
| `GROQ_API_KEY` (or `AI_API_KEY`) | Email AI extract, Suggest New Stops, award ranking |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Shared mailbox OAuth for booking forwards |
| `BOOKING_GMAIL_USER` | Local-part of forward addresses (`user+token@gmail.com`); mirror in `VITE_BOOKING_GMAIL_USER` |
| `SEATS_AERO_API_KEY` | Overnight independent award polling |
| `VITE_GOOGLE_MAPS_API_KEY` | Client Google Maps / Places (optional; omit keeps OSM) |

Core trip planning, Friends, and Award Flights UI work without AI/Gmail/Seats keys. Advanced settings only control AI email processing and Suggest New Stops.

## Fix: trips RLS infinite recursion (existing projects)

If Open Trip / save trip fails with `infinite recursion detected in policy for relation "trips"`, re-run the `is_trip_collaborator` / `is_trip_owner` helpers and the updated `trips` / `itinerary_items` / `trip_collaborators` policies from the bottom of `schema.sql` (search for “Avoid RLS recursion”).

## Edge Functions to deploy

```bash
supabase functions deploy suggest-itinerary
supabase functions deploy process-booking-email
supabase functions deploy poll-gmail-inbox
supabase functions deploy poll-award-searches
supabase functions deploy notify-booking-open
```

Suggested schedules:
- `poll-gmail-inbox` — every 5 minutes
- `poll-award-searches` — daily (e.g. `0 8 * * *`)
- `notify-booking-open` — daily
