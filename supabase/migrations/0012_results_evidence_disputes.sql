-- Milestone 6: player result reports, evidence, disputes, and single-elimination advancement.

alter table public.matches
  add column if not exists result_reported_at timestamptz,
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by uuid references public.profiles(id) on delete set null;

alter table public.match_reports
  add column if not exists reported_winner_id uuid references public.profiles(id) on delete restrict,
  add column if not exists confirmation_state text not null default 'pending',
  add column if not exists confirmed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists report_version integer not null default 1,
  add column if not exists changed_at timestamptz;

alter table public.match_reports
  drop constraint if exists match_reports_confirmation_state_check,
  add constraint match_reports_confirmation_state_check
    check (confirmation_state in ('pending', 'confirmed_current')),
  drop constraint if exists match_reports_report_version_positive,
  add constraint match_reports_report_version_positive
    check (report_version > 0);

update public.match_reports
set reported_winner_id = case
  when outcome = 'player_one_win' then m.player_one_id
  when outcome = 'player_two_win' then m.player_two_id
  else reported_winner_id
end
from public.matches m
where m.id = match_reports.match_id
  and match_reports.reported_winner_id is null;

alter table public.match_reports
  alter column reported_winner_id set not null;

alter table public.match_evidence
  add column if not exists match_id uuid references public.matches(id) on delete cascade,
  add column if not exists evidence_type text not null default 'other',
  add column if not exists file_path text,
  add column if not exists file_name text,
  add column if not exists mime_type text,
  add column if not exists file_size_bytes integer,
  add column if not exists notes text,
  add column if not exists expires_at timestamptz not null default (now() + interval '30 days'),
  add column if not exists retained_by_admin boolean not null default false;

update public.match_evidence e
set
  match_id = r.match_id,
  file_path = coalesce(e.file_path, e.storage_path),
  file_name = coalesce(e.file_name, nullif(regexp_replace(e.storage_path, '^.*/', ''), ''), 'legacy-evidence'),
  mime_type = coalesce(e.mime_type, 'image/png'),
  file_size_bytes = coalesce(e.file_size_bytes, 1),
  notes = coalesce(e.notes, e.caption)
from public.match_reports r
where r.id = e.match_report_id
  and (
    e.match_id is null
    or e.file_path is null
    or e.file_name is null
    or e.mime_type is null
    or e.file_size_bytes is null
  );

alter table public.match_evidence
  alter column match_id set not null,
  alter column file_path set not null,
  alter column file_name set not null,
  alter column mime_type set not null,
  alter column file_size_bytes set not null,
  drop constraint if exists match_evidence_evidence_type_check,
  add constraint match_evidence_evidence_type_check
    check (evidence_type in ('result_screen', 'lobby_setup', 'no_show', 'disconnect', 'chat_proof', 'other')),
  drop constraint if exists match_evidence_mime_type_check,
  add constraint match_evidence_mime_type_check
    check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  drop constraint if exists match_evidence_file_size_check,
  add constraint match_evidence_file_size_check
    check (file_size_bytes > 0 and file_size_bytes <= 5242880),
  drop constraint if exists match_evidence_file_path_bucket_check,
  add constraint match_evidence_file_path_bucket_check
    check (file_path like 'match-evidence/%');

alter table public.disputes
  add column if not exists resolved_by uuid references public.profiles(id) on delete set null,
  add column if not exists resolution_type text,
  add column if not exists resolution_winner_id uuid references public.profiles(id) on delete set null,
  add column if not exists resolution_note text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.disputes
  drop constraint if exists disputes_resolution_type_check,
  add constraint disputes_resolution_type_check
    check (resolution_type is null or resolution_type in ('confirm_winner', 'replay_required', 'no_contest'));

create index if not exists match_reports_match_idx on public.match_reports(match_id);
create index if not exists match_evidence_match_idx on public.match_evidence(match_id, created_at);
create index if not exists matches_stage_round_position_idx
  on public.matches(stage_id, round_number, bracket_position);
create index if not exists disputes_match_open_idx
  on public.disputes(match_id, status)
  where status in ('open', 'under_review');

create unique index if not exists disputes_one_open_per_match_idx
  on public.disputes(match_id)
  where status in ('open', 'under_review');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'match-evidence',
  'match-evidence',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

create or replace function public.report_outcome_for_winner(
  target_match public.matches,
  winner uuid
)
returns public.report_outcome
language plpgsql
stable
set search_path = public
as $$
begin
  if winner = target_match.player_one_id then
    return 'player_one_win'::public.report_outcome;
  end if;

  if winner = target_match.player_two_id then
    return 'player_two_win'::public.report_outcome;
  end if;

  raise exception 'Winner must be one of the match players.';
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
  next_position integer;
  next_status public.match_status;
begin
  if completed_match.stage_id is null or completed_match.bracket_position is null then
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

create or replace function public.finalize_match_winner(
  target_match uuid,
  selected_winner uuid,
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

  update public.matches
  set
    winner_id = selected_winner,
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
    jsonb_build_object('winner_id', selected_winner, 'source', source)
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

  if player_one_report.reported_winner_id = player_two_report.reported_winner_id then
    return public.finalize_match_winner(
      target_match,
      player_one_report.reported_winner_id,
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
      'Players confirmed different winners after mismatch review.'
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

create or replace function public.submit_match_report(
  target_match uuid,
  reported_winner uuid,
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
  previous_winner uuid;
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

  select reported_winner_id
  into previous_winner
  from public.match_reports
  where match_id = target_match
    and reporter_id = actor;

  insert into public.match_reports (
    match_id,
    reporter_id,
    outcome,
    reported_winner_id,
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
    reported_winner,
    nullif(left(coalesce(report_notes, ''), 1000), ''),
    'pending',
    null,
    now(),
    case when previous_winner is null or previous_winner = reported_winner then null else now() end
  )
  on conflict (match_id, reporter_id)
  do update set
    outcome = excluded.outcome,
    reported_winner_id = excluded.reported_winner_id,
    notes = excluded.notes,
    confirmation_state = 'pending',
    confirmed_at = null,
    updated_at = now(),
    report_version = match_reports.report_version + 1,
    changed_at = case
      when match_reports.reported_winner_id is distinct from excluded.reported_winner_id then now()
      else match_reports.changed_at
    end
  returning * into report_record;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'result_reported',
    jsonb_build_object('winner_id', reported_winner, 'report_id', report_record.id)
  );

  perform public.evaluate_match_reports(target_match, actor);

  return report_record;
end;
$$;

create or replace function public.confirm_match_report(target_match uuid)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  report_record public.match_reports%rowtype;
begin
  if actor is null then
    raise exception 'Sign in to confirm a report.';
  end if;

  update public.match_reports
  set
    confirmation_state = 'confirmed_current',
    confirmed_at = now(),
    updated_at = now()
  where match_id = target_match
    and reporter_id = actor
  returning * into report_record;

  if not found then
    raise exception 'Submit a report before confirming it.';
  end if;

  insert into public.match_events (match_id, actor_id, event_type, metadata)
  values (
    target_match,
    actor,
    'note',
    jsonb_build_object('action', 'confirmed_current_report', 'report_id', report_record.id)
  );

  return public.evaluate_match_reports(target_match, actor);
end;
$$;

create or replace function public.resolve_match_dispute(
  target_match uuid,
  resolution_action text,
  selected_winner uuid default null,
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

    return public.finalize_match_winner(target_match, selected_winner, actor, 'staff_resolution');
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
    set status = 'replay_required', winner_id = null, finalized_at = null, finalized_by = null, updated_at = now()
    where id = target_match
    returning * into match_record;
  else
    update public.matches
    set status = 'finalized', winner_id = null, finalized_at = now(), finalized_by = actor, updated_at = now()
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

create or replace function public.prevent_too_many_match_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    select count(*)
    from public.match_evidence
    where match_report_id = new.match_report_id
      and id <> coalesce(new.id, gen_random_uuid())
  ) >= 3 then
    raise exception 'A report can have at most 3 evidence uploads.';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_too_many_match_evidence on public.match_evidence;
create trigger prevent_too_many_match_evidence
  before insert on public.match_evidence
  for each row
  execute function public.prevent_too_many_match_evidence();

grant usage on type public.report_outcome to authenticated, service_role;
grant select on table public.match_reports to authenticated;
grant insert, update on table public.match_reports to authenticated;
grant select, insert, update on table public.match_evidence to authenticated;
grant select, insert, update on table public.disputes to authenticated;

grant execute on function public.submit_match_report(uuid, uuid, text) to authenticated;
grant execute on function public.confirm_match_report(uuid) to authenticated;
grant execute on function public.resolve_match_dispute(uuid, text, uuid, text) to authenticated;

drop policy if exists "Participants create own reports" on public.match_reports;
drop policy if exists "Participants update own reports" on public.match_reports;
drop policy if exists "Report owners upload evidence" on public.match_evidence;
drop policy if exists "Evidence owners update retention" on public.match_evidence;
drop policy if exists "Staff update evidence retention" on public.match_evidence;

create policy "Participants create own reports"
  on public.match_reports
  for insert
  to authenticated
  with check (
    reporter_id = auth.uid()
    and exists (
      select 1
      from public.matches m
      where m.id = match_id
        and auth.uid() in (m.player_one_id, m.player_two_id)
        and reported_winner_id in (m.player_one_id, m.player_two_id)
        and m.status::text in ('in_game', 'result_reported')
    )
  );

create policy "Participants update own reports"
  on public.match_reports
  for update
  to authenticated
  using (
    reporter_id = auth.uid()
    and public.is_match_participant(match_id)
  )
  with check (
    reporter_id = auth.uid()
    and exists (
      select 1
      from public.matches m
      where m.id = match_id
        and auth.uid() in (m.player_one_id, m.player_two_id)
        and reported_winner_id in (m.player_one_id, m.player_two_id)
        and m.status::text in ('in_game', 'result_reported')
    )
  );

create policy "Report owners upload evidence"
  on public.match_evidence
  for insert
  to authenticated
  with check (
    uploaded_by = auth.uid()
    and file_path like 'match-evidence/' || match_id::text || '/' || auth.uid()::text || '/%'
    and exists (
      select 1
      from public.match_reports r
      where r.id = match_report_id
        and r.match_id = match_evidence.match_id
        and r.reporter_id = auth.uid()
    )
  );

create policy "Staff update evidence retention"
  on public.match_evidence
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.matches m
      where m.id = match_id
        and public.is_organizer_for(m.tournament_id)
    )
  )
  with check (
    exists (
      select 1
      from public.matches m
      where m.id = match_id
        and public.is_organizer_for(m.tournament_id)
    )
  );

drop policy if exists "Participants upload match evidence objects" on storage.objects;
drop policy if exists "Evidence viewers read match evidence objects" on storage.objects;

create policy "Participants upload match evidence objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'match-evidence'
    and (storage.foldername(name))[1] is not null
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1
      from public.matches m
      where m.id = ((storage.foldername(name))[1])::uuid
        and auth.uid() in (m.player_one_id, m.player_two_id)
    )
  );

create policy "Evidence viewers read match evidence objects"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'match-evidence'
    and (storage.foldername(name))[1] is not null
    and exists (
      select 1
      from public.matches m
      where m.id = ((storage.foldername(name))[1])::uuid
        and (
          auth.uid() in (m.player_one_id, m.player_two_id)
          or public.is_organizer_for(m.tournament_id)
        )
    )
  );
