-- Milestone 10C: derived group-round availability with global round timer waves.
-- Groups may open their next matches independently, but a round timer starts
-- only when every group has completed the prior group round.

create or replace function public.is_match_resolved_for_timing(match_status public.match_status)
returns boolean
language sql
immutable
as $$
  select match_status in (
    'finalized'::public.match_status,
    'confirmed'::public.match_status,
    'forfeit'::public.match_status,
    'bye'::public.match_status
  )
$$;

create or replace function public.apply_ready_match_openings(target_tournament uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  tournament_record public.tournaments%rowtype;
  group_stage_record public.tournament_stages%rowtype;
  bracket_stage_record public.tournament_stages%rowtype;
  opened_group_count integer := 0;
  opened_bracket_count integer := 0;
  started_group_round integer := null;
  started_bracket_round integer := null;
  next_group_round integer;
  next_bracket_round integer;
  next_group_round_record public.tournament_rounds%rowtype;
  next_bracket_round_record public.tournament_rounds%rowtype;
  group_deadline timestamptz;
  bracket_deadline timestamptz;
  group_duration_minutes integer;
  bracket_duration_minutes integer;
begin
  if actor is not null and not public.is_organizer_for(target_tournament) then
    raise exception 'Only tournament staff can open ready matches.';
  end if;

  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  select *
  into group_stage_record
  from public.tournament_stages
  where tournament_id = target_tournament
    and bracket_type = 'group_stage_playoff'::public.tournament_format
  order by stage_number
  limit 1;

  if found then
    update public.matches m
    set
      status = 'assigned',
      updated_at = now()
    where m.tournament_id = target_tournament
      and m.stage_id = group_stage_record.id
      and m.group_id is not null
      and m.status in ('pending'::public.match_status, 'blocked'::public.match_status)
      and m.player_one_id is not null
      and m.player_two_id is not null
      and m.round_number > 1
      and not exists (
        select 1
        from public.matches previous_match
        where previous_match.tournament_id = m.tournament_id
          and previous_match.group_id = m.group_id
          and previous_match.round_number = m.round_number - 1
          and previous_match.player_one_id is not null
          and previous_match.player_two_id is not null
          and not public.is_match_resolved_for_timing(previous_match.status)
      );

    get diagnostics opened_group_count = row_count;

    update public.tournament_rounds r
    set
      timing_state = 'complete',
      updated_at = now()
    where r.tournament_id = target_tournament
      and r.stage_id = group_stage_record.id
      and exists (
        select 1
        from public.matches m
        where m.round_id = r.id
      )
      and not exists (
        select 1
        from public.matches m
        where m.round_id = r.id
          and m.player_one_id is not null
          and m.player_two_id is not null
          and not public.is_match_resolved_for_timing(m.status)
      );

    select min(m.round_number)
    into next_group_round
    from public.matches m
    where m.tournament_id = target_tournament
      and m.stage_id = group_stage_record.id
      and m.group_id is not null
      and m.player_one_id is not null
      and m.player_two_id is not null
      and not public.is_match_resolved_for_timing(m.status);

    if next_group_round is not null
      and (
        next_group_round = 1
        or not exists (
          select 1
          from public.matches m
          where m.tournament_id = target_tournament
            and m.stage_id = group_stage_record.id
            and m.group_id is not null
            and m.round_number = next_group_round - 1
            and m.player_one_id is not null
            and m.player_two_id is not null
            and not public.is_match_resolved_for_timing(m.status)
        )
      ) then
      select *
      into next_group_round_record
      from public.tournament_rounds
      where tournament_id = target_tournament
        and stage_id = group_stage_record.id
        and round_number = next_group_round
      for update;

      if found and next_group_round_record.timer_started_at is null then
        group_duration_minutes := case
          when next_group_round_record.match_format = 'bo3'::public.match_format
            then tournament_record.group_bo3_round_minutes
          else tournament_record.group_bo1_round_minutes
        end;
        group_deadline := now() + make_interval(mins => group_duration_minutes);

        update public.tournament_rounds
        set
          timer_started_at = now(),
          deadline_at = group_deadline,
          timing_state = 'active',
          updated_at = now()
        where id = next_group_round_record.id;

        update public.tournaments
        set
          current_group_round_deadline = group_deadline,
          timing_state = 'group_round',
          timing_note = 'Group round timer started after all groups reached the round.',
          updated_at = now()
        where id = target_tournament;

        started_group_round := next_group_round;
      end if;
    end if;
  end if;

  select *
  into bracket_stage_record
  from public.tournament_stages
  where tournament_id = target_tournament
    and bracket_type = 'single_elimination'::public.tournament_format
  order by stage_number desc
  limit 1;

  if found then
    update public.matches m
    set
      status = 'assigned',
      updated_at = now()
    where m.tournament_id = target_tournament
      and m.stage_id = bracket_stage_record.id
      and m.group_id is null
      and m.status in ('pending'::public.match_status, 'blocked'::public.match_status)
      and m.player_one_id is not null
      and m.player_two_id is not null;

    get diagnostics opened_bracket_count = row_count;

    update public.tournament_rounds r
    set
      timing_state = 'complete',
      updated_at = now()
    where r.tournament_id = target_tournament
      and r.stage_id = bracket_stage_record.id
      and exists (
        select 1
        from public.matches m
        where m.round_id = r.id
      )
      and not exists (
        select 1
        from public.matches m
        where m.round_id = r.id
          and m.player_one_id is not null
          and m.player_two_id is not null
          and not public.is_match_resolved_for_timing(m.status)
      );

    select min(m.round_number)
    into next_bracket_round
    from public.matches m
    where m.tournament_id = target_tournament
      and m.stage_id = bracket_stage_record.id
      and m.group_id is null
      and m.player_one_id is not null
      and m.player_two_id is not null
      and not public.is_match_resolved_for_timing(m.status);

    if next_bracket_round is not null then
      select *
      into next_bracket_round_record
      from public.tournament_rounds
      where tournament_id = target_tournament
        and stage_id = bracket_stage_record.id
        and round_number = next_bracket_round
      for update;

      if found and next_bracket_round_record.timer_started_at is null then
        bracket_duration_minutes := case
          when next_bracket_round_record.match_format = 'bo5'::public.match_format
            then tournament_record.bracket_bo5_round_minutes
          when next_bracket_round_record.match_format = 'bo3'::public.match_format
            then tournament_record.bracket_bo3_round_minutes
          else tournament_record.bracket_bo1_round_minutes
        end;
        bracket_deadline := now() + make_interval(mins => bracket_duration_minutes);

        update public.tournament_rounds
        set
          timer_started_at = now(),
          deadline_at = bracket_deadline,
          timing_state = 'active',
          updated_at = now()
        where id = next_bracket_round_record.id;

        update public.tournaments
        set
          current_bracket_round_deadline = bracket_deadline,
          timing_state = 'bracket_round',
          timing_note = 'Bracket round timer started when ready matches opened.',
          updated_at = now()
        where id = target_tournament;

        started_bracket_round := next_bracket_round;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'opened_group_matches', opened_group_count,
    'opened_bracket_matches', opened_bracket_count,
    'started_group_round', started_group_round,
    'started_bracket_round', started_bracket_round
  );
end;
$$;

create or replace function public.trigger_apply_ready_match_openings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'finalized'::public.match_status
    and (
      old.status is distinct from new.status
      or old.winner_id is distinct from new.winner_id
      or old.final_winner_score is distinct from new.final_winner_score
      or old.final_loser_score is distinct from new.final_loser_score
    ) then
    perform public.apply_ready_match_openings(new.tournament_id);
  end if;

  return new;
end;
$$;

drop trigger if exists apply_ready_match_openings_on_match_finalized on public.matches;
create trigger apply_ready_match_openings_on_match_finalized
  after update of status, winner_id, final_winner_score, final_loser_score on public.matches
  for each row
  execute function public.trigger_apply_ready_match_openings();

grant execute on function public.apply_ready_match_openings(uuid) to authenticated;

notify pgrst, 'reload schema';
