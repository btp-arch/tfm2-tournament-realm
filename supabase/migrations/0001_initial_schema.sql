-- TFM2 Tournament Realm initial schema
create extension if not exists pgcrypto;

create type public.platform_role as enum ('player','organizer','admin');
create type public.tournament_status as enum ('draft','published','registration_open','registration_closed','in_progress','completed','cancelled');
create type public.registration_status as enum ('pending','checked_in','withdrawn','accepted','rejected');
create type public.match_format as enum ('bo1','bo3','bo5');
create type public.match_status as enum ('assigned','check_in_open','awaiting_host_setup','awaiting_guest_join','in_game','result_reported','confirmed','disputed','replay_required','forfeit','finalized');
create type public.side_choice as enum ('red','blue');
create type public.match_event_type as enum ('status_changed','check_in','host_assigned','host_setup','guest_joined','game_started','result_reported','confirmed','disputed','resolved','note');
create type public.report_outcome as enum ('player_one_win','player_two_win','forfeit_player_one','forfeit_player_two','replay_required');
create type public.confirmation_status as enum ('confirmed','disputed');
create type public.dispute_status as enum ('open','under_review','resolved','rejected');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  tfm2_handle text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.platform_role not null,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  description text,
  rules text,
  status public.tournament_status not null default 'draft',
  format public.match_format not null default 'bo1',
  max_players integer check (max_players is null or max_players > 1),
  starts_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tournament_organizers (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create table public.tournament_registrations (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status public.registration_status not null default 'pending',
  seed integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, user_id)
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  round_number integer not null default 1,
  player_one_id uuid not null references public.profiles(id) on delete restrict,
  player_two_id uuid not null references public.profiles(id) on delete restrict,
  format public.match_format not null default 'bo1',
  status public.match_status not null default 'assigned',
  host_user_id uuid references public.profiles(id) on delete set null,
  host_side_choice public.side_choice,
  winner_id uuid references public.profiles(id) on delete set null,
  scheduled_at timestamptz,
  check_in_opens_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (player_one_id <> player_two_id)
);

create table public.match_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type public.match_event_type not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.match_reports (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  outcome public.report_outcome not null,
  score_player_one integer not null default 0,
  score_player_two integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  unique (match_id, reporter_id)
);

create table public.match_evidence (
  id uuid primary key default gen_random_uuid(),
  match_report_id uuid not null references public.match_reports(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  caption text,
  created_at timestamptz not null default now()
);

create table public.match_confirmations (
  id uuid primary key default gen_random_uuid(),
  match_report_id uuid not null references public.match_reports(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status public.confirmation_status not null,
  notes text,
  created_at timestamptz not null default now(),
  unique (match_report_id, user_id)
);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  opened_by uuid not null references public.profiles(id) on delete cascade,
  assigned_to uuid references public.profiles(id) on delete set null,
  status public.dispute_status not null default 'open',
  reason text not null,
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.organizer_feedback (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  submitted_by uuid not null references public.profiles(id) on delete cascade,
  rating integer check (rating between 1 and 5),
  comments text,
  created_at timestamptz not null default now()
);

create index on public.tournaments(status);
create index on public.tournament_registrations(user_id);
create index on public.matches(tournament_id, status);
create index on public.matches(player_one_id);
create index on public.matches(player_two_id);
create index on public.match_events(match_id, created_at);
create index on public.disputes(match_id, status);

alter table public.profiles enable row level security;
alter table public.platform_roles enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_organizers enable row level security;
alter table public.tournament_registrations enable row level security;
alter table public.matches enable row level security;
alter table public.match_events enable row level security;
alter table public.match_reports enable row level security;
alter table public.match_evidence enable row level security;
alter table public.match_confirmations enable row level security;
alter table public.disputes enable row level security;
alter table public.organizer_feedback enable row level security;

create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_roles where user_id = auth.uid() and role = 'admin')
$$;
create function public.is_organizer_for(tournament uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tournament_organizers where tournament_id = tournament and user_id = auth.uid()) or public.is_admin()
$$;
create function public.is_match_participant(match uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.matches where id = match and auth.uid() in (player_one_id, player_two_id))
$$;

create policy "Profiles are readable by authenticated users" on public.profiles for select to authenticated using (true);
create policy "Users insert their own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "Users update their own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "Roles are readable by authenticated users" on public.platform_roles for select to authenticated using (true);
create policy "Admins manage roles" on public.platform_roles for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "Published tournaments are public" on public.tournaments for select to anon, authenticated using (status <> 'draft' or created_by = auth.uid() or public.is_organizer_for(id));
create policy "Organizers create tournaments" on public.tournaments for insert to authenticated with check (created_by = auth.uid() and exists (select 1 from public.platform_roles where user_id = auth.uid() and role in ('organizer','admin')));
create policy "Tournament organizers update tournaments" on public.tournaments for update to authenticated using (public.is_organizer_for(id)) with check (public.is_organizer_for(id));

create policy "Tournament organizers are readable" on public.tournament_organizers for select to authenticated using (true);
create policy "Admins or tournament creators manage organizers" on public.tournament_organizers for all to authenticated using (public.is_admin() or exists (select 1 from public.tournaments t where t.id = tournament_id and t.created_by = auth.uid())) with check (public.is_admin() or exists (select 1 from public.tournaments t where t.id = tournament_id and t.created_by = auth.uid()));

create policy "Registrations visible to tournament staff or self" on public.tournament_registrations for select to authenticated using (user_id = auth.uid() or public.is_organizer_for(tournament_id));
create policy "Players register themselves" on public.tournament_registrations for insert to authenticated with check (user_id = auth.uid());
create policy "Players update own pending registration" on public.tournament_registrations for update to authenticated using (user_id = auth.uid() or public.is_organizer_for(tournament_id)) with check (user_id = auth.uid() or public.is_organizer_for(tournament_id));

create policy "Matches visible to participants and staff" on public.matches for select to authenticated using (auth.uid() in (player_one_id, player_two_id) or public.is_organizer_for(tournament_id));
create policy "Tournament staff manage matches" on public.matches for all to authenticated using (public.is_organizer_for(tournament_id)) with check (public.is_organizer_for(tournament_id));

create policy "Match events visible to participants and staff" on public.match_events for select to authenticated using (public.is_match_participant(match_id) or exists (select 1 from public.matches m where m.id = match_id and public.is_organizer_for(m.tournament_id)));
create policy "Participants and staff create match events" on public.match_events for insert to authenticated with check (public.is_match_participant(match_id) or exists (select 1 from public.matches m where m.id = match_id and public.is_organizer_for(m.tournament_id)));

create policy "Reports visible to match participants and staff" on public.match_reports for select to authenticated using (public.is_match_participant(match_id) or exists (select 1 from public.matches m where m.id = match_id and public.is_organizer_for(m.tournament_id)));
create policy "Participants create own reports" on public.match_reports for insert to authenticated with check (reporter_id = auth.uid() and public.is_match_participant(match_id));

create policy "Evidence visible through report access" on public.match_evidence for select to authenticated using (exists (select 1 from public.match_reports r where r.id = match_report_id and (public.is_match_participant(r.match_id) or exists (select 1 from public.matches m where m.id = r.match_id and public.is_organizer_for(m.tournament_id)))));
create policy "Report owners upload evidence" on public.match_evidence for insert to authenticated with check (uploaded_by = auth.uid() and exists (select 1 from public.match_reports r where r.id = match_report_id and r.reporter_id = auth.uid()));

create policy "Confirmations visible through report access" on public.match_confirmations for select to authenticated using (exists (select 1 from public.match_reports r where r.id = match_report_id and (public.is_match_participant(r.match_id) or exists (select 1 from public.matches m where m.id = r.match_id and public.is_organizer_for(m.tournament_id)))));
create policy "Participants confirm reports" on public.match_confirmations for insert to authenticated with check (user_id = auth.uid() and exists (select 1 from public.match_reports r where r.id = match_report_id and public.is_match_participant(r.match_id)));

create policy "Disputes visible to participants and staff" on public.disputes for select to authenticated using (public.is_match_participant(match_id) or exists (select 1 from public.matches m where m.id = match_id and public.is_organizer_for(m.tournament_id)));
create policy "Participants open disputes" on public.disputes for insert to authenticated with check (opened_by = auth.uid() and public.is_match_participant(match_id));
create policy "Staff resolve disputes" on public.disputes for update to authenticated using (exists (select 1 from public.matches m where m.id = match_id and public.is_organizer_for(m.tournament_id))) with check (exists (select 1 from public.matches m where m.id = match_id and public.is_organizer_for(m.tournament_id)));

create policy "Feedback visible to tournament staff and submitter" on public.organizer_feedback for select to authenticated using (submitted_by = auth.uid() or public.is_organizer_for(tournament_id));
create policy "Authenticated users submit feedback" on public.organizer_feedback for insert to authenticated with check (submitted_by = auth.uid());
