-- Milestone 9A: group-stage foundation and playoff qualification.

alter type public.tournament_format add value if not exists 'group_stage_playoff';
alter type public.tournament_seeding_method add value if not exists 'group_finish';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'match_result_type') then
    create type public.match_result_type as enum (
      'played',
      'forfeit',
      'bye',
      'no_contest',
      'admin_override'
    );
  end if;
end
$$;

alter table public.tournaments
  add column if not exists group_size integer,
  add column if not exists groups_count integer,
  add column if not exists qualifiers_per_group integer,
  add column if not exists group_stage_format public.match_format;

alter table public.tournaments
  drop constraint if exists tournaments_group_stage_settings_check,
  add constraint tournaments_group_stage_settings_check
    check (
      (
        tournament_format::text = 'single_elimination'
        and group_size is null
        and groups_count is null
        and qualifiers_per_group is null
        and group_stage_format is null
      )
      or (
        tournament_format::text = 'group_stage_playoff'
        and group_size in (4, 8)
        and groups_count > 0
        and qualifiers_per_group in (1, 2)
        and group_stage_format in ('bo1'::public.match_format, 'bo3'::public.match_format)
        and groups_count * qualifiers_per_group in (4, 8, 16)
      )
    );

alter table public.tournament_stages
  drop constraint if exists tournament_stages_bracket_size_check,
  add constraint tournament_stages_bracket_size_check
    check (bracket_size in (4, 8, 16, 32, 64));

create table if not exists public.tournament_groups (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  stage_id uuid not null references public.tournament_stages(id) on delete cascade,
  group_number integer not null check (group_number > 0),
  name text not null check (char_length(name) between 1 and 40),
  draw_method public.tournament_seeding_method not null default 'random',
  generated_by uuid references public.profiles(id) on delete set null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stage_id, group_number),
  unique (tournament_id, name)
);

create table if not exists public.tournament_group_members (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  group_id uuid not null references public.tournament_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  seed integer not null check (seed > 0),
  draw_position integer not null check (draw_position > 0),
  qualifier_seed integer check (qualifier_seed is null or qualifier_seed > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, user_id),
  unique (group_id, seed),
  unique (group_id, draw_position),
  unique (group_id, qualifier_seed)
);

alter table public.matches
  add column if not exists group_id uuid references public.tournament_groups(id) on delete cascade,
  add column if not exists result_type public.match_result_type not null default 'played';

update public.matches
set result_type = 'bye'
where status::text = 'bye'
  and result_type = 'played';

create index if not exists tournament_groups_tournament_stage_idx
  on public.tournament_groups(tournament_id, stage_id, group_number);
create index if not exists tournament_group_members_group_idx
  on public.tournament_group_members(group_id, qualifier_seed, seed);
create index if not exists tournament_group_members_user_idx
  on public.tournament_group_members(user_id);
create index if not exists matches_group_idx
  on public.matches(group_id, match_number);
create index if not exists matches_result_type_idx
  on public.matches(result_type);

alter table public.tournament_groups enable row level security;
alter table public.tournament_group_members enable row level security;

grant usage on type public.match_result_type to anon, authenticated, service_role;
grant select on table public.tournament_groups to anon, authenticated;
grant insert, update, delete on table public.tournament_groups to authenticated;
grant select on table public.tournament_group_members to anon, authenticated;
grant insert, update, delete on table public.tournament_group_members to authenticated;

grant insert (
  name,
  slug,
  description,
  rules,
  status,
  format,
  tournament_format,
  group_size,
  groups_count,
  qualifiers_per_group,
  group_stage_format,
  max_players,
  starts_at,
  registration_closes_at,
  external_community_url,
  created_by
) on table public.tournaments to authenticated;

grant update (
  name,
  slug,
  description,
  rules,
  status,
  format,
  tournament_format,
  group_size,
  groups_count,
  qualifiers_per_group,
  group_stage_format,
  max_players,
  starts_at,
  registration_closes_at,
  external_community_url,
  updated_at
) on table public.tournaments to authenticated;

drop policy if exists "Public can read groups for public tournaments"
  on public.tournament_groups;
drop policy if exists "Tournament staff manage groups"
  on public.tournament_groups;
drop policy if exists "Public can read group members for public tournaments"
  on public.tournament_group_members;
drop policy if exists "Tournament staff manage group members"
  on public.tournament_group_members;

create policy "Public can read groups for public tournaments"
  on public.tournament_groups
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and public.is_public_tournament_status(t.status)
    )
    or public.is_organizer_for(tournament_id)
  );

create policy "Tournament staff manage groups"
  on public.tournament_groups
  for all
  to authenticated
  using (public.is_organizer_for(tournament_id))
  with check (public.is_organizer_for(tournament_id));

create policy "Public can read group members for public tournaments"
  on public.tournament_group_members
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and public.is_public_tournament_status(t.status)
    )
    or public.is_organizer_for(tournament_id)
  );

create policy "Tournament staff manage group members"
  on public.tournament_group_members
  for all
  to authenticated
  using (public.is_organizer_for(tournament_id))
  with check (public.is_organizer_for(tournament_id));

create or replace function public.mark_group_match_forfeit(
  target_match uuid,
  forfeiting_player uuid
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  match_record public.matches%rowtype;
  winning_player uuid;
begin
  if actor is null then
    raise exception 'Sign in to mark a forfeit.';
  end if;

  select *
  into match_record
  from public.matches
  where id = target_match
  for update;

  if not found then
    raise exception 'Match not found.';
  end if;

  if not public.is_organizer_for(match_record.tournament_id) then
    raise exception 'Only tournament staff can mark a group-stage forfeit.';
  end if;

  if match_record.group_id is null then
    raise exception 'Only group-stage matches can be marked as group forfeits.';
  end if;

  if match_record.status::text in ('bye', 'pending') then
    raise exception 'This match cannot be marked as a forfeit.';
  end if;

  if forfeiting_player = match_record.player_one_id then
    winning_player := match_record.player_two_id;
  elsif forfeiting_player = match_record.player_two_id then
    winning_player := match_record.player_one_id;
  else
    raise exception 'Forfeiting player must be one of the match players.';
  end if;

  if winning_player is null then
    raise exception 'A forfeit requires an opponent.';
  end if;

  update public.matches
  set
    winner_id = winning_player,
    final_winner_score = null,
    final_loser_score = null,
    status = 'finalized',
    result_type = 'forfeit',
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
    'resolved',
    jsonb_build_object(
      'resolution_action',
      'forfeit',
      'forfeiting_player_id',
      forfeiting_player,
      'winner_id',
      winning_player
    )
  );

  return match_record;
end;
$$;

create or replace function public.advance_single_elimination_winner(
  completed_match public.matches,
  advancing_winner uuid,
  actor uuid
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  next_match public.matches%rowtype;
  updated_match public.matches%rowtype;
  stage_record public.tournament_stages%rowtype;
  next_position integer;
  next_status public.match_status;
begin
  if completed_match.stage_id is null or completed_match.bracket_position is null then
    return completed_match;
  end if;

  select *
  into stage_record
  from public.tournament_stages
  where id = completed_match.stage_id;

  if not found or stage_record.bracket_type::text <> 'single_elimination' then
    return completed_match;
  end if;

  next_position := ((completed_match.bracket_position - 1) / 2) + 1;

  select *
  into next_match
  from public.matches
  where stage_id = completed_match.stage_id
    and round_number = completed_match.round_number + 1
    and bracket_position = next_position
  for update;

  if not found then
    update public.tournaments
    set status = 'completed', updated_at = now()
    where id = completed_match.tournament_id;

    return completed_match;
  end if;

  if completed_match.bracket_position % 2 = 1 then
    next_match.player_one_id := advancing_winner;
  else
    next_match.player_two_id := advancing_winner;
  end if;

  next_status := case
    when next_match.player_one_id is not null and next_match.player_two_id is not null then 'assigned'::public.match_status
    else 'pending'::public.match_status
  end;

  update public.matches
  set
    player_one_id = next_match.player_one_id,
    player_two_id = next_match.player_two_id,
    status = next_status,
    updated_at = now()
  where id = next_match.id
  returning * into updated_match;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    updated_match.id,
    actor,
    'status_changed',
    jsonb_build_object(
      'action',
      'winner_advanced',
      'from_match_id',
      completed_match.id,
      'winner_id',
      advancing_winner,
      'status',
      updated_match.status
    )
  );

  return completed_match;
end;
$$;

create or replace function public.notify_group_match_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  player_id uuid;
begin
  if new.group_id is not null and new.status = 'assigned' then
    foreach player_id in array array[new.player_one_id, new.player_two_id]
    loop
      perform public.insert_notification_once(
        player_id,
        'group_match_ready',
        'Group match is ready',
        'Open the match room when both players are ready.',
        '/matches/' || new.id::text,
        new.tournament_id,
        new.id,
        'group-match-ready:' || new.id::text || ':' || player_id::text
      );
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists notify_group_match_created on public.matches;
create trigger notify_group_match_created
  after insert on public.matches
  for each row
  execute function public.notify_group_match_created();

create or replace function public.notify_group_member_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.insert_notification_once(
    new.user_id,
    'group_draw_generated',
    'Group draw generated',
    'Your group-stage draw is available.',
    '/tournaments/' || new.tournament_id::text,
    new.tournament_id,
    null,
    'group-draw-generated:' || new.tournament_id::text || ':' || new.user_id::text
  );

  return new;
end;
$$;

drop trigger if exists notify_group_member_created on public.tournament_group_members;
create trigger notify_group_member_created
  after insert on public.tournament_group_members
  for each row
  execute function public.notify_group_member_created();

create or replace function public.notify_playoff_stage_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  member_record record;
begin
  if new.stage_number > 1 and new.bracket_type::text = 'single_elimination' then
    for member_record in
      select distinct user_id
      from public.tournament_group_members
      where tournament_id = new.tournament_id
    loop
      perform public.insert_notification_once(
        member_record.user_id,
        'playoff_bracket_generated',
        'Playoff bracket generated',
        'The playoff bracket is available.',
        '/tournaments/' || new.tournament_id::text,
        new.tournament_id,
        null,
        'playoff-bracket-generated:' || new.tournament_id::text || ':' || member_record.user_id::text
      );
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists notify_playoff_stage_created on public.tournament_stages;
create trigger notify_playoff_stage_created
  after insert on public.tournament_stages
  for each row
  execute function public.notify_playoff_stage_created();

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
      winner_id = null,
      final_winner_score = null,
      final_loser_score = null,
      result_type = 'no_contest',
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

grant execute on function public.mark_group_match_forfeit(uuid, uuid) to authenticated;
grant execute on function public.resolve_match_dispute(uuid, text, uuid, integer, integer, text) to authenticated;
