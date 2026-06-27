-- Milestone 9C: organizer-controlled manual registration seeds.

alter table public.tournament_registrations
  add column if not exists manual_seed integer;

alter table public.tournament_registrations
  drop constraint if exists tournament_registrations_manual_seed_check,
  add constraint tournament_registrations_manual_seed_check
    check (manual_seed is null or manual_seed between 1 and 8);

create unique index if not exists tournament_registrations_manual_seed_unique
  on public.tournament_registrations(tournament_id, manual_seed)
  where manual_seed is not null;

create or replace function public.clear_inactive_registration_manual_seed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('withdrawn'::public.registration_status, 'rejected'::public.registration_status) then
    new.manual_seed := null;
  end if;

  return new;
end;
$$;

drop trigger if exists clear_inactive_registration_manual_seed
  on public.tournament_registrations;
create trigger clear_inactive_registration_manual_seed
  before insert or update on public.tournament_registrations
  for each row
  execute function public.clear_inactive_registration_manual_seed();

create or replace function public.set_tournament_registration_seed(
  target_registration uuid,
  seed_value integer
)
returns public.tournament_registrations
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  registration_record public.tournament_registrations%rowtype;
begin
  if actor is null then
    raise exception 'Sign in to update manual seeds.';
  end if;

  select *
  into registration_record
  from public.tournament_registrations
  where id = target_registration;

  if registration_record.id is null then
    raise exception 'Registration was not found.';
  end if;

  if not public.is_organizer_for(registration_record.tournament_id) then
    raise exception 'Only tournament organizers and admins can update manual seeds.';
  end if;

  if registration_record.status in ('withdrawn'::public.registration_status, 'rejected'::public.registration_status) then
    raise exception 'Manual seeds can only be assigned to active registrations.';
  end if;

  if seed_value is not null and (seed_value < 1 or seed_value > 8) then
    raise exception 'Manual seeds must be empty or between 1 and 8.';
  end if;

  if exists (
    select 1
    from public.tournament_stages s
    where s.tournament_id = registration_record.tournament_id
  ) then
    raise exception 'Manual seeds are locked after a bracket or group draw is generated.';
  end if;

  if seed_value is not null and exists (
    select 1
    from public.tournament_registrations r
    where r.tournament_id = registration_record.tournament_id
      and r.manual_seed = seed_value
      and r.id <> registration_record.id
  ) then
    raise exception 'That seed is already assigned in this tournament.';
  end if;

  update public.tournament_registrations
  set manual_seed = seed_value,
      updated_at = now()
  where id = target_registration
  returning * into registration_record;

  return registration_record;
end;
$$;

grant execute on function public.set_tournament_registration_seed(uuid, integer)
  to authenticated, service_role;
