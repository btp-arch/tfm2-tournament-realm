-- Milestone 10C: organizer-configurable automation policy toggles.
-- Automation remains lazy: page activity or staff actions invoke eligible work.

alter table public.tournaments
  add column if not exists automation_mode text not null default 'manual',
  add column if not exists auto_close_registration_at_deadline boolean not null default false,
  add column if not exists auto_open_check_in_at_start_time boolean not null default false,
  add column if not exists auto_close_check_in_at_deadline boolean not null default false,
  add column if not exists auto_open_replacement_window_if_spots_available boolean not null default false,
  add column if not exists auto_close_replacement_window_at_deadline boolean not null default false,
  add column if not exists auto_generate_draw_after_replacement boolean not null default false,
  add column if not exists auto_apply_match_timeout_outcomes boolean not null default false,
  add column if not exists auto_advance_group_round_waves boolean not null default true,
  add column if not exists auto_generate_playoff_when_groups_resolved boolean not null default false,
  add column if not exists one_checked_in_timeout_policy text not null default 'forfeit_checked_in',
  add column if not exists neither_checked_in_group_policy text not null default 'no_contest',
  add column if not exists neither_checked_in_bracket_policy text not null default 'staff_review',
  add column if not exists both_checked_in_no_result_policy text not null default 'staff_review',
  add column if not exists one_report_no_response_policy text not null default 'staff_review',
  add column if not exists automation_paused_at timestamptz,
  add column if not exists last_automation_run_at timestamptz;

update public.tournaments
set auto_apply_match_timeout_outcomes = auto_apply_timer_outcomes
where auto_apply_match_timeout_outcomes is distinct from auto_apply_timer_outcomes;

update public.tournaments
set automation_mode = case
  when automation_mode = 'hands_off' then 'automatic'
  else 'manual'
end
where automation_mode in ('assisted', 'hands_off');

alter table public.tournaments
  drop constraint if exists tournaments_automation_mode_known,
  add constraint tournaments_automation_mode_known
    check (automation_mode in ('manual', 'automatic')),
  drop constraint if exists tournaments_one_checked_in_timeout_policy_known,
  add constraint tournaments_one_checked_in_timeout_policy_known
    check (one_checked_in_timeout_policy in ('forfeit_checked_in', 'staff_review')),
  drop constraint if exists tournaments_neither_checked_in_group_policy_known,
  add constraint tournaments_neither_checked_in_group_policy_known
    check (neither_checked_in_group_policy in ('no_contest', 'random_advancement', 'staff_review')),
  drop constraint if exists tournaments_neither_checked_in_bracket_policy_known,
  add constraint tournaments_neither_checked_in_bracket_policy_known
    check (neither_checked_in_bracket_policy in ('no_contest', 'random_advancement', 'staff_review')),
  drop constraint if exists tournaments_both_checked_in_no_result_policy_known,
  add constraint tournaments_both_checked_in_no_result_policy_known
    check (both_checked_in_no_result_policy in ('no_contest', 'staff_review')),
  drop constraint if exists tournaments_one_report_no_response_policy_known,
  add constraint tournaments_one_report_no_response_policy_known
    check (one_report_no_response_policy = 'staff_review');

create table if not exists public.tournament_automation_events (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 80),
  actor_type text not null default 'organizer' check (actor_type in ('system', 'organizer', 'admin')),
  actor_id uuid references public.profiles(id) on delete set null,
  source text not null default 'live_control' check (source in ('live_control', 'page_poll', 'manual_button')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.tournament_automation_events enable row level security;

create index if not exists tournament_automation_events_tournament_created_idx
  on public.tournament_automation_events(tournament_id, created_at desc);

drop policy if exists "Public can read automation events for public tournaments"
  on public.tournament_automation_events;
create policy "Public can read automation events for public tournaments"
  on public.tournament_automation_events
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and (
          t.status <> 'draft'
          or t.created_by = auth.uid()
          or public.is_organizer_for(t.id)
        )
    )
  );

drop policy if exists "Tournament staff insert automation events"
  on public.tournament_automation_events;
create policy "Tournament staff insert automation events"
  on public.tournament_automation_events
  for insert
  to authenticated
  with check (
    public.is_organizer_for(tournament_id)
    and (
      actor_id = auth.uid()
      or actor_type = 'system'
    )
  );

grant select on table public.tournament_automation_events to anon, authenticated;
grant insert on table public.tournament_automation_events to authenticated;

grant insert (
  auto_apply_match_timeout_outcomes,
  auto_close_check_in_at_deadline,
  auto_close_registration_at_deadline,
  auto_close_replacement_window_at_deadline,
  auto_generate_draw_after_replacement,
  auto_generate_playoff_when_groups_resolved,
  auto_open_check_in_at_start_time,
  auto_open_replacement_window_if_spots_available,
  auto_advance_group_round_waves,
  automation_mode,
  automation_paused_at,
  both_checked_in_no_result_policy,
  last_automation_run_at,
  neither_checked_in_bracket_policy,
  neither_checked_in_group_policy,
  one_checked_in_timeout_policy,
  one_report_no_response_policy
) on table public.tournaments to authenticated;

grant update (
  auto_apply_match_timeout_outcomes,
  auto_apply_timer_outcomes,
  auto_close_check_in_at_deadline,
  auto_close_registration_at_deadline,
  auto_close_replacement_window_at_deadline,
  auto_generate_draw_after_replacement,
  auto_generate_playoff_when_groups_resolved,
  auto_open_check_in_at_start_time,
  auto_open_replacement_window_if_spots_available,
  auto_advance_group_round_waves,
  automation_mode,
  automation_paused_at,
  both_checked_in_no_result_policy,
  last_automation_run_at,
  neither_checked_in_bracket_policy,
  neither_checked_in_group_policy,
  one_checked_in_timeout_policy,
  one_report_no_response_policy,
  updated_at
) on table public.tournaments to authenticated;

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
  random_winner uuid;
  finalized_count integer := 0;
  no_contest_count integer := 0;
  random_advancement_count integer := 0;
  review_count integer := 0;
  ignored_count integer := 0;
  round_deadline timestamptz;
  round_scope integer;
  neither_policy text;
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

  if tournament_record.timers_paused_at is not null or tournament_record.automation_paused_at is not null then
    raise exception 'Timers or automation are paused. Resume before applying expired actions.';
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
        'group_id', target_group,
        'match_check_ins', check_in_count,
        'reports', report_count,
        'neither_checked_in_policy', neither_policy,
        'random_advancement', random_winner is not null
      )
    );
  end loop;

  update public.tournaments
  set
    timing_state = 'expired',
    timing_note = case
      when target_phase = 'group' then 'Expired group round outcomes applied.'
      else 'Expired bracket round outcomes applied.'
    end,
    last_automation_run_at = now(),
    updated_at = now()
  where id = target_tournament;

  return jsonb_build_object(
    'round_number', round_scope,
    'forfeit_count', finalized_count,
    'no_contest_count', no_contest_count,
    'random_advancement_count', random_advancement_count,
    'review_count', review_count,
    'ignored_count', ignored_count
  );
end;
$$;

grant execute on function public.apply_expired_round_outcomes(uuid, text, integer, uuid) to authenticated;

notify pgrst, 'reload schema';
