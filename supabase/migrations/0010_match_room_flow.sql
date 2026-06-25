-- Milestone 5: match room check-in and private friendly setup flow.

alter type public.match_status add value if not exists 'ready_to_setup';
alter type public.match_status add value if not exists 'blocked';
alter type public.match_status add value if not exists 'needs_admin';

alter table public.matches
  add column if not exists game_created_at timestamptz,
  add column if not exists guest_joined_at timestamptz,
  add column if not exists setup_deadline_at timestamptz,
  add column if not exists join_deadline_at timestamptz;

create table if not exists public.match_check_ins (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  checked_in_by uuid default auth.uid() references public.profiles(id) on delete set null,
  checked_in_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, user_id)
);

create index if not exists match_check_ins_match_idx
  on public.match_check_ins(match_id, checked_in_at);
create index if not exists match_check_ins_user_idx
  on public.match_check_ins(user_id);

alter table public.match_check_ins enable row level security;

create or replace function public.can_manage_match(target_match uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.matches m
    where m.id = target_match
      and public.is_organizer_for(m.tournament_id)
  )
$$;

create or replace function public.check_in_for_match(target_match uuid)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  match_record public.matches%rowtype;
  checked_in_count integer;
  selected_host uuid;
begin
  if actor is null then
    raise exception 'Sign in to check in for this match.';
  end if;

  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  if actor not in (match_record.player_one_id, match_record.player_two_id) then
    raise exception 'You are not in this match.';
  end if;

  if match_record.player_one_id is null or match_record.player_two_id is null then
    raise exception 'This match is waiting for both players.';
  end if;

  if match_record.status::text = 'bye' then
    raise exception 'This match is a BYE.';
  end if;

  if match_record.status::text = 'pending' then
    raise exception 'This match is waiting for a prior round winner.';
  end if;

  insert into public.match_check_ins (match_id, user_id, checked_in_by)
  values (target_match, actor, actor)
  on conflict (match_id, user_id)
  do update set
    checked_in_by = excluded.checked_in_by,
    checked_in_at = now(),
    updated_at = now();

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (target_match, actor, 'check_in', jsonb_build_object('user_id', actor));

  select count(*)
  into checked_in_count
  from public.match_check_ins
  where match_id = target_match;

  if checked_in_count >= 2 then
    selected_host := match_record.host_user_id;

    if selected_host is null then
      selected_host := case
        when random() < 0.5 then match_record.player_one_id
        else match_record.player_two_id
      end;

      insert into public.match_events (match_id, actor_id, event_type, metadata)
      values (
        target_match,
        actor,
        'host_assigned',
        jsonb_build_object('host_user_id', selected_host, 'assignment', 'random')
      );
    end if;

    update public.matches
    set
      status = 'awaiting_host_setup',
      host_user_id = selected_host,
      updated_at = now()
    where id = target_match
    returning * into match_record;

    insert into public.match_events (match_id, actor_id, event_type, metadata)
    values (
      target_match,
      actor,
      'status_changed',
      jsonb_build_object('status', 'awaiting_host_setup')
    );
  elsif match_record.status::text in ('assigned', 'check_in_open') then
    update public.matches
    set
      status = 'check_in_open',
      updated_at = now()
    where id = target_match
    returning * into match_record;
  end if;

  return match_record;
end;
$$;

create or replace function public.choose_match_host_side(
  target_match uuid,
  selected_side public.side_choice
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  match_record public.matches%rowtype;
  staff_can_manage boolean;
begin
  if actor is null then
    raise exception 'Sign in to choose a side.';
  end if;

  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  staff_can_manage := public.can_manage_match(target_match);

  if match_record.host_user_id is null then
    raise exception 'Host has not been assigned yet.';
  end if;

  if actor <> match_record.host_user_id and not staff_can_manage then
    raise exception 'Only the assigned host or tournament staff can choose the host side.';
  end if;

  update public.matches
  set
    host_side_choice = selected_side,
    updated_at = now()
  where id = target_match
  returning * into match_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'note',
    jsonb_build_object('action', 'host_side_chosen', 'host_side', selected_side)
  );

  return match_record;
end;
$$;

create or replace function public.mark_match_game_created(target_match uuid)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  match_record public.matches%rowtype;
  staff_can_manage boolean;
begin
  if actor is null then
    raise exception 'Sign in to update match setup.';
  end if;

  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  staff_can_manage := public.can_manage_match(target_match);

  if match_record.host_user_id is null then
    raise exception 'Host has not been assigned yet.';
  end if;

  if actor <> match_record.host_user_id and not staff_can_manage then
    raise exception 'Waiting for host to create the game.';
  end if;

  update public.matches
  set
    game_created_at = now(),
    status = 'awaiting_guest_join',
    updated_at = now()
  where id = target_match
  returning * into match_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'host_setup',
    jsonb_build_object('game_created_at', match_record.game_created_at)
  );

  return match_record;
end;
$$;

create or replace function public.mark_match_guest_joined(target_match uuid)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  match_record public.matches%rowtype;
  guest uuid;
  staff_can_manage boolean;
begin
  if actor is null then
    raise exception 'Sign in to update match setup.';
  end if;

  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  staff_can_manage := public.can_manage_match(target_match);
  guest := case
    when match_record.host_user_id = match_record.player_one_id then match_record.player_two_id
    when match_record.host_user_id = match_record.player_two_id then match_record.player_one_id
    else null
  end;

  if match_record.host_user_id is null or guest is null then
    raise exception 'Host has not been assigned yet.';
  end if;

  if match_record.game_created_at is null then
    raise exception 'Waiting for host to create the game.';
  end if;

  if actor <> guest and not staff_can_manage then
    raise exception 'Waiting for guest to join.';
  end if;

  update public.matches
  set
    guest_joined_at = now(),
    status = 'in_game',
    updated_at = now()
  where id = target_match
  returning * into match_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'guest_joined',
    jsonb_build_object('guest_user_id', guest, 'guest_joined_at', match_record.guest_joined_at)
  );

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'game_started',
    jsonb_build_object('status', 'in_game')
  );

  return match_record;
end;
$$;

create or replace function public.reset_match_room(target_match uuid)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  match_record public.matches%rowtype;
begin
  if actor is null or not public.can_manage_match(target_match) then
    raise exception 'Only tournament staff can reset this match room.';
  end if;

  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  delete from public.match_check_ins
  where match_id = target_match;

  update public.matches
  set
    status = case
      when match_record.status::text = 'bye' then 'bye'::public.match_status
      when match_record.player_one_id is null or match_record.player_two_id is null then 'pending'::public.match_status
      else 'check_in_open'::public.match_status
    end,
    host_user_id = null,
    host_side_choice = null,
    game_created_at = null,
    guest_joined_at = null,
    setup_deadline_at = null,
    join_deadline_at = null,
    updated_at = now()
  where id = target_match
  returning * into match_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'status_changed',
    jsonb_build_object('action', 'match_room_reset', 'status', match_record.status)
  );

  return match_record;
end;
$$;

create or replace function public.assign_match_host(
  target_match uuid,
  selected_host uuid
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  match_record public.matches%rowtype;
begin
  if actor is null or not public.can_manage_match(target_match) then
    raise exception 'Only tournament staff can assign the host.';
  end if;

  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  if selected_host is null
    or selected_host not in (match_record.player_one_id, match_record.player_two_id) then
    raise exception 'Host must be one of the match players.';
  end if;

  if match_record.player_one_id is null or match_record.player_two_id is null then
    raise exception 'This match is waiting for both players.';
  end if;

  if match_record.status::text = 'bye' then
    raise exception 'This match is a BYE.';
  end if;

  update public.matches
  set
    host_user_id = selected_host,
    host_side_choice = null,
    game_created_at = null,
    guest_joined_at = null,
    status = 'awaiting_host_setup',
    updated_at = now()
  where id = target_match
  returning * into match_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'host_assigned',
    jsonb_build_object('host_user_id', selected_host, 'assignment', 'staff')
  );

  return match_record;
end;
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
    from public.match_check_ins c
    join public.matches m on m.id = c.match_id
    where m.stage_id = old.id
  ) then
    raise exception 'Cannot reset a bracket after match check-ins exist.';
  end if;

  if exists (
    select 1
    from public.matches m
    where m.stage_id = old.id
      and m.status::text not in ('pending', 'assigned', 'check_in_open', 'bye', 'finalized')
  ) then
    raise exception 'Cannot reset a bracket after matches have started.';
  end if;

  return old;
end;
$$;

grant usage on type public.match_status to anon, authenticated, service_role;
grant usage on type public.side_choice to anon, authenticated, service_role;

grant select, insert, update, delete on table public.match_check_ins to authenticated;
grant select on table public.match_events to anon, authenticated;
grant insert on table public.match_events to authenticated;

grant execute on function public.can_manage_match(uuid)
  to anon, authenticated, service_role;
grant execute on function public.check_in_for_match(uuid)
  to authenticated;
grant execute on function public.choose_match_host_side(uuid, public.side_choice)
  to authenticated;
grant execute on function public.mark_match_game_created(uuid)
  to authenticated;
grant execute on function public.mark_match_guest_joined(uuid)
  to authenticated;
grant execute on function public.reset_match_room(uuid)
  to authenticated;
grant execute on function public.assign_match_host(uuid, uuid)
  to authenticated;

drop policy if exists "Match events visible to participants and staff" on public.match_events;

create policy "Public can read match events for public tournaments"
  on public.match_events
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.matches m
      join public.tournaments t on t.id = m.tournament_id
      where m.id = match_id
        and public.is_public_tournament_status(t.status)
    )
    or public.is_match_participant(match_id)
    or exists (
      select 1
      from public.matches m
      where m.id = match_id
        and public.is_organizer_for(m.tournament_id)
    )
  );

create policy "Match check-ins visible to participants and staff"
  on public.match_check_ins
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.matches m
      where m.id = match_id
        and public.is_organizer_for(m.tournament_id)
    )
  );

create policy "Participants create own match check-ins"
  on public.match_check_ins
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and checked_in_by = auth.uid()
    and public.is_match_participant(match_id)
  );

create policy "Participants update own match check-ins"
  on public.match_check_ins
  for update
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.matches m
      where m.id = match_id
        and public.is_organizer_for(m.tournament_id)
    )
  )
  with check (
    (
      user_id = auth.uid()
      and checked_in_by = auth.uid()
      and public.is_match_participant(match_id)
    )
    or exists (
      select 1
      from public.matches m
      where m.id = match_id
        and public.is_organizer_for(m.tournament_id)
    )
  );

create policy "Tournament staff delete match check-ins"
  on public.match_check_ins
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.matches m
      where m.id = match_id
        and public.is_organizer_for(m.tournament_id)
    )
  );
