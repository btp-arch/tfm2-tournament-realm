-- Fix timer outcome application for matches with zero or one room check-ins.
-- PostgreSQL has no max(uuid), so fetch the checked-in player explicitly.

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
    checked_in_player := null;

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

grant execute on function public.apply_expired_round_outcomes(uuid, text, integer, uuid) to authenticated;

notify pgrst, 'reload schema';
