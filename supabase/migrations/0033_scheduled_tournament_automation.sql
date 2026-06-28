-- Run enabled tournament automation from the database, not only from page polling.

alter table public.tournament_automation_events
  drop constraint if exists tournament_automation_events_source_check,
  add constraint tournament_automation_events_source_check
    check (source in ('live_control', 'page_poll', 'manual_button', 'scheduled_job'));

create or replace function public.log_scheduled_automation_event(
  target_tournament uuid,
  event_name text,
  event_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tournament_automation_events (
    tournament_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details
  )
  values (
    target_tournament,
    event_name,
    'system',
    null,
    'scheduled_job',
    event_details
  );
end;
$$;

create or replace function public.apply_expired_check_in_window_system(target_tournament uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tournament_record public.tournaments%rowtype;
  active_count integer;
  missed_count integer;
  open_spots integer;
  capacity_count integer;
  check_in_deadline timestamptz;
  replacement_deadline timestamptz;
  result jsonb;
begin
  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if tournament_record.automation_mode <> 'automatic'
    or tournament_record.auto_close_check_in_at_deadline is not true
    or tournament_record.automation_paused_at is not null
    or tournament_record.timers_paused_at is not null
    or tournament_record.status <> 'check_in'
  then
    return jsonb_build_object('applied', false);
  end if;

  check_in_deadline := coalesce(
    tournament_record.current_check_in_deadline,
    tournament_record.starts_at + make_interval(mins => tournament_record.check_in_window_minutes)
  );

  if check_in_deadline is null or check_in_deadline > now() then
    return jsonb_build_object('applied', false);
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
        then 'Scheduled automation applied check-in expiry. Replacement window opened.'
      else 'Scheduled automation applied check-in expiry.'
    end,
    last_automation_run_at = now(),
    updated_at = now()
  where id = target_tournament;

  result := jsonb_build_object(
    'applied', true,
    'active_count', active_count,
    'missed_count', missed_count,
    'open_spots', open_spots,
    'replacement_opened', tournament_record.replacement_window_enabled and open_spots > 0
  );

  perform public.log_scheduled_automation_event(
    target_tournament,
    'apply_check_in_expiry',
    result
  );

  return result;
end;
$$;

create or replace function public.apply_expired_replacement_window_system(target_tournament uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tournament_record public.tournaments%rowtype;
  active_count integer;
  open_spots integer;
  capacity_count integer;
  replacement_deadline timestamptz;
  result jsonb;
begin
  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if tournament_record.automation_mode <> 'automatic'
    or tournament_record.auto_close_replacement_window_at_deadline is not true
    or tournament_record.automation_paused_at is not null
    or tournament_record.timers_paused_at is not null
  then
    return jsonb_build_object('applied', false);
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
    return jsonb_build_object('applied', false);
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
    timing_note = 'Scheduled automation applied replacement expiry. Generate the draw or bracket when ready.',
    last_automation_run_at = now(),
    updated_at = now()
  where id = target_tournament;

  result := jsonb_build_object(
    'applied', true,
    'active_count', active_count,
    'open_spots', open_spots
  );

  perform public.log_scheduled_automation_event(
    target_tournament,
    'apply_replacement_expiry',
    result
  );

  return result;
end;
$$;

create or replace function public.apply_expired_round_outcomes_system(
  target_tournament uuid,
  target_phase text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := null;
  tournament_record public.tournaments%rowtype;
  match_record public.matches%rowtype;
  check_in_count integer;
  report_count integer;
  checked_in_player uuid;
  random_winner uuid;
  finalized_count integer := 0;
  no_contest_count integer := 0;
  random_advancement_count integer := 0;
  review_count integer := 0;
  ignored_count integer := 0;
  round_deadline timestamptz;
  round_scope integer;
  neither_policy text;
  result jsonb;
begin
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

  if tournament_record.automation_mode <> 'automatic'
    or tournament_record.auto_apply_match_timeout_outcomes is not true
    or tournament_record.automation_paused_at is not null
    or tournament_record.timers_paused_at is not null
    or tournament_record.status <> 'active'
  then
    return jsonb_build_object('applied', false);
  end if;

  round_deadline := case
    when target_phase = 'group' then tournament_record.current_group_round_deadline
    else tournament_record.current_bracket_round_deadline
  end;

  if round_deadline is null or round_deadline > now() then
    return jsonb_build_object('applied', false);
  end if;

  select min(m.round_number)
  into round_scope
  from public.matches m
  left join public.tournament_stages s on s.id = m.stage_id
  where m.tournament_id = target_tournament
    and m.player_one_id is not null
    and m.player_two_id is not null
    and m.status not in ('finalized', 'confirmed', 'disputed', 'forfeit', 'bye')
    and (
      (target_phase = 'group' and m.group_id is not null)
      or (target_phase = 'bracket' and m.group_id is null and s.bracket_type = 'single_elimination'::public.tournament_format)
    );

  if round_scope is null then
    return jsonb_build_object('applied', false);
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
        (target_phase = 'group' and m.group_id is not null)
        or (target_phase = 'bracket' and m.group_id is null and s.bracket_type = 'single_elimination'::public.tournament_format)
      )
    for update of m
  loop
    checked_in_player := null;
    random_winner := null;
    neither_policy := case
      when match_record.group_id is not null then tournament_record.neither_checked_in_group_policy
      else tournament_record.neither_checked_in_bracket_policy
    end;

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
    elsif check_in_count = 1 and tournament_record.one_checked_in_timeout_policy = 'forfeit_checked_in' then
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
    elsif check_in_count = 0 and neither_policy = 'random_advancement' then
      select candidate.user_id
      into random_winner
      from (
        values (match_record.player_one_id), (match_record.player_two_id)
      ) as candidate(user_id)
      order by random()
      limit 1;

      update public.matches
      set
        status = 'finalized',
        winner_id = random_winner,
        final_winner_score = null,
        final_loser_score = null,
        result_type = 'no_contest',
        result_reported_at = coalesce(result_reported_at, now()),
        finalized_at = now(),
        finalized_by = actor,
        updated_at = now()
      where id = match_record.id
      returning * into match_record;

      perform public.advance_single_elimination_winner(match_record, random_winner, actor);
      random_advancement_count := random_advancement_count + 1;
    elsif check_in_count = 0 and neither_policy = 'no_contest' then
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
    elsif check_in_count >= 2 and tournament_record.both_checked_in_no_result_policy = 'no_contest' then
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
        'match_check_ins', check_in_count,
        'reports', report_count,
        'neither_checked_in_policy', neither_policy,
        'random_advancement', random_winner is not null,
        'source', 'scheduled_job'
      )
    );
  end loop;

  update public.tournaments
  set
    current_group_round_deadline = case
      when target_phase = 'group' then null
      else current_group_round_deadline
    end,
    current_bracket_round_deadline = case
      when target_phase = 'bracket' then null
      else current_bracket_round_deadline
    end,
    timing_state = 'expired',
    timing_note = case
      when target_phase = 'group' then 'Scheduled automation applied expired group round outcomes.'
      else 'Scheduled automation applied expired bracket round outcomes.'
    end,
    last_automation_run_at = now(),
    updated_at = now()
  where id = target_tournament;

  update public.tournament_rounds r
  set
    timing_state = 'expired',
    updated_at = now()
  where r.tournament_id = target_tournament
    and r.round_number = round_scope
    and exists (
      select 1
      from public.matches m
      left join public.tournament_stages s on s.id = m.stage_id
      where m.round_id = r.id
        and (
          (target_phase = 'group' and m.group_id is not null)
          or (target_phase = 'bracket' and m.group_id is null and s.bracket_type = 'single_elimination'::public.tournament_format)
        )
    );

  perform public.apply_ready_match_openings(target_tournament);

  result := jsonb_build_object(
    'applied', true,
    'phase', target_phase,
    'round_number', round_scope,
    'forfeit_count', finalized_count,
    'no_contest_count', no_contest_count,
    'random_advancement_count', random_advancement_count,
    'review_count', review_count,
    'ignored_count', ignored_count
  );

  perform public.log_scheduled_automation_event(
    target_tournament,
    case
      when target_phase = 'group' then 'apply_group_round_expiry'
      else 'apply_bracket_round_expiry'
    end,
    result
  );

  return result;
end;
$$;

create or replace function public.run_due_tournament_automation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tournament_record public.tournaments%rowtype;
  ready_result jsonb;
  playoff_generated boolean;
  registration_closed_count integer := 0;
  check_in_opened_count integer := 0;
  check_in_expired_count integer := 0;
  replacement_expired_count integer := 0;
  group_round_expired_count integer := 0;
  bracket_round_expired_count integer := 0;
  ready_opened_count integer := 0;
  playoffs_generated_count integer := 0;
begin
  for tournament_record in
    select *
    from public.tournaments
    where automation_mode = 'automatic'
      and automation_paused_at is null
      and timers_paused_at is null
      and status = 'registration_open'
      and auto_close_registration_at_deadline is true
      and registration_closes_at is not null
      and registration_closes_at <= now()
    for update skip locked
  loop
    update public.tournaments
    set
      status = 'registration_closed',
      last_automation_run_at = now(),
      updated_at = now()
    where id = tournament_record.id
      and status = 'registration_open';

    if found then
      registration_closed_count := registration_closed_count + 1;
      perform public.log_scheduled_automation_event(
        tournament_record.id,
        'close_registration',
        jsonb_build_object('registration_closes_at', tournament_record.registration_closes_at)
      );
    end if;
  end loop;

  for tournament_record in
    select *
    from public.tournaments
    where automation_mode = 'automatic'
      and automation_paused_at is null
      and timers_paused_at is null
      and status = 'registration_closed'
      and auto_open_check_in_at_start_time is true
      and starts_at is not null
      and starts_at <= now()
    for update skip locked
  loop
    update public.tournaments
    set
      status = 'check_in',
      current_check_in_deadline = coalesce(
        current_check_in_deadline,
        now() + make_interval(mins => tournament_record.check_in_window_minutes)
      ),
      timing_state = 'check_in',
      timing_note = 'Scheduled automation opened check-in.',
      last_automation_run_at = now(),
      updated_at = now()
    where id = tournament_record.id
      and status = 'registration_closed';

    if found then
      check_in_opened_count := check_in_opened_count + 1;
      perform public.log_scheduled_automation_event(
        tournament_record.id,
        'open_check_in',
        jsonb_build_object('starts_at', tournament_record.starts_at)
      );
    end if;
  end loop;

  for tournament_record in
    select *
    from public.tournaments
    where automation_mode = 'automatic'
      and automation_paused_at is null
      and timers_paused_at is null
      and status = 'check_in'
      and auto_close_check_in_at_deadline is true
      and coalesce(
        current_check_in_deadline,
        starts_at + make_interval(mins => check_in_window_minutes)
      ) <= now()
    for update skip locked
  loop
    if (public.apply_expired_check_in_window_system(tournament_record.id) ->> 'applied')::boolean then
      check_in_expired_count := check_in_expired_count + 1;
    end if;
  end loop;

  for tournament_record in
    select *
    from public.tournaments
    where automation_mode = 'automatic'
      and automation_paused_at is null
      and timers_paused_at is null
      and status = 'check_in'
      and auto_close_replacement_window_at_deadline is true
      and coalesce(
        current_replacement_deadline,
        coalesce(
          current_check_in_deadline,
          starts_at + make_interval(mins => check_in_window_minutes)
        ) + make_interval(mins => replacement_window_minutes)
      ) <= now()
    for update skip locked
  loop
    if (public.apply_expired_replacement_window_system(tournament_record.id) ->> 'applied')::boolean then
      replacement_expired_count := replacement_expired_count + 1;
    end if;
  end loop;

  for tournament_record in
    select *
    from public.tournaments
    where automation_mode = 'automatic'
      and automation_paused_at is null
      and timers_paused_at is null
      and status = 'active'
      and auto_apply_match_timeout_outcomes is true
      and current_group_round_deadline is not null
      and current_group_round_deadline <= now()
    for update skip locked
  loop
    if (public.apply_expired_round_outcomes_system(tournament_record.id, 'group') ->> 'applied')::boolean then
      group_round_expired_count := group_round_expired_count + 1;
    end if;
  end loop;

  for tournament_record in
    select *
    from public.tournaments
    where automation_mode = 'automatic'
      and automation_paused_at is null
      and timers_paused_at is null
      and status = 'active'
      and auto_apply_match_timeout_outcomes is true
      and current_bracket_round_deadline is not null
      and current_bracket_round_deadline <= now()
    for update skip locked
  loop
    if (public.apply_expired_round_outcomes_system(tournament_record.id, 'bracket') ->> 'applied')::boolean then
      bracket_round_expired_count := bracket_round_expired_count + 1;
    end if;
  end loop;

  for tournament_record in
    select *
    from public.tournaments
    where automation_mode = 'automatic'
      and automation_paused_at is null
      and timers_paused_at is null
      and status = 'active'
      and (auto_open_ready_matches is true or auto_advance_group_round_waves is true)
    for update skip locked
  loop
    ready_result := public.apply_ready_match_openings(tournament_record.id);

    if coalesce((ready_result ->> 'opened_group_matches')::integer, 0) > 0
      or coalesce((ready_result ->> 'opened_bracket_matches')::integer, 0) > 0
      or (ready_result ->> 'started_group_round') is not null
      or (ready_result ->> 'started_bracket_round') is not null then
      ready_opened_count := ready_opened_count + 1;
      perform public.log_scheduled_automation_event(
        tournament_record.id,
        'open_ready_matches',
        ready_result
      );
    end if;
  end loop;

  for tournament_record in
    select *
    from public.tournaments t
    where t.automation_mode = 'automatic'
      and t.automation_paused_at is null
      and t.timers_paused_at is null
      and t.status = 'active'
      and t.tournament_format = 'group_stage_playoff'
      and t.auto_generate_playoff_when_groups_resolved is true
      and exists (
        select 1
        from public.tournament_stages s
        where s.tournament_id = t.id
          and s.bracket_type = 'group_stage_playoff'::public.tournament_format
      )
      and not exists (
        select 1
        from public.tournament_stages s
        where s.tournament_id = t.id
          and s.bracket_type = 'single_elimination'::public.tournament_format
          and s.stage_number > 1
      )
      and not exists (
        select 1
        from public.matches m
        where m.tournament_id = t.id
          and m.group_id is not null
          and m.status <> 'finalized'::public.match_status
      )
    for update skip locked
  loop
    playoff_generated := public.auto_generate_group_playoff(tournament_record.id, null);

    if playoff_generated then
      playoffs_generated_count := playoffs_generated_count + 1;
      perform public.log_scheduled_automation_event(
        tournament_record.id,
        'generate_group_playoff',
        jsonb_build_object('generated', true)
      );
      perform public.apply_ready_match_openings(tournament_record.id);
    end if;
  end loop;

  return jsonb_build_object(
    'registration_closed', registration_closed_count,
    'check_in_opened', check_in_opened_count,
    'check_in_expired', check_in_expired_count,
    'replacement_expired', replacement_expired_count,
    'group_round_expired', group_round_expired_count,
    'bracket_round_expired', bracket_round_expired_count,
    'ready_opened', ready_opened_count,
    'playoffs_generated', playoffs_generated_count
  );
end;
$$;

grant execute on function public.run_due_tournament_automation() to service_role;

create extension if not exists pg_cron with schema extensions;

do $$
begin
  perform cron.unschedule('tfm2_due_tournament_automation');
exception
  when others then
    null;
end;
$$;

select cron.schedule(
  'tfm2_due_tournament_automation',
  '* * * * *',
  'select public.run_due_tournament_automation();'
);

notify pgrst, 'reload schema';
