-- Milestone 10A: lazy tournament timing settings, deadlines, and staff controls.
-- Follow-up 10B can use these fields to drive automated overdue match review:
-- - one player checked into a match room and the other did not: staff may award FF
-- - neither player checked in: staff may mark no contest
-- - both checked in but no result: staff review or no contest
-- - one player submitted a result and the other did not: prefer organizer review

alter table public.tournaments
  add column if not exists check_in_window_minutes integer not null default 10,
  add column if not exists replacement_window_minutes integer not null default 5,
  add column if not exists replacement_window_enabled boolean not null default true,
  add column if not exists group_bo1_round_minutes integer not null default 20,
  add column if not exists group_bo3_round_minutes integer not null default 45,
  add column if not exists bracket_bo1_round_minutes integer not null default 20,
  add column if not exists bracket_bo3_round_minutes integer not null default 45,
  add column if not exists bracket_bo5_round_minutes integer not null default 70,
  add column if not exists independent_group_progression boolean not null default true,
  add column if not exists auto_open_ready_matches boolean not null default true,
  add column if not exists auto_apply_timer_outcomes boolean not null default false,
  add column if not exists timers_paused_at timestamptz,
  add column if not exists total_paused_seconds integer not null default 0,
  add column if not exists current_check_in_deadline timestamptz,
  add column if not exists current_replacement_deadline timestamptz,
  add column if not exists current_group_round_deadline timestamptz,
  add column if not exists current_bracket_round_deadline timestamptz,
  add column if not exists timing_state text not null default 'idle',
  add column if not exists timing_note text;

alter table public.tournaments
  drop constraint if exists tournaments_timing_minutes_range,
  add constraint tournaments_timing_minutes_range
    check (
      check_in_window_minutes between 1 and 240
      and replacement_window_minutes between 1 and 240
      and group_bo1_round_minutes between 1 and 240
      and group_bo3_round_minutes between 1 and 240
      and bracket_bo1_round_minutes between 1 and 240
      and bracket_bo3_round_minutes between 1 and 240
      and bracket_bo5_round_minutes between 1 and 240
    ),
  drop constraint if exists tournaments_total_paused_seconds_nonnegative,
  add constraint tournaments_total_paused_seconds_nonnegative
    check (total_paused_seconds >= 0),
  drop constraint if exists tournaments_timing_state_known,
  add constraint tournaments_timing_state_known
    check (
      timing_state in (
        'idle',
        'check_in',
        'replacement',
        'group_round',
        'bracket_round',
        'paused',
        'active',
        'expired'
      )
    ),
  drop constraint if exists tournaments_timing_note_length,
  add constraint tournaments_timing_note_length
    check (timing_note is null or char_length(timing_note) <= 1000);

alter table public.tournament_rounds
  add column if not exists timer_started_at timestamptz,
  add column if not exists deadline_at timestamptz,
  add column if not exists timing_state text not null default 'idle';

alter table public.tournament_rounds
  drop constraint if exists tournament_rounds_timing_state_known,
  add constraint tournament_rounds_timing_state_known
    check (timing_state in ('idle', 'active', 'paused', 'expired', 'complete'));

create index if not exists tournaments_timing_deadlines_idx
  on public.tournaments(current_check_in_deadline, current_replacement_deadline, current_group_round_deadline, current_bracket_round_deadline);

create index if not exists tournament_rounds_deadline_idx
  on public.tournament_rounds(tournament_id, deadline_at);

grant insert (
  auto_apply_timer_outcomes,
  auto_open_ready_matches,
  bracket_bo1_round_minutes,
  bracket_bo3_round_minutes,
  bracket_bo5_round_minutes,
  check_in_window_minutes,
  current_bracket_round_deadline,
  current_check_in_deadline,
  current_group_round_deadline,
  current_replacement_deadline,
  group_bo1_round_minutes,
  group_bo3_round_minutes,
  independent_group_progression,
  replacement_window_enabled,
  replacement_window_minutes,
  timers_paused_at,
  timing_note,
  timing_state,
  total_paused_seconds
) on table public.tournaments to authenticated;

grant update (
  auto_apply_timer_outcomes,
  auto_open_ready_matches,
  bracket_bo1_round_minutes,
  bracket_bo3_round_minutes,
  bracket_bo5_round_minutes,
  check_in_window_minutes,
  current_bracket_round_deadline,
  current_check_in_deadline,
  current_group_round_deadline,
  current_replacement_deadline,
  group_bo1_round_minutes,
  group_bo3_round_minutes,
  independent_group_progression,
  replacement_window_enabled,
  replacement_window_minutes,
  timers_paused_at,
  timing_note,
  timing_state,
  total_paused_seconds,
  updated_at
) on table public.tournaments to authenticated;

grant insert (
  deadline_at,
  timing_state,
  timer_started_at
) on table public.tournament_rounds to authenticated;

grant update (
  deadline_at,
  timing_state,
  timer_started_at,
  updated_at
) on table public.tournament_rounds to authenticated;

notify pgrst, 'reload schema';
