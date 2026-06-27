-- Milestone 7D: tournament classification foundation.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tournament_tier') then
    create type public.tournament_tier as enum ('test', 'community', 'official', 'championship');
  end if;
end
$$;

alter table public.tournaments
  add column if not exists tournament_tier public.tournament_tier not null default 'community',
  add column if not exists exclude_from_stats boolean not null default false,
  add column if not exists official_marked_by uuid references public.profiles(id) on delete set null,
  add column if not exists official_marked_at timestamptz;

create index if not exists tournaments_tournament_tier_idx
  on public.tournaments(tournament_tier);

create index if not exists tournaments_stats_classification_idx
  on public.tournaments(tournament_tier, exclude_from_stats)
  where exclude_from_stats = false;

create or replace function public.enforce_tournament_classification_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if new.tournament_tier is distinct from old.tournament_tier
    or new.exclude_from_stats is distinct from old.exclude_from_stats
    or new.official_marked_by is distinct from old.official_marked_by
    or new.official_marked_at is distinct from old.official_marked_at then
    raise exception 'Only admins can update tournament classification.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_tournament_classification_admin_only on public.tournaments;

create trigger enforce_tournament_classification_admin_only
  before update of tournament_tier, exclude_from_stats, official_marked_by, official_marked_at
  on public.tournaments
  for each row
  execute function public.enforce_tournament_classification_admin_only();

create or replace function public.set_tournament_classification(
  target_tournament uuid,
  tier public.tournament_tier,
  excluded boolean
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
    raise exception 'Only admins can update tournament classification.';
  end if;

  update public.tournaments
  set
    tournament_tier = tier,
    exclude_from_stats = excluded,
    official_marked_by = case
      when tier in ('official', 'championship') then coalesce(official_marked_by, auth.uid())
      else null
    end,
    official_marked_at = case
      when tier in ('official', 'championship') then coalesce(official_marked_at, now())
      else null
    end,
    updated_at = now()
  where id = target_tournament
  returning * into updated_tournament;

  if updated_tournament.id is null then
    raise exception 'Tournament not found.';
  end if;

  return updated_tournament;
end;
$$;

grant usage on type public.tournament_tier to anon, authenticated, service_role;

grant execute on function public.set_tournament_classification(uuid, public.tournament_tier, boolean)
  to authenticated;
