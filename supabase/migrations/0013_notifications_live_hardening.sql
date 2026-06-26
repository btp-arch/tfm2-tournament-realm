-- Milestone 7B: notifications and match setup hardening.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (char_length(type) between 3 and 80),
  title text not null check (char_length(title) between 1 and 140),
  body text not null default '' check (char_length(body) <= 500),
  link_url text check (link_url is null or left(link_url, 1) = '/'),
  related_tournament_id uuid references public.tournaments(id) on delete cascade,
  related_match_id uuid references public.matches(id) on delete cascade,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications(user_id, created_at desc)
  where read_at is null;
create index if not exists notifications_related_match_idx
  on public.notifications(related_match_id);
create unique index if not exists notifications_user_dedupe_idx
  on public.notifications(user_id, dedupe_key)
  where dedupe_key is not null;

alter table public.notifications enable row level security;

grant select, update, delete on table public.notifications to authenticated;

drop policy if exists "Users read own notifications" on public.notifications;
drop policy if exists "Users update own notifications" on public.notifications;
drop policy if exists "Users delete own notifications" on public.notifications;
drop policy if exists "Admins manage notifications" on public.notifications;

create policy "Users read own notifications"
  on public.notifications
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "Users update own notifications"
  on public.notifications
  for update
  to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy "Users delete own notifications"
  on public.notifications
  for delete
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

create or replace function public.insert_notification_once(
  target_user uuid,
  notification_type text,
  notification_title text,
  notification_body text,
  notification_link text,
  tournament_id uuid,
  match_id uuid,
  notification_dedupe_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_user is null then
    return;
  end if;

  insert into public.notifications (
    user_id,
    type,
    title,
    body,
    link_url,
    related_tournament_id,
    related_match_id,
    dedupe_key
  )
  select
    target_user,
    notification_type,
    left(notification_title, 140),
    left(coalesce(notification_body, ''), 500),
    notification_link,
    tournament_id,
    match_id,
    notification_dedupe_key
  where notification_dedupe_key is null
    or not exists (
      select 1
      from public.notifications n
      where n.user_id = target_user
        and n.dedupe_key = notification_dedupe_key
    );
end;
$$;

revoke all on function public.insert_notification_once(uuid, text, text, text, text, uuid, uuid, text)
  from public, anon, authenticated;

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  updated_count integer;
begin
  if actor is null then
    raise exception 'Sign in to update notifications.';
  end if;

  update public.notifications
  set read_at = now()
  where user_id = actor
    and read_at is null;

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

create or replace function public.notify_tournament_check_in_opened()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  registration_record record;
begin
  if new.status = 'check_in'
    and old.status is distinct from new.status then
    for registration_record in
      select user_id
      from public.tournament_registrations
      where tournament_id = new.id
        and status <> 'withdrawn'
    loop
      perform public.insert_notification_once(
        registration_record.user_id,
        'tournament_check_in_opened',
        'Tournament check-in is open',
        new.name || ' is ready for player check-in.',
        '/tournaments/' || new.id::text,
        new.id,
        null,
        'tournament-check-in-opened:' || new.id::text
      );
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists notify_tournament_check_in_opened on public.tournaments;
create trigger notify_tournament_check_in_opened
  after update of status on public.tournaments
  for each row
  execute function public.notify_tournament_check_in_opened();

create or replace function public.notify_match_check_in_inserted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  match_record public.matches%rowtype;
  opponent uuid;
begin
  select *
  into match_record
  from public.matches
  where id = new.match_id;

  if not found then
    return new;
  end if;

  opponent := case
    when new.user_id = match_record.player_one_id then match_record.player_two_id
    when new.user_id = match_record.player_two_id then match_record.player_one_id
    else null
  end;

  perform public.insert_notification_once(
    opponent,
    'opponent_checked_in',
    'Opponent checked in',
    'Your opponent checked in for the match.',
    '/matches/' || new.match_id::text,
    match_record.tournament_id,
    new.match_id,
    'opponent-checked-in:' || new.match_id::text || ':' || new.user_id::text
  );

  return new;
end;
$$;

drop trigger if exists notify_match_check_in_inserted on public.match_check_ins;
create trigger notify_match_check_in_inserted
  after insert on public.match_check_ins
  for each row
  execute function public.notify_match_check_in_inserted();

create or replace function public.notify_match_state_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  player_id uuid;
begin
  if new.status = 'awaiting_host_setup'
    and old.status is distinct from new.status then
    foreach player_id in array array[new.player_one_id, new.player_two_id]
    loop
      perform public.insert_notification_once(
        player_id,
        'match_room_ready',
        'Match room is ready',
        'Check in is complete. Open the match room for lobby setup.',
        '/matches/' || new.id::text,
        new.tournament_id,
        new.id,
        'match-room-ready:' || new.id::text || ':' || player_id::text
      );
    end loop;

    perform public.insert_notification_once(
      new.host_user_id,
      'player_assigned_host',
      'You are the host',
      'Create the public friendly lobby and mark Match Created.',
      '/matches/' || new.id::text,
      new.tournament_id,
      new.id,
      'player-assigned-host:' || new.id::text || ':' || new.host_user_id::text
    );
  end if;

  if new.status = 'in_game'
    and old.status is distinct from new.status then
    foreach player_id in array array[new.player_one_id, new.player_two_id]
    loop
      perform public.insert_notification_once(
        player_id,
        'match_needs_result_report',
        'Report your match result',
        'The match is in progress. Report the winner after the game ends.',
        '/matches/' || new.id::text,
        new.tournament_id,
        new.id,
        'match-needs-result-report:' || new.id::text || ':' || player_id::text
      );
    end loop;
  end if;

  if new.status = 'disputed'
    and old.status is distinct from new.status then
    foreach player_id in array array[new.player_one_id, new.player_two_id]
    loop
      perform public.insert_notification_once(
        player_id,
        'dispute_opened',
        'Organizer review opened',
        'Player reports do not match and need organizer review.',
        '/matches/' || new.id::text,
        new.tournament_id,
        new.id,
        'dispute-opened:' || new.id::text || ':' || player_id::text
      );
    end loop;
  end if;

  if old.status = 'disputed'
    and new.status is distinct from old.status then
    foreach player_id in array array[new.player_one_id, new.player_two_id]
    loop
      perform public.insert_notification_once(
        player_id,
        'dispute_resolved',
        'Organizer review resolved',
        'The disputed match has been resolved.',
        '/matches/' || new.id::text,
        new.tournament_id,
        new.id,
        'dispute-resolved:' || new.id::text || ':' || player_id::text
      );
    end loop;
  end if;

  if new.winner_id is not null
    and new.winner_id is distinct from old.winner_id
    and new.status in ('confirmed', 'finalized') then
    perform public.insert_notification_once(
      new.winner_id,
      'player_advanced',
      'You advanced',
      'Your result was confirmed and you advanced.',
      '/tournaments/' || new.tournament_id::text,
      new.tournament_id,
      new.id,
      'player-advanced:' || new.id::text || ':' || new.winner_id::text
    );
  end if;

  return new;
end;
$$;

drop trigger if exists notify_match_state_changed on public.matches;
create trigger notify_match_state_changed
  after update of status, winner_id, host_user_id on public.matches
  for each row
  execute function public.notify_match_state_changed();

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
    and player_one_report.reported_winner_id <> player_two_report.reported_winner_id then
    foreach player_id in array array[match_record.player_one_id, match_record.player_two_id]
    loop
      perform public.insert_notification_once(
        player_id,
        'reports_do_not_match',
        'Reports do not match',
        'Confirm your current answer or update your winner report.',
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
  after insert or update of reported_winner_id on public.match_reports
  for each row
  execute function public.notify_report_mismatch();

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

  if match_record.status::text <> 'awaiting_host_setup'
    or match_record.game_created_at is not null
    or match_record.winner_id is not null
    or exists (select 1 from public.match_reports where match_id = target_match)
    or exists (
      select 1
      from public.disputes
      where match_id = target_match
        and status in ('open', 'under_review')
    ) then
    raise exception 'Match is past setup.';
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

grant execute on function public.mark_all_notifications_read()
  to authenticated;
grant execute on function public.mark_match_game_created(uuid)
  to authenticated;
