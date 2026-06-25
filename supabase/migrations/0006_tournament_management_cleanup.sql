-- Milestone 3.5: tournament management cleanup.

create or replace function public.is_public_tournament_status(status public.tournament_status)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select status::text in (
    'registration_open',
    'registration_closed',
    'check_in',
    'active',
    'completed',
    'cancelled'
  )
$$;

grant delete on table public.tournaments to authenticated;

drop policy if exists "Tournament creators and admins delete empty draft tournaments"
  on public.tournaments;

create policy "Tournament creators and admins delete empty draft tournaments"
  on public.tournaments
  for delete
  to authenticated
  using (
    status = 'draft'
    and not exists (
      select 1
      from public.tournament_registrations r
      where r.tournament_id = public.tournaments.id
    )
    and (
      public.is_admin()
      or created_by = auth.uid()
    )
  );
