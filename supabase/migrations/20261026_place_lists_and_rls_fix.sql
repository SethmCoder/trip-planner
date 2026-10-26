-- Paste into Supabase SQL Editor if you already ran an older schema.sql.
-- Fixes trips RLS recursion + adds shareable saved place lists.

create or replace function public.is_trip_collaborator(p_trip_id uuid, p_editor_only boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trip_collaborators c
    where c.trip_id = p_trip_id
      and c.user_id = auth.uid()
      and (not p_editor_only or c.role = 'editor')
  );
$$;

drop policy if exists "own trips" on public.trips;
create policy "own trips" on public.trips for all
  using (auth.uid() = user_id or public.is_trip_collaborator(id, false))
  with check (auth.uid() = user_id or public.is_trip_collaborator(id, true));

drop policy if exists "own items" on public.itinerary_items;
create policy "own items" on public.itinerary_items for all
  using (auth.uid() = user_id or public.is_trip_collaborator(trip_id, false))
  with check (auth.uid() = user_id or public.is_trip_collaborator(trip_id, true));

create table if not exists public.saved_place_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'My list',
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_saved_place_lists_user on public.saved_place_lists(user_id, created_at desc);

create table if not exists public.saved_place_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.saved_place_lists(id) on delete cascade,
  place_id uuid not null references public.saved_places(id) on delete cascade,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
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
create index if not exists idx_shared_lists_with on public.shared_saved_lists(shared_with_id);

create or replace function public.can_read_saved_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.saved_place_lists l
    where l.id = p_list_id and l.user_id = auth.uid()
  ) or exists (
    select 1 from public.shared_saved_lists s
    where s.list_id = p_list_id and s.shared_with_id = auth.uid()
  );
$$;

create or replace function public.owns_saved_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.saved_place_lists l
    where l.id = p_list_id and l.user_id = auth.uid()
  );
$$;

alter table public.saved_place_lists enable row level security;
alter table public.saved_place_list_items enable row level security;
alter table public.shared_saved_lists enable row level security;

drop policy if exists "own place lists" on public.saved_place_lists;
create policy "own place lists" on public.saved_place_lists for all
  using (auth.uid() = user_id or public.can_read_saved_list(id))
  with check (auth.uid() = user_id);

drop policy if exists "list items access" on public.saved_place_list_items;
create policy "list items access" on public.saved_place_list_items for select
  using (public.can_read_saved_list(list_id));
drop policy if exists "list items write" on public.saved_place_list_items;
create policy "list items write" on public.saved_place_list_items for all
  using (public.owns_saved_list(list_id))
  with check (public.owns_saved_list(list_id));

drop policy if exists "shared lists" on public.shared_saved_lists;
create policy "shared lists" on public.shared_saved_lists for all
  using (auth.uid() = owner_id or auth.uid() = shared_with_id)
  with check (auth.uid() = owner_id);

drop policy if exists "own saved places" on public.saved_places;
create policy "own saved places" on public.saved_places for select using (
  auth.uid() = user_id
  or exists (
    select 1 from public.saved_place_list_items i
    join public.shared_saved_lists s on s.list_id = i.list_id
    where i.place_id = id and s.shared_with_id = auth.uid()
  )
);
drop policy if exists "own saved places write" on public.saved_places;
create policy "own saved places write" on public.saved_places for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
