-- Milestone 8C: public player profile fields and record lookup indexes.

create or replace view public.public_profiles as
select
  id,
  display_name,
  discord_username,
  steam_profile_url
from public.profiles;

grant select on table public.public_profiles to anon, authenticated;

create index if not exists matches_player_one_updated_idx
  on public.matches(player_one_id, updated_at desc)
  where player_one_id is not null;

create index if not exists matches_player_two_updated_idx
  on public.matches(player_two_id, updated_at desc)
  where player_two_id is not null;
