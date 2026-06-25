-- Milestone 5.5: simplify match rooms.
-- Host is always blue, guest is always red, and host-created moves the match in game.

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
        jsonb_build_object(
          'host_user_id',
          selected_host,
          'assignment',
          'random',
          'host_side',
          'blue'
        )
      );
    end if;

    update public.matches
    set
      status = 'awaiting_host_setup',
      host_user_id = selected_host,
      host_side_choice = 'blue',
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
    guest_joined_at = null,
    host_side_choice = 'blue',
    status = 'in_game',
    updated_at = now()
  where id = target_match
  returning * into match_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'host_setup',
    jsonb_build_object(
      'game_created_at',
      match_record.game_created_at,
      'host_side',
      'blue',
      'guest_side',
      'red'
    )
  );

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'game_started',
    jsonb_build_object('status', 'in_game', 'started_by', 'match_created')
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
    host_side_choice = 'blue',
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
    jsonb_build_object(
      'host_user_id',
      selected_host,
      'assignment',
      'staff',
      'host_side',
      'blue'
    )
  );

  return match_record;
end;
$$;

update public.matches
set
  host_side_choice = 'blue',
  status = 'in_game',
  updated_at = now()
where status::text = 'awaiting_guest_join'
  and game_created_at is not null;

update public.matches
set
  host_side_choice = 'blue',
  updated_at = now()
where host_user_id is not null
  and host_side_choice is distinct from 'blue';
