-- Milestone 4: tournament check-in and initial single-elimination bracket setup.

alter type public.match_status add value if not exists 'pending';
alter type public.match_status add value if not exists 'bye';

create table if not exists public.tournament_check_ins (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  checked_in_by uuid default auth.uid() references public.profiles(id) on delete set null,
  checked_in_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, user_id)
);

create table if not exists public.tournament_stages (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  stage_number integer not null default 1 check (stage_number > 0),
  name text not null default 'Single Elimination',
  bracket_type public.tournament_format not null default 'single_elimination',
  bracket_size integer not null check (bracket_size in (4, 8, 16, 32)),
  generated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, stage_number)
);

create table if not exists public.tournament_rounds (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  stage_id uuid not null references public.tournament_stages(id) on delete cascade,
  round_number integer not null check (round_number > 0),
  name text not null,
  match_format public.match_format not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stage_id, round_number)
);

alter table public.matches
  alter column player_one_id drop not null,
  alter column player_two_id drop not null,
  add column if not exists stage_id uuid references public.tournament_stages(id) on delete cascade,
  add column if not exists round_id uuid references public.tournament_rounds(id) on delete cascade,
  add column if not exists match_number integer,
  add column if not exists bracket_position integer,
  add column if not exists player_one_seed integer,
  add column if not exists player_two_seed integer,
  add column if not exists player_one_slot integer,
  add column if not exists player_two_slot integer;

alter table public.matches
  drop constraint if exists matches_player_slots_not_same,
  add constraint matches_player_slots_not_same
    check (
      player_one_id is null
      or player_two_id is null
      or player_one_id <> player_two_id
    ),
  drop constraint if exists matches_match_number_positive,
  add constraint matches_match_number_positive
    check (match_number is null or match_number > 0),
  drop constraint if exists matches_bracket_position_positive,
  add constraint matches_bracket_position_positive
    check (bracket_position is null or bracket_position > 0);

create index if not exists tournament_check_ins_tournament_idx
  on public.tournament_check_ins(tournament_id, checked_in_at);
create index if not exists tournament_check_ins_user_idx
  on public.tournament_check_ins(user_id);
create index if not exists tournament_stages_tournament_idx
  on public.tournament_stages(tournament_id, stage_number);
create index if not exists tournament_rounds_stage_idx
  on public.tournament_rounds(stage_id, round_number);
create index if not exists matches_round_idx
  on public.matches(round_id, match_number);

alter table public.tournament_check_ins enable row level security;
alter table public.tournament_stages enable row level security;
alter table public.tournament_rounds enable row level security;

create or replace function public.is_registered_for_tournament(
  tournament uuid,
  player uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tournament_registrations r
    where r.tournament_id = tournament
      and r.user_id = player
      and r.status in ('pending', 'accepted', 'checked_in')
  )
$$;

create or replace function public.can_check_in_for_tournament(
  tournament uuid,
  player uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tournaments t
    where t.id = tournament
      and t.status = 'check_in'
  )
  and public.is_registered_for_tournament(tournament, player)
$$;

create or replace function public.prevent_unsafe_bracket_reset()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.match_reports r
    join public.matches m on m.id = r.match_id
    where m.stage_id = old.id
  ) then
    raise exception 'Cannot reset a bracket after match reports exist.';
  end if;

  if exists (
    select 1
    from public.match_events e
    join public.matches m on m.id = e.match_id
    where m.stage_id = old.id
  ) then
    raise exception 'Cannot reset a bracket after match events exist.';
  end if;

  if exists (
    select 1
    from public.matches m
    where m.stage_id = old.id
      and m.status::text not in ('pending', 'assigned', 'bye', 'finalized')
  ) then
    raise exception 'Cannot reset a bracket after matches have started.';
  end if;

  return old;
end;
$$;

drop trigger if exists prevent_unsafe_bracket_reset on public.tournament_stages;

create trigger prevent_unsafe_bracket_reset
  before delete on public.tournament_stages
  for each row
  execute function public.prevent_unsafe_bracket_reset();

grant usage on type public.match_status to anon, authenticated, service_role;

grant select, insert, update, delete on table public.tournament_check_ins to authenticated;
grant select on table public.tournament_stages to anon, authenticated;
grant insert, update, delete on table public.tournament_stages to authenticated;
grant select on table public.tournament_rounds to anon, authenticated;
grant insert, update, delete on table public.tournament_rounds to authenticated;
grant select on table public.matches to anon, authenticated;
grant insert, update, delete on table public.matches to authenticated;

grant execute on function public.is_registered_for_tournament(uuid, uuid)
  to anon, authenticated, service_role;
grant execute on function public.can_check_in_for_tournament(uuid, uuid)
  to anon, authenticated, service_role;

create policy "Check-ins visible to checked-in users and tournament staff"
  on public.tournament_check_ins
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_organizer_for(tournament_id)
  );

create policy "Registered users and tournament staff create check-ins"
  on public.tournament_check_ins
  for insert
  to authenticated
  with check (
    checked_in_by = auth.uid()
    and public.can_check_in_for_tournament(tournament_id, user_id)
    and (
      user_id = auth.uid()
      or public.is_organizer_for(tournament_id)
    )
  );

create policy "Users update own check-ins and staff update managed check-ins"
  on public.tournament_check_ins
  for update
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_organizer_for(tournament_id)
  )
  with check (
    checked_in_by = auth.uid()
    and public.can_check_in_for_tournament(tournament_id, user_id)
    and (
      user_id = auth.uid()
      or public.is_organizer_for(tournament_id)
    )
  );

create policy "Tournament staff delete managed check-ins"
  on public.tournament_check_ins
  for delete
  to authenticated
  using (public.is_organizer_for(tournament_id));

create policy "Public can read stages for public tournaments"
  on public.tournament_stages
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and public.is_public_tournament_status(t.status)
    )
    or public.is_organizer_for(tournament_id)
  );

create policy "Tournament staff manage stages"
  on public.tournament_stages
  for all
  to authenticated
  using (public.is_organizer_for(tournament_id))
  with check (public.is_organizer_for(tournament_id));

create policy "Public can read rounds for public tournaments"
  on public.tournament_rounds
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and public.is_public_tournament_status(t.status)
    )
    or public.is_organizer_for(tournament_id)
  );

create policy "Tournament staff manage rounds"
  on public.tournament_rounds
  for all
  to authenticated
  using (public.is_organizer_for(tournament_id))
  with check (public.is_organizer_for(tournament_id));

drop policy if exists "Matches visible to participants and staff" on public.matches;
drop policy if exists "Tournament staff manage matches" on public.matches;

create policy "Public can read matches for public tournaments"
  on public.matches
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and public.is_public_tournament_status(t.status)
    )
    or auth.uid() in (player_one_id, player_two_id)
    or public.is_organizer_for(tournament_id)
  );

create policy "Tournament staff manage matches"
  on public.matches
  for all
  to authenticated
  using (public.is_organizer_for(tournament_id))
  with check (public.is_organizer_for(tournament_id));
