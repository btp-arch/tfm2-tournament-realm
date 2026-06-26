-- Milestone 7C: admin-controlled public dashboard calendar visibility.

alter table public.tournaments
  add column if not exists show_on_calendar boolean not null default false;

create index if not exists tournaments_calendar_window_idx
  on public.tournaments(show_on_calendar, starts_at)
  where show_on_calendar = true;

create or replace function public.set_tournament_calendar_visibility(
  target_tournament uuid,
  visible boolean
)
returns public.tournaments
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_tournament public.tournaments;
begin
  if not public.is_admin() then
    raise exception 'Only admins can update dashboard calendar visibility.';
  end if;

  update public.tournaments
  set
    show_on_calendar = visible,
    updated_at = now()
  where id = target_tournament
  returning * into updated_tournament;

  if updated_tournament.id is null then
    raise exception 'Tournament not found.';
  end if;

  return updated_tournament;
end;
$$;

grant execute on function public.set_tournament_calendar_visibility(uuid, boolean)
  to authenticated;
