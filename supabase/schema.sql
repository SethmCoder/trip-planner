-- The Travel Log — run in Supabase Dashboard > SQL Editor
create extension if not exists pgcrypto;
do $$ begin create type booking_status as enum ('not_booked','partially_booked','booked'); exception when duplicate_object then null; end $$;
do $$ begin create type item_type as enum ('transit','hotel','activity'); exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null, email text not null, avatar_url text,
  booking_alerts_enabled boolean not null default true,
  preferred_language text not null default 'en',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
-- Existing projects: notification + language prefs
alter table public.profiles add column if not exists booking_alerts_enabled boolean not null default true;
alter table public.profiles add column if not exists preferred_language text not null default 'en';

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'New Trip', place text not null default '',
  place_lat double precision, place_lng double precision,
  start_date date, end_date date, major_stops jsonb not null default '[]'::jsonb,
  booking_status booking_status not null default 'not_booked',
  image_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
-- For existing projects: destination photo on trips
alter table public.trips add column if not exists image_url text;

create table if not exists public.itinerary_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  type item_type not null, group_id uuid, subtype text,
  title text not null default '', place_name text not null default '',
  lat double precision, lng double precision,
  from_name text not null default '', from_lat double precision, from_lng double precision,
  to_name text not null default '', to_lat double precision, to_lng double precision,
  start_at timestamptz, end_at timestamptz, duration_minutes int,
  mode_of_transport text not null default '', booking_status booking_status not null default 'not_booked',
  booking_open_date date, book_by_date date,
  image_url text not null default '', sort_order int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
-- For existing projects: add the booking-window columns if they are not there yet
alter table public.itinerary_items add column if not exists booking_open_date date;
alter table public.itinerary_items add column if not exists book_by_date date;
-- For existing projects: allow 'restaurant' as an itinerary item type
alter type item_type add value if not exists 'restaurant';
create table if not exists public.saved_places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default '',
  place_name text not null default '',
  lat double precision not null,
  lng double precision not null,
  category text not null default 'other',
  created_at timestamptz not null default now()
);
alter table public.saved_places add column if not exists category text not null default 'other';
create index if not exists idx_trips_user on public.trips(user_id);
create index if not exists idx_items_trip on public.itinerary_items(trip_id, sort_order);
create index if not exists idx_saved_places_user on public.saved_places(user_id, created_at desc);

-- In-app notifications (booking window opened, etc.)
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default '',
  body text not null default '',
  kind text not null default 'booking_open',
  item_id uuid,
  trip_id uuid,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_notifications_dedupe
  on public.notifications (user_id, kind, item_id)
  where item_id is not null;
create index if not exists idx_notifications_user on public.notifications(user_id, created_at desc);

-- Insert booking-open notifications for users who opted in (call daily via pg_cron or the app).
create or replace function public.generate_booking_open_notifications()
returns integer
language plpgsql
security definer
as $$
declare
  inserted int := 0;
begin
  insert into public.notifications (user_id, title, body, kind, item_id, trip_id)
  select
    i.user_id,
    'Booking window open',
    coalesce(nullif(i.title, ''), 'An itinerary item') || ' — booking is now open.',
    'booking_open',
    i.id,
    i.trip_id
  from public.itinerary_items i
  join public.profiles p on p.id = i.user_id
  where coalesce(p.booking_alerts_enabled, true) = true
    and i.booking_open_date is not null
    and i.booking_open_date <= current_date
    and i.booking_status is distinct from 'booked'
    and not exists (
      select 1 from public.notifications n
      where n.user_id = i.user_id and n.kind = 'booking_open' and n.item_id = i.id
    );
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.itinerary_items enable row level security;
alter table public.saved_places enable row level security;
alter table public.notifications enable row level security;
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
-- Allow username->email lookup for login (only email column is used by app)
drop policy if exists "profiles lookup" on public.profiles;
create policy "profiles lookup" on public.profiles for select using (true);
drop policy if exists "own trips" on public.trips;
create policy "own trips" on public.trips for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own items" on public.itinerary_items;
create policy "own items" on public.itinerary_items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own saved places" on public.saved_places;
create policy "own saved places" on public.saved_places for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own notifications" on public.notifications;
create policy "own notifications" on public.notifications for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.handle_new_user() returns trigger language plpgsql security definer as $$
begin insert into public.profiles (id, email, username) values (new.id, new.email, split_part(new.email,'@',1)) on conflict (id) do nothing; return new; end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

insert into storage.buckets (id, name, public) values ('avatars','avatars',true) on conflict (id) do nothing;
drop policy if exists "avatar read" on storage.objects;
create policy "avatar read" on storage.objects for select using (bucket_id='avatars');
drop policy if exists "avatar write own" on storage.objects;
create policy "avatar write own" on storage.objects for all using (bucket_id='avatars' and auth.uid()::text = (storage.foldername(name))[1]) with check (bucket_id='avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ========== AI / Social / Award Flights expansion ==========
alter table public.profiles add column if not exists settings_mode text not null default 'basic';
alter table public.profiles add column if not exists feature_ai_email boolean not null default false;
alter table public.profiles add column if not exists feature_ai_suggest boolean not null default false;
alter table public.profiles add column if not exists forwarding_token text unique;
alter table public.profiles add column if not exists award_alerts_enabled boolean not null default true;
alter table public.profiles add column if not exists preferred_booking_apps jsonb not null default '["roame","google_flights"]'::jsonb;
alter table public.profiles add column if not exists google_places_connected boolean not null default false;

alter table public.itinerary_items add column if not exists confirmation_code text;
alter table public.itinerary_items add column if not exists booking_source text;
alter table public.itinerary_items add column if not exists source_email_id uuid;

create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  gmail_message_id text not null,
  subject text not null default '',
  from_addr text not null default '',
  received_at timestamptz,
  redacted_body text not null default '',
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  unique (gmail_message_id)
);
create index if not exists idx_inbound_emails_user on public.inbound_emails(user_id, created_at desc);

create table if not exists public.booking_email_matches (
  id uuid primary key default gen_random_uuid(),
  inbound_email_id uuid not null references public.inbound_emails(id) on delete cascade,
  item_id uuid references public.itinerary_items(id) on delete set null,
  trip_id uuid references public.trips(id) on delete set null,
  confidence double precision not null default 0,
  action text not null default 'none',
  extracted jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.itinerary_suggestions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default '',
  place_name text not null default '',
  lat double precision, lng double precision,
  type text not null default 'activity',
  suggested_start timestamptz,
  reason text not null default '',
  status text not null default 'suggested',
  created_at timestamptz not null default now()
);
create index if not exists idx_suggestions_trip on public.itinerary_suggestions(trip_id, status);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index if not exists idx_friendships_users on public.friendships(requester_id, addressee_id, status);

create table if not exists public.trip_collaborators (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'editor',
  created_at timestamptz not null default now(),
  unique (trip_id, user_id)
);
create index if not exists idx_trip_collab_user on public.trip_collaborators(user_id);

create table if not exists public.shared_saved_places (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.saved_places(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  shared_with_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (place_id, shared_with_id)
);

create table if not exists public.award_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  origin text not null default '',
  destination text not null default '',
  date_start date,
  date_end date,
  time_pref text not null default 'any',
  points_min int not null default 0,
  points_max int not null default 200000,
  preferred_airline text not null default '',
  cabin text not null default 'economy',
  seats int not null default 1,
  booking_app text not null default 'roame',
  active boolean not null default true,
  notify boolean not null default true,
  best_summary text,
  best_points int,
  best_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_award_searches_user on public.award_searches(user_id, active);

create table if not exists public.award_results (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references public.award_searches(id) on delete cascade,
  summary text not null default '',
  points int,
  airline text,
  cabin text,
  depart_at timestamptz,
  deep_link text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_award_results_search on public.award_results(search_id, created_at desc);

alter table public.inbound_emails enable row level security;
alter table public.booking_email_matches enable row level security;
alter table public.itinerary_suggestions enable row level security;
alter table public.friendships enable row level security;
alter table public.trip_collaborators enable row level security;
alter table public.shared_saved_places enable row level security;
alter table public.award_searches enable row level security;
alter table public.award_results enable row level security;

drop policy if exists "own inbound emails" on public.inbound_emails;
create policy "own inbound emails" on public.inbound_emails for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own email matches" on public.booking_email_matches;
create policy "own email matches" on public.booking_email_matches for select using (
  exists (select 1 from public.inbound_emails e where e.id = inbound_email_id and e.user_id = auth.uid())
);
drop policy if exists "own suggestions" on public.itinerary_suggestions;
create policy "own suggestions" on public.itinerary_suggestions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own friendships" on public.friendships;
create policy "own friendships" on public.friendships for all using (auth.uid() = requester_id or auth.uid() = addressee_id)
  with check (auth.uid() = requester_id or auth.uid() = addressee_id);
-- Avoid RLS recursion: trips ↔ trip_collaborators must not cross-query under RLS
create or replace function public.is_trip_collaborator(p_trip_id uuid, p_editor_only boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.trip_collaborators c
    where c.trip_id = p_trip_id
      and c.user_id = auth.uid()
      and (not p_editor_only or c.role = 'editor')
  );
$$;

create or replace function public.is_trip_owner(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id and t.user_id = auth.uid()
  );
$$;

drop policy if exists "trip collab read" on public.trip_collaborators;
drop policy if exists "trip collab write owner" on public.trip_collaborators;
drop policy if exists "trip collab participants" on public.trip_collaborators;
drop policy if exists "trip collab owner write" on public.trip_collaborators;
create policy "trip collab participants" on public.trip_collaborators for select using (
  auth.uid() = user_id or public.is_trip_owner(trip_id)
);
create policy "trip collab owner write" on public.trip_collaborators for all using (
  public.is_trip_owner(trip_id)
) with check (
  public.is_trip_owner(trip_id)
);

drop policy if exists "shared places" on public.shared_saved_places;
create policy "shared places" on public.shared_saved_places for all using (auth.uid() = owner_id or auth.uid() = shared_with_id)
  with check (auth.uid() = owner_id);
drop policy if exists "own award searches" on public.award_searches;
create policy "own award searches" on public.award_searches for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own award results" on public.award_results;
create policy "own award results" on public.award_results for all using (
  exists (select 1 from public.award_searches s where s.id = search_id and s.user_id = auth.uid())
) with check (
  exists (select 1 from public.award_searches s where s.id = search_id and s.user_id = auth.uid())
);

-- Collaborators can read/edit trips they are invited to (via SECURITY DEFINER helper — no recursion)
drop policy if exists "own trips" on public.trips;
create policy "own trips" on public.trips for all using (
  auth.uid() = trips.user_id or public.is_trip_collaborator(trips.id, false)
) with check (
  auth.uid() = trips.user_id or public.is_trip_collaborator(trips.id, true)
);
drop policy if exists "own items" on public.itinerary_items;
create policy "own items" on public.itinerary_items for all using (
  auth.uid() = itinerary_items.user_id or public.is_trip_collaborator(itinerary_items.trip_id, false)
) with check (
  auth.uid() = itinerary_items.user_id or public.is_trip_collaborator(itinerary_items.trip_id, true)
);

-- Named saved-place lists + friend share
create table if not exists public.saved_place_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_saved_place_lists_user on public.saved_place_lists(user_id, created_at desc);

create table if not exists public.saved_place_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.saved_place_lists(id) on delete cascade,
  place_id uuid not null references public.saved_places(id) on delete cascade,
  sort_order int not null default 0,
  unique (list_id, place_id)
);
create index if not exists idx_list_items_list on public.saved_place_list_items(list_id, sort_order);

create table if not exists public.shared_saved_lists (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.saved_place_lists(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  shared_with_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (list_id, shared_with_id)
);

alter table public.saved_place_lists enable row level security;
alter table public.saved_place_list_items enable row level security;
alter table public.shared_saved_lists enable row level security;

drop policy if exists "own place lists" on public.saved_place_lists;
create policy "own place lists" on public.saved_place_lists for all using (
  auth.uid() = saved_place_lists.user_id
  or exists (
    select 1 from public.shared_saved_lists s
    where s.list_id = saved_place_lists.id and s.shared_with_id = auth.uid()
  )
) with check (auth.uid() = saved_place_lists.user_id);

drop policy if exists "own list items" on public.saved_place_list_items;
create policy "own list items" on public.saved_place_list_items for all using (
  exists (
    select 1 from public.saved_place_lists l
    where l.id = saved_place_list_items.list_id and (
      l.user_id = auth.uid()
      or exists (select 1 from public.shared_saved_lists s where s.list_id = l.id and s.shared_with_id = auth.uid())
    )
  )
) with check (
  exists (
    select 1 from public.saved_place_lists l
    where l.id = saved_place_list_items.list_id and l.user_id = auth.uid()
  )
);

drop policy if exists "shared lists" on public.shared_saved_lists;
create policy "shared lists" on public.shared_saved_lists for all using (
  auth.uid() = shared_saved_lists.owner_id or auth.uid() = shared_saved_lists.shared_with_id
) with check (auth.uid() = shared_saved_lists.owner_id);

-- Friends can read places that appear on lists shared with them
drop policy if exists "read places on shared lists" on public.saved_places;
create policy "read places on shared lists" on public.saved_places for select using (
  exists (
    select 1
    from public.saved_place_list_items i
    join public.shared_saved_lists s on s.list_id = i.list_id
    where i.place_id = saved_places.id and s.shared_with_id = auth.uid()
  )
);

-- Optional account label on award searches (display only — never passwords)
alter table public.award_searches add column if not exists account_label text not null default '';
alter table public.award_searches add column if not exists seats_fallback boolean not null default false;

insert into storage.buckets (id, name, public) values ('inbound-emails','inbound-emails',false) on conflict (id) do nothing;
drop policy if exists "inbound email own" on storage.objects;
create policy "inbound email own" on storage.objects for all using (
  bucket_id = 'inbound-emails' and auth.uid()::text = (storage.foldername(name))[1]
) with check (
  bucket_id = 'inbound-emails' and auth.uid()::text = (storage.foldername(name))[1]
);

-- Ensure every profile has a forwarding token
update public.profiles set forwarding_token = replace(gen_random_uuid()::text, '-', '')
where forwarding_token is null;
