-- Milestone 3.6: admin tournament override controls.

drop policy if exists "Tournament creators and admins delete empty draft tournaments"
  on public.tournaments;

create policy "Admins delete any tournament and creators delete own empty drafts"
  on public.tournaments
  for delete
  to authenticated
  using (
    public.is_admin()
    or (
      status = 'draft'
      and created_by = auth.uid()
      and not exists (
        select 1
        from public.tournament_registrations r
        where r.tournament_id = public.tournaments.id
      )
    )
  );
