-- Milestone 8B: series score reporting for BO1/BO3/BO5 match results.

alter table public.match_reports
  add column if not exists reported_winner_score integer,
  add column if not exists reported_loser_score integer;

alter table public.matches
  add column if not exists final_winner_score integer,
  add column if not exists final_loser_score integer;

update public.match_reports r
set
  reported_winner_score = case
    when r.reported_winner_id = m.player_one_id then nullif(r.score_player_one, 0)
    when r.reported_winner_id = m.player_two_id then nullif(r.score_player_two, 0)
    else r.reported_winner_score
  end,
  reported_loser_score = case
    when r.reported_winner_id = m.player_one_id then r.score_player_two
    when r.reported_winner_id = m.player_two_id then r.score_player_one
    else r.reported_loser_score
  end
from public.matches m
where m.id = r.match_id
  and r.reported_winner_score is null
  and greatest(r.score_player_one, r.score_player_two) > 0;

alter table public.match_reports
  drop constraint if exists match_reports_reported_series_score_check,
  add constraint match_reports_reported_series_score_check
    check (
      (reported_winner_score is null and reported_loser_score is null)
      or (
        reported_winner_score is not null
        and reported_loser_score is not null
        and reported_winner_score between 1 and 3
        and reported_loser_score between 0 and 2
        and reported_loser_score < reported_winner_score
      )
    );

alter table public.matches
  drop constraint if exists matches_final_series_score_check,
  add constraint matches_final_series_score_check
    check (
      (final_winner_score is null and final_loser_score is null)
      or (
        final_winner_score is not null
        and final_loser_score is not null
        and final_winner_score between 1 and 3
        and final_loser_score between 0 and 2
        and final_loser_score < final_winner_score
      )
    );

create or replace function public.required_wins_for_match_format(match_format public.match_format)
returns integer
language sql
immutable
set search_path = public
as $$
  select case match_format
    when 'bo1'::public.match_format then 1
    when 'bo3'::public.match_format then 2
    when 'bo5'::public.match_format then 3
  end;
$$;

create or replace function public.is_valid_series_score(
  match_format public.match_format,
  winner_score integer,
  loser_score integer
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    winner_score = public.required_wins_for_match_format(match_format)
    and loser_score >= 0
    and loser_score < winner_score
    and loser_score < public.required_wins_for_match_format(match_format),
    false
  );
$$;

create or replace function public.finalize_match_winner(
  target_match uuid,
  selected_winner uuid,
  selected_winner_score integer,
  selected_loser_score integer,
  actor uuid,
  source text
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  match_record public.matches%rowtype;
begin
  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  if selected_winner not in (match_record.player_one_id, match_record.player_two_id) then
    raise exception 'Winner must be one of the match players.';
  end if;

  if match_record.status::text in ('bye', 'pending') then
    raise exception 'This match does not require result reporting.';
  end if;

  if public.is_valid_series_score(
    match_record.format,
    selected_winner_score,
    selected_loser_score
  ) is not true then
    raise exception 'Score is not valid for this match format.';
  end if;

  update public.matches
  set
    winner_id = selected_winner,
    final_winner_score = selected_winner_score,
    final_loser_score = selected_loser_score,
    status = 'finalized',
    result_reported_at = coalesce(result_reported_at, now()),
    finalized_at = now(),
    finalized_by = actor,
    updated_at = now()
  where id = target_match
  returning * into match_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'confirmed',
    jsonb_build_object(
      'winner_id',
      selected_winner,
      'winner_score',
      selected_winner_score,
      'loser_score',
      selected_loser_score,
      'source',
      source
    )
  );

  perform public.advance_single_elimination_winner(match_record, selected_winner, actor);

  return match_record;
end;
$$;

create or replace function public.evaluate_match_reports(
  target_match uuid,
  actor uuid
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  match_record public.matches%rowtype;
  player_one_report public.match_reports%rowtype;
  player_two_report public.match_reports%rowtype;
begin
  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  select *
  into player_one_report
  from public.match_reports
  where match_id = target_match
    and reporter_id = match_record.player_one_id;

  select *
  into player_two_report
  from public.match_reports
  where match_id = target_match
    and reporter_id = match_record.player_two_id;

  if player_one_report.id is null or player_two_report.id is null then
    update public.matches
    set status = 'result_reported', result_reported_at = now(), updated_at = now()
    where id = target_match
    returning * into match_record;

    return match_record;
  end if;

  if player_one_report.reported_winner_id = player_two_report.reported_winner_id
    and player_one_report.reported_winner_score = player_two_report.reported_winner_score
    and player_one_report.reported_loser_score = player_two_report.reported_loser_score then
    return public.finalize_match_winner(
      target_match,
      player_one_report.reported_winner_id,
      player_one_report.reported_winner_score,
      player_one_report.reported_loser_score,
      actor,
      'player_agreement'
    );
  end if;

  update public.matches
  set status = 'result_reported', result_reported_at = now(), updated_at = now()
  where id = target_match
  returning * into match_record;

  if player_one_report.confirmation_state = 'confirmed_current'
    and player_two_report.confirmation_state = 'confirmed_current' then
    insert into public.disputes (match_id, opened_by, status, reason)
    values (
      target_match,
      actor,
      'open',
      'Players confirmed different winners or scores after mismatch review.'
    )
    on conflict (match_id)
    where status in ('open', 'under_review')
    do update set status = excluded.status, updated_at = now();

    update public.matches
    set status = 'disputed', updated_at = now()
    where id = target_match
    returning * into match_record;

    insert into public.match_events (match_id, actor_id, event_type, metadata)
    values (
      target_match,
      actor,
      'disputed',
      jsonb_build_object('reason', 'confirmed_mismatch')
    );
  end if;

  return match_record;
end;
$$;

drop function if exists public.submit_match_report(uuid, uuid, text);
create function public.submit_match_report(
  target_match uuid,
  reported_winner uuid,
  reported_winner_score integer,
  reported_loser_score integer,
  report_notes text default null
)
returns public.match_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  match_record public.matches%rowtype;
  report_record public.match_reports%rowtype;
  previous_report public.match_reports%rowtype;
  next_score_player_one integer;
  next_score_player_two integer;
begin
  if actor is null then
    raise exception 'Sign in to report a result.';
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
    raise exception 'Only match players can report a result.';
  end if;

  if reported_winner not in (match_record.player_one_id, match_record.player_two_id) then
    raise exception 'Reported winner must be one of the match players.';
  end if;

  if match_record.status::text not in ('in_game', 'result_reported') then
    raise exception 'Results can only be reported after the match is in game and before review is finalized.';
  end if;

  if public.is_valid_series_score(
    match_record.format,
    reported_winner_score,
    reported_loser_score
  ) is not true then
    raise exception 'Score is not valid for this match format.';
  end if;

  if reported_winner = match_record.player_one_id then
    next_score_player_one := reported_winner_score;
    next_score_player_two := reported_loser_score;
  else
    next_score_player_one := reported_loser_score;
    next_score_player_two := reported_winner_score;
  end if;

  select *
  into previous_report
  from public.match_reports
  where match_id = target_match
    and reporter_id = actor;

  insert into public.match_reports (
    match_id,
    reporter_id,
    outcome,
    score_player_one,
    score_player_two,
    reported_winner_id,
    reported_winner_score,
    reported_loser_score,
    notes,
    confirmation_state,
    confirmed_at,
    updated_at,
    changed_at
  )
  values (
    target_match,
    actor,
    public.report_outcome_for_winner(match_record, reported_winner),
    next_score_player_one,
    next_score_player_two,
    reported_winner,
    reported_winner_score,
    reported_loser_score,
    nullif(left(coalesce(report_notes, ''), 1000), ''),
    'pending',
    null,
    now(),
    case
      when previous_report.id is null
        or (
          previous_report.reported_winner_id = reported_winner
          and previous_report.reported_winner_score = reported_winner_score
          and previous_report.reported_loser_score = reported_loser_score
        ) then null
      else now()
    end
  )
  on conflict (match_id, reporter_id)
  do update set
    outcome = excluded.outcome,
    score_player_one = excluded.score_player_one,
    score_player_two = excluded.score_player_two,
    reported_winner_id = excluded.reported_winner_id,
    reported_winner_score = excluded.reported_winner_score,
    reported_loser_score = excluded.reported_loser_score,
    notes = excluded.notes,
    confirmation_state = 'pending',
    confirmed_at = null,
    updated_at = now(),
    report_version = match_reports.report_version + 1,
    changed_at = case
      when match_reports.reported_winner_id is distinct from excluded.reported_winner_id
        or match_reports.reported_winner_score is distinct from excluded.reported_winner_score
        or match_reports.reported_loser_score is distinct from excluded.reported_loser_score then now()
      else match_reports.changed_at
    end
  returning * into report_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'result_reported',
    jsonb_build_object(
      'winner_id',
      reported_winner,
      'winner_score',
      reported_winner_score,
      'loser_score',
      reported_loser_score,
      'report_id',
      report_record.id
    )
  );

  perform public.evaluate_match_reports(target_match, actor);

  return report_record;
end;
$$;

drop function if exists public.resolve_match_dispute(uuid, text, uuid, text);
create function public.resolve_match_dispute(
  target_match uuid,
  resolution_action text,
  selected_winner uuid default null,
  selected_winner_score integer default null,
  selected_loser_score integer default null,
  resolution_notes text default null
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
    raise exception 'Only tournament staff can resolve this match.';
  end if;

  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  if resolution_action not in ('confirm_winner', 'replay_required', 'no_contest') then
    raise exception 'Unsupported dispute resolution.';
  end if;

  if resolution_action = 'confirm_winner' then
    if selected_winner not in (match_record.player_one_id, match_record.player_two_id) then
      raise exception 'Select one of the match players as winner.';
    end if;

    if public.is_valid_series_score(
      match_record.format,
      selected_winner_score,
      selected_loser_score
    ) is not true then
      raise exception 'Score is not valid for this match format.';
    end if;

    update public.disputes
    set
      status = 'resolved',
      resolved_by = actor,
      resolution_type = resolution_action,
      resolution_winner_id = selected_winner,
      resolution_note = nullif(left(coalesce(resolution_notes, ''), 1000), ''),
      resolution = nullif(left(coalesce(resolution_notes, ''), 1000), ''),
      resolved_at = now(),
      updated_at = now()
    where match_id = target_match
      and status in ('open', 'under_review');

    return public.finalize_match_winner(
      target_match,
      selected_winner,
      selected_winner_score,
      selected_loser_score,
      actor,
      'staff_resolution'
    );
  end if;

  update public.disputes
  set
    status = 'resolved',
    resolved_by = actor,
    resolution_type = resolution_action,
    resolution_winner_id = null,
    resolution_note = nullif(left(coalesce(resolution_notes, ''), 1000), ''),
    resolution = nullif(left(coalesce(resolution_notes, ''), 1000), ''),
    resolved_at = now(),
    updated_at = now()
  where match_id = target_match
    and status in ('open', 'under_review');

  if resolution_action = 'replay_required' then
    update public.matches
    set
      status = 'replay_required',
      winner_id = null,
      final_winner_score = null,
      final_loser_score = null,
      finalized_at = null,
      finalized_by = null,
      updated_at = now()
    where id = target_match
    returning * into match_record;
  else
    update public.matches
    set
      status = 'finalized',
      winner_id = null,
      final_winner_score = null,
      final_loser_score = null,
      finalized_at = now(),
      finalized_by = actor,
      updated_at = now()
    where id = target_match
    returning * into match_record;
  end if;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'resolved',
    jsonb_build_object('resolution_action', resolution_action)
  );

  return match_record;
end;
$$;

create or replace function public.notify_report_mismatch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  match_record public.matches%rowtype;
  player_one_report public.match_reports%rowtype;
  player_two_report public.match_reports%rowtype;
  player_id uuid;
begin
  select *
  into match_record
  from public.matches
  where id = new.match_id;

  if not found then
    return new;
  end if;

  select *
  into player_one_report
  from public.match_reports
  where match_id = new.match_id
    and reporter_id = match_record.player_one_id;

  select *
  into player_two_report
  from public.match_reports
  where match_id = new.match_id
    and reporter_id = match_record.player_two_id;

  if player_one_report.id is not null
    and player_two_report.id is not null
    and (
      player_one_report.reported_winner_id <> player_two_report.reported_winner_id
      or player_one_report.reported_winner_score <> player_two_report.reported_winner_score
      or player_one_report.reported_loser_score <> player_two_report.reported_loser_score
    ) then
    foreach player_id in array array[match_record.player_one_id, match_record.player_two_id]
    loop
      perform public.insert_notification_once(
        player_id,
        'reports_do_not_match',
        'Reports do not match',
        'Confirm your current answer or update your winner and score report.',
        '/matches/' || new.match_id::text,
        match_record.tournament_id,
        new.match_id,
        'reports-do-not-match:' || new.match_id::text || ':' || player_id::text
      );
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists notify_report_mismatch on public.match_reports;
create trigger notify_report_mismatch
  after insert or update of reported_winner_id, reported_winner_score, reported_loser_score
  on public.match_reports
  for each row
  execute function public.notify_report_mismatch();

grant execute on function public.required_wins_for_match_format(public.match_format) to authenticated, service_role;
grant execute on function public.is_valid_series_score(public.match_format, integer, integer) to authenticated, service_role;
grant execute on function public.submit_match_report(uuid, uuid, integer, integer, text) to authenticated;
grant execute on function public.resolve_match_dispute(uuid, text, uuid, integer, integer, text) to authenticated;
grant execute on function public.finalize_match_winner(uuid, uuid, integer, integer, uuid, text) to authenticated, service_role;
