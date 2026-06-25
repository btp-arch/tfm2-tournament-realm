-- Store the seeding method selected when a tournament stage is generated.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tournament_seeding_method') then
    create type public.tournament_seeding_method as enum (
      'random',
      'registration_order',
      'check_in_order'
    );
  end if;
end
$$;

alter table public.tournament_stages
  add column if not exists seeding_method public.tournament_seeding_method not null default 'random';

grant usage on type public.tournament_seeding_method to anon, authenticated, service_role;
