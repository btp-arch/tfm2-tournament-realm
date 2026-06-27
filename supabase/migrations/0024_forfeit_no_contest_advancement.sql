-- Treat staff-awarded no-contest resolutions with a selected winner as forfeits.
-- This lets organizer review move group standings, playoff generation, and bracket advancement
-- while keeping the result out of public player record/game-stat calculations.

create or replace function public.resolve_match_dispute(
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

  if resolution_action in ('confirm_winner', 'no_contest') then
    if selected_winner not in (match_record.player_one_id, match_record.player_two_id) then
      raise exception 'Select one of the match players as winner.';
    end if;
  end if;

  if resolution_action = 'confirm_winner' then
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
    resolution_winner_id = case when resolution_action = 'no_contest' then selected_winner else null end,
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
      result_type = 'played',
      finalized_at = null,
      finalized_by = null,
      updated_at = now()
    where id = target_match
    returning * into match_record;
  else
    update public.matches
    set
      status = 'finalized',
      winner_id = selected_winner,
      final_winner_score = null,
      final_loser_score = null,
      result_type = 'forfeit',
      result_reported_at = coalesce(result_reported_at, now()),
      finalized_at = now(),
      finalized_by = actor,
      updated_at = now()
    where id = target_match
    returning * into match_record;

    perform public.advance_single_elimination_winner(match_record, selected_winner, actor);
  end if;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'resolved',
    jsonb_build_object(
      'resolution_action',
      resolution_action,
      'winner_id',
      case when resolution_action = 'no_contest' then selected_winner else null end,
      'result_type',
      match_record.result_type
    )
  );

  return match_record;
end;
$$;

grant execute on function public.resolve_match_dispute(uuid, text, uuid, integer, integer, text) to authenticated;

notify pgrst, 'reload schema';
