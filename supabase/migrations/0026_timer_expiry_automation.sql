-- Milestone 10B: organizer-triggered timer expiry actions and timeout outcomes.
-- These functions are intentionally lazy: staff/admins must invoke them from Live Control.

alter type public.registration_status add value if not exists 'missed_check_in';
alter type public.registration_status add value if not exists 'replaced';
alter type public.registration_status add value if not exists 'active';
alter type public.registration_status add value if not exists 'excluded';

alter table public.tournament_registrations
  add column if not exists is_replacement boolean not null default false,
  add column if not exists replacement_claimed_at timestamptz,
  add column if not exists excluded_at timestamptz;

create index if not exists tournament_registrations_replacement_idx
  on public.tournament_registrations(tournament_id, is_replacement)
  where is_replacement = true;

create or replace view public.public_profiles as
select
  id,
  display_name,
  discord_username,
  steam_profile_url
from public.profiles;

create or replace function public.is_active_registration_status(status public.registration_status)
returns boolean
language sql
immutable
as $$
  select status::text in ('pending', 'accepted', 'checked_in', 'active', 'replaced')
$$;

create or replace view public.tournament_registration_counts
with (security_invoker = true) as
select
  tournament_id,
  count(*) filter (where public.is_active_registration_status(status))::integer as active_registration_count
from public.tournament_registrations
group by tournament_id;

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
      and public.is_active_registration_status(r.status)
  )
$$;

create or replace function public.can_register_for_tournament(tournament uuid)
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
      and t.status = 'registration_open'
      and (t.registration_closes_at is null or t.registration_closes_at > now())
      and (
        t.max_players is null
        or (
          select count(*)
          from public.tournament_registrations r
          where r.tournament_id = t.id
            and public.is_active_registration_status(r.status)
        ) < t.max_players
      )
  )
$$;

create or replace function public.enforce_registration_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_registration_count integer;
  tournament_record public.tournaments%rowtype;
begin
  if new.status in ('withdrawn', 'missed_check_in', 'excluded') then
    return new;
  end if;

  select *
  into tournament_record
  from public.tournaments
  where id = new.tournament_id
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if public.is_organizer_for(new.tournament_id) then
    return new;
  end if;

  if new.is_replacement is true then
    if tournament_record.status <> 'check_in'
      or tournament_record.replacement_window_enabled is not true
      or tournament_record.timers_paused_at is not null
      or coalesce(
        tournament_record.current_check_in_deadline,
        tournament_record.starts_at + make_interval(mins => tournament_record.check_in_window_minutes)
      ) > now()
      or coalesce(
        tournament_record.current_replacement_deadline,
        coalesce(
          tournament_record.current_check_in_deadline,
          tournament_record.starts_at + make_interval(mins => tournament_record.check_in_window_minutes)
        ) + make_interval(mins => tournament_record.replacement_window_minutes)
      ) <= now()
    then
      raise exception 'Replacement window is not active.';
    end if;
  elsif tournament_record.status <> 'registration_open' then
    raise exception 'Tournament registration is not open.';
  elsif tournament_record.registration_closes_at is not null
    and tournament_record.registration_closes_at <= now() then
    raise exception 'Tournament registration is closed.';
  end if;

  if tournament_record.max_players is not null then
    select count(*)
    into active_registration_count
    from public.tournament_registrations
    where tournament_id = new.tournament_id
      and public.is_active_registration_status(status)
      and (tg_op <> 'UPDATE' or id <> old.id);

    if active_registration_count >= tournament_record.max_players then
      raise exception 'Tournament registration is full.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.apply_expired_check_in_window(target_tournament uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  tournament_record public.tournaments%rowtype;
  active_count integer;
  missed_count integer;
  open_spots integer;
  capacity_count integer;
  check_in_deadline timestamptz;
  replacement_deadline timestamptz;
begin
  if actor is null or not public.is_organizer_for(target_tournament) then
    raise exception 'Only tournament staff can apply check-in expiry.';
  end if;

  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if tournament_record.timers_paused_at is not null then
    raise exception 'Timers are paused. Resume before applying expired actions.';
  end if;

  if tournament_record.status <> 'check_in' then
    raise exception 'Check-in expiry can only be applied during check-in.';
  end if;

  check_in_deadline := coalesce(
    tournament_record.current_check_in_deadline,
    tournament_record.starts_at + make_interval(mins => tournament_record.check_in_window_minutes)
  );

  if check_in_deadline is null or check_in_deadline > now() then
    raise exception 'Check-in deadline has not expired.';
  end if;

  update public.tournament_registrations r
  set
    status = 'active',
    updated_at = now()
  where r.tournament_id = target_tournament
    and r.status in ('pending', 'accepted', 'checked_in')
    and exists (
      select 1
      from public.tournament_check_ins c
      where c.tournament_id = r.tournament_id
        and c.user_id = r.user_id
    );

  update public.tournament_registrations r
  set
    status = 'missed_check_in',
    manual_seed = null,
    excluded_at = coalesce(excluded_at, now()),
    updated_at = now()
  where r.tournament_id = target_tournament
    and r.status in ('pending', 'accepted', 'checked_in')
    and not exists (
      select 1
      from public.tournament_check_ins c
      where c.tournament_id = r.tournament_id
        and c.user_id = r.user_id
    );

  select count(*)
  into active_count
  from public.tournament_registrations
  where tournament_id = target_tournament
    and status in ('active', 'replaced');

  select count(*)
  into missed_count
  from public.tournament_registrations
  where tournament_id = target_tournament
    and status = 'missed_check_in';

  capacity_count := case
    when tournament_record.tournament_format = 'group_stage_playoff'
      and tournament_record.group_size is not null
      and tournament_record.groups_count is not null
      then tournament_record.group_size * tournament_record.groups_count
    else coalesce(tournament_record.max_players, active_count)
  end;
  open_spots := greatest(capacity_count - active_count, 0);
  replacement_deadline := case
    when tournament_record.replacement_window_enabled and open_spots > 0
      then coalesce(
        tournament_record.current_replacement_deadline,
        now() + make_interval(mins => tournament_record.replacement_window_minutes)
      )
    else tournament_record.current_replacement_deadline
  end;

  update public.tournaments
  set
    current_check_in_deadline = coalesce(current_check_in_deadline, check_in_deadline),
    current_replacement_deadline = replacement_deadline,
    timing_state = case
      when tournament_record.replacement_window_enabled and open_spots > 0 then 'replacement'
      else 'expired'
    end,
    timing_note = case
      when tournament_record.replacement_window_enabled and open_spots > 0
        then 'Check-in expiry applied. Replacement window opened.'
      else 'Check-in expiry applied.'
    end,
    updated_at = now()
  where id = target_tournament;

  return jsonb_build_object(
    'active_count', active_count,
    'missed_count', missed_count,
    'open_spots', open_spots,
    'replacement_opened', tournament_record.replacement_window_enabled and open_spots > 0
  );
end;
$$;

create or replace function public.claim_replacement_spot(target_tournament uuid)
returns public.tournament_registrations
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  tournament_record public.tournaments%rowtype;
  active_count integer;
  capacity_count integer;
  existing_registration public.tournament_registrations%rowtype;
  created_registration public.tournament_registrations%rowtype;
  check_in_deadline timestamptz;
  replacement_deadline timestamptz;
begin
  if actor is null then
    raise exception 'Sign in to claim a replacement spot.';
  end if;

  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  check_in_deadline := coalesce(
    tournament_record.current_check_in_deadline,
    tournament_record.starts_at + make_interval(mins => tournament_record.check_in_window_minutes)
  );
  replacement_deadline := coalesce(
    tournament_record.current_replacement_deadline,
    check_in_deadline + make_interval(mins => tournament_record.replacement_window_minutes)
  );

  if tournament_record.status <> 'check_in'
    or tournament_record.replacement_window_enabled is not true
    or tournament_record.timers_paused_at is not null
    or check_in_deadline is null
    or check_in_deadline > now()
    or replacement_deadline is null
    or replacement_deadline <= now()
  then
    raise exception 'Replacement window is not active.';
  end if;

  select *
  into existing_registration
  from public.tournament_registrations
  where tournament_id = target_tournament
    and user_id = actor
  for update;

  if found and public.is_active_registration_status(existing_registration.status) then
    raise exception 'You already have an active registration for this tournament.';
  end if;

  if found and existing_registration.status in ('rejected', 'excluded') then
    raise exception 'This account is not eligible to claim a replacement spot.';
  end if;

  select count(*)
  into active_count
  from public.tournament_registrations
  where tournament_id = target_tournament
    and status in ('active', 'replaced');

  capacity_count := case
    when tournament_record.tournament_format = 'group_stage_playoff'
      and tournament_record.group_size is not null
      and tournament_record.groups_count is not null
      then tournament_record.group_size * tournament_record.groups_count
    else coalesce(tournament_record.max_players, active_count)
  end;

  if active_count >= capacity_count then
    raise exception 'No replacement spots are available.';
  end if;

  if found then
    update public.tournament_registrations
    set
      status = 'active',
      manual_seed = null,
      is_replacement = true,
      replacement_claimed_at = now(),
      excluded_at = null,
      updated_at = now()
    where id = existing_registration.id
    returning * into created_registration;
  else
    insert into public.tournament_registrations (
      tournament_id,
      user_id,
      status,
      manual_seed,
      is_replacement,
      replacement_claimed_at
    )
    values (
      target_tournament,
      actor,
      'active',
      null,
      true,
      now()
    )
    returning * into created_registration;
  end if;

  insert into public.tournament_check_ins (tournament_id, user_id, checked_in_by)
  values (target_tournament, actor, actor)
  on conflict (tournament_id, user_id) do nothing;

  return created_registration;
end;
$$;

create or replace function public.apply_expired_replacement_window(target_tournament uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  tournament_record public.tournaments%rowtype;
  active_count integer;
  open_spots integer;
  capacity_count integer;
  replacement_deadline timestamptz;
begin
  if actor is null or not public.is_organizer_for(target_tournament) then
    raise exception 'Only tournament staff can apply replacement expiry.';
  end if;

  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if tournament_record.timers_paused_at is not null then
    raise exception 'Timers are paused. Resume before applying expired actions.';
  end if;

  replacement_deadline := coalesce(
    tournament_record.current_replacement_deadline,
    coalesce(
      tournament_record.current_check_in_deadline,
      tournament_record.starts_at + make_interval(mins => tournament_record.check_in_window_minutes)
    ) + make_interval(mins => tournament_record.replacement_window_minutes)
  );

  if tournament_record.status <> 'check_in'
    or replacement_deadline is null
    or replacement_deadline > now()
  then
    raise exception 'Replacement deadline has not expired.';
  end if;

  select count(*)
  into active_count
  from public.tournament_registrations
  where tournament_id = target_tournament
    and status in ('active', 'replaced');

  capacity_count := case
    when tournament_record.tournament_format = 'group_stage_playoff'
      and tournament_record.group_size is not null
      and tournament_record.groups_count is not null
      then tournament_record.group_size * tournament_record.groups_count
    else coalesce(tournament_record.max_players, active_count)
  end;
  open_spots := greatest(capacity_count - active_count, 0);

  update public.tournaments
  set
    current_replacement_deadline = coalesce(current_replacement_deadline, replacement_deadline),
    timing_state = 'expired',
    timing_note = 'Replacement expiry applied. Generate the draw or bracket when ready.',
    updated_at = now()
  where id = target_tournament;

  return jsonb_build_object(
    'active_count', active_count,
    'open_spots', open_spots
  );
end;
$$;

create or replace function public.apply_expired_round_outcomes(
  target_tournament uuid,
  target_phase text,
  target_round integer default null,
  target_group uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  tournament_record public.tournaments%rowtype;
  match_record public.matches%rowtype;
  check_in_count integer;
  report_count integer;
  checked_in_player uuid;
  finalized_count integer := 0;
  no_contest_count integer := 0;
  review_count integer := 0;
  ignored_count integer := 0;
  round_deadline timestamptz;
  round_scope integer;
begin
  if actor is null or not public.is_organizer_for(target_tournament) then
    raise exception 'Only tournament staff can apply round expiry.';
  end if;

  if target_phase not in ('group', 'bracket') then
    raise exception 'Unsupported round phase.';
  end if;

  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if tournament_record.timers_paused_at is not null then
    raise exception 'Timers are paused. Resume before applying expired actions.';
  end if;

  round_deadline := case
    when target_phase = 'group' then tournament_record.current_group_round_deadline
    else tournament_record.current_bracket_round_deadline
  end;

  if round_deadline is null or round_deadline > now() then
    raise exception 'Round deadline has not expired.';
  end if;

  round_scope := target_round;

  if round_scope is null then
    select min(m.round_number)
    into round_scope
    from public.matches m
    where m.tournament_id = target_tournament
      and m.player_one_id is not null
      and m.player_two_id is not null
      and m.status not in ('finalized', 'confirmed', 'disputed', 'forfeit', 'bye');
  end if;

  for match_record in
    select m.*
    from public.matches m
    left join public.tournament_stages s on s.id = m.stage_id
    where m.tournament_id = target_tournament
      and m.round_number = round_scope
      and m.player_one_id is not null
      and m.player_two_id is not null
      and (
        (target_phase = 'group' and m.group_id is not null and (target_group is null or m.group_id = target_group))
        or (target_phase = 'bracket' and m.group_id is null and s.bracket_type = 'single_elimination')
      )
    for update of m
  loop
    if match_record.status in ('finalized', 'confirmed', 'disputed', 'forfeit', 'bye') then
      ignored_count := ignored_count + 1;
      continue;
    end if;

    select count(*)
    into check_in_count
    from public.match_check_ins
    where match_id = match_record.id
      and user_id in (match_record.player_one_id, match_record.player_two_id);

    select user_id
    into checked_in_player
    from public.match_check_ins
    where match_id = match_record.id
      and user_id in (match_record.player_one_id, match_record.player_two_id)
    order by checked_in_at
    limit 1;

    select count(*)
    into report_count
    from public.match_reports
    where match_id = match_record.id;

    if report_count > 0 then
      update public.matches
      set status = 'needs_admin', updated_at = now()
      where id = match_record.id;
      review_count := review_count + 1;
    elsif check_in_count = 1 then
      update public.matches
      set
        status = 'finalized',
        winner_id = checked_in_player,
        final_winner_score = null,
        final_loser_score = null,
        result_type = 'forfeit',
        result_reported_at = coalesce(result_reported_at, now()),
        finalized_at = now(),
        finalized_by = actor,
        updated_at = now()
      where id = match_record.id
      returning * into match_record;

      perform public.advance_single_elimination_winner(match_record, checked_in_player, actor);
      finalized_count := finalized_count + 1;
    elsif check_in_count = 0 then
      update public.matches
      set
        status = 'finalized',
        winner_id = null,
        final_winner_score = null,
        final_loser_score = null,
        result_type = 'no_contest',
        result_reported_at = coalesce(result_reported_at, now()),
        finalized_at = now(),
        finalized_by = actor,
        updated_at = now()
      where id = match_record.id
      returning * into match_record;

      no_contest_count := no_contest_count + 1;
    else
      update public.matches
      set status = 'needs_admin', updated_at = now()
      where id = match_record.id;
      review_count := review_count + 1;
    end if;

    insert into public.match_events (match_id, actor_id, event_type, metadata)
    values (
      match_record.id,
      actor,
      'timer_expired',
      jsonb_build_object(
        'phase', target_phase,
        'round_number', round_scope,
        'group_id', target_group,
        'match_check_ins', check_in_count,
        'reports', report_count
      )
    );
  end loop;

  if target_phase = 'group' then
    update public.tournaments
    set
      timing_state = 'expired',
      timing_note = 'Expired group round outcomes applied.',
      updated_at = now()
    where id = target_tournament;
  else
    update public.tournaments
    set
      timing_state = 'expired',
      timing_note = 'Expired bracket round outcomes applied.',
      updated_at = now()
    where id = target_tournament;
  end if;

  return jsonb_build_object(
    'round_number', round_scope,
    'forfeit_count', finalized_count,
    'no_contest_count', no_contest_count,
    'review_count', review_count,
    'ignored_count', ignored_count
  );
end;
$$;

grant insert (
  excluded_at,
  is_replacement,
  replacement_claimed_at
) on table public.tournament_registrations to authenticated;

grant update (
  excluded_at,
  is_replacement,
  manual_seed,
  replacement_claimed_at,
  status,
  updated_at
) on table public.tournament_registrations to authenticated;

grant execute on function public.apply_expired_check_in_window(uuid) to authenticated;
grant execute on function public.claim_replacement_spot(uuid) to authenticated;
grant execute on function public.apply_expired_replacement_window(uuid) to authenticated;
grant execute on function public.apply_expired_round_outcomes(uuid, text, integer, uuid) to authenticated;

notify pgrst, 'reload schema';
