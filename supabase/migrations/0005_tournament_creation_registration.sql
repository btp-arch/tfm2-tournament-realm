-- Milestone 3: free-entry tournament creation and player registration.

alter type public.tournament_status add value if not exists 'check_in';
alter type public.tournament_status add value if not exists 'active';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tournament_format') then
    create type public.tournament_format as enum ('single_elimination');
  end if;
end
$$;

alter table public.tournaments
  add column if not exists tournament_format public.tournament_format not null default 'single_elimination',
  add column if not exists registration_closes_at timestamptz,
  add column if not exists external_community_url text;

alter table public.tournaments
  drop constraint if exists tournaments_registration_closes_before_start,
  add constraint tournaments_registration_closes_before_start
    check (registration_closes_at is null or starts_at is null or registration_closes_at <= starts_at),
  drop constraint if exists tournaments_external_community_url_format,
  add constraint tournaments_external_community_url_format
    check (
      external_community_url is null
      or (
        char_length(external_community_url) <= 300
        and external_community_url ~ '^https?://'
      )
    );

create index if not exists tournaments_starts_at_idx on public.tournaments(starts_at);
create index if not exists tournaments_registration_closes_at_idx
  on public.tournaments(registration_closes_at);
create index if not exists tournament_registrations_tournament_status_idx
  on public.tournament_registrations(tournament_id, status);

create or replace view public.public_profiles as
select id, display_name
from public.profiles;

create or replace view public.tournament_registration_counts
with (security_invoker = true) as
select
  tournament_id,
  count(*) filter (where status <> 'withdrawn')::integer as active_registration_count
from public.tournament_registrations
group by tournament_id;

create or replace function public.is_public_tournament_status(status public.tournament_status)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select status::text in ('registration_open', 'registration_closed', 'check_in', 'active', 'completed')
$$;

create or replace function public.is_organizer_for(tournament uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1
      from public.tournaments
      where id = tournament
        and created_by = auth.uid()
    )
    or exists (
      select 1
      from public.tournament_organizers
      where tournament_id = tournament
        and user_id = auth.uid()
    )
$$;

create or replace function public.can_register_for_tournament(tournament uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tournaments t
    where t.id = tournament
      and t.status = 'registration_open'
      and (t.registration_closes_at is null or t.registration_closes_at > now())
      and (
        t.max_players is null
        or (
          select count(*)
          from public.tournament_registrations r
          where r.tournament_id = t.id
            and r.status <> 'withdrawn'
        ) < t.max_players
      )
  )
$$;

create or replace function public.enforce_registration_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_registration_count integer;
  tournament_record public.tournaments%rowtype;
begin
  if new.status = 'withdrawn' then
    return new;
  end if;

  select *
  into tournament_record
  from public.tournaments
  where id = new.tournament_id
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if tournament_record.status <> 'registration_open' then
    raise exception 'Tournament registration is not open.';
  end if;

  if tournament_record.registration_closes_at is not null
    and tournament_record.registration_closes_at <= now() then
    raise exception 'Tournament registration is closed.';
  end if;

  if tournament_record.max_players is not null then
    select count(*)
    into active_registration_count
    from public.tournament_registrations
    where tournament_id = new.tournament_id
      and status <> 'withdrawn'
      and (tg_op <> 'UPDATE' or id <> old.id);

    if active_registration_count >= tournament_record.max_players then
      raise exception 'Tournament registration is full.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_registration_window on public.tournament_registrations;

create trigger enforce_registration_window
  before insert or update of status on public.tournament_registrations
  for each row
  execute function public.enforce_registration_window();

grant usage on type public.tournament_format to anon, authenticated, service_role;
grant usage on type public.tournament_status to anon, authenticated, service_role;
grant usage on type public.registration_status to anon, authenticated, service_role;
grant usage on type public.match_format to anon, authenticated, service_role;

grant select on table public.public_profiles to anon, authenticated;
grant select on table public.tournament_registration_counts to anon, authenticated;

grant select on table public.tournaments to anon, authenticated;
grant insert (
  name,
  slug,
  description,
  rules,
  status,
  format,
  tournament_format,
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
  max_players,
  starts_at,
  registration_closes_at,
  external_community_url,
  updated_at
) on table public.tournaments to authenticated;

grant select on table public.tournament_organizers to anon, authenticated;
grant insert, update, delete on table public.tournament_organizers to authenticated;

grant select on table public.tournament_registrations to anon, authenticated;
grant insert (tournament_id, user_id, status) on table public.tournament_registrations to authenticated;
grant update (status, updated_at) on table public.tournament_registrations to authenticated;

grant execute on function public.is_admin() to anon, authenticated, service_role;
grant execute on function public.is_organizer_for(uuid) to anon, authenticated, service_role;
grant execute on function public.is_public_tournament_status(public.tournament_status)
  to anon, authenticated, service_role;
grant execute on function public.can_register_for_tournament(uuid)
  to anon, authenticated, service_role;

drop policy if exists "Published tournaments are public" on public.tournaments;
drop policy if exists "Organizers create tournaments" on public.tournaments;
drop policy if exists "Tournament organizers update tournaments" on public.tournaments;

create policy "Public can read public tournaments and staff can read managed tournaments"
  on public.tournaments
  for select
  to anon, authenticated
  using (
    public.is_public_tournament_status(status)
    or created_by = auth.uid()
    or public.is_organizer_for(id)
  );

create policy "Platform organizers create tournaments"
  on public.tournaments
  for insert
  to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1
      from public.platform_roles
      where user_id = auth.uid()
        and role in ('organizer', 'admin')
    )
  );

create policy "Tournament staff update tournaments"
  on public.tournaments
  for update
  to authenticated
  using (public.is_organizer_for(id))
  with check (public.is_organizer_for(id));

drop policy if exists "Tournament organizers are readable" on public.tournament_organizers;
drop policy if exists "Admins or tournament creators manage organizers" on public.tournament_organizers;

create policy "Public can read organizers for public tournaments"
  on public.tournament_organizers
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and public.is_public_tournament_status(t.status)
    )
    or user_id = auth.uid()
    or public.is_organizer_for(tournament_id)
  );

create policy "Admins or tournament creators manage organizers"
  on public.tournament_organizers
  for all
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and t.created_by = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and t.created_by = auth.uid()
    )
  );

drop policy if exists "Registrations visible to tournament staff or self" on public.tournament_registrations;
drop policy if exists "Players register themselves" on public.tournament_registrations;
drop policy if exists "Players update own pending registration" on public.tournament_registrations;

create policy "Registrations visible to public tournaments staff or self"
  on public.tournament_registrations
  for select
  to anon, authenticated
  using (
    (
      status <> 'withdrawn'
      and exists (
        select 1
        from public.tournaments t
        where t.id = tournament_id
          and public.is_public_tournament_status(t.status)
      )
    )
    or user_id = auth.uid()
    or public.is_organizer_for(tournament_id)
  );

create policy "Players register themselves for open tournaments"
  on public.tournament_registrations
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and public.can_register_for_tournament(tournament_id)
  );

create policy "Players withdraw themselves before registration closes"
  on public.tournament_registrations
  for update
  to authenticated
  using (
    public.is_organizer_for(tournament_id)
    or (
      user_id = auth.uid()
      and status in ('pending', 'accepted', 'checked_in')
      and exists (
        select 1
        from public.tournaments t
        where t.id = tournament_id
          and t.status = 'registration_open'
          and (t.registration_closes_at is null or t.registration_closes_at > now())
      )
    )
  )
  with check (
    public.is_organizer_for(tournament_id)
    or (
      user_id = auth.uid()
      and status = 'withdrawn'
    )
  );
