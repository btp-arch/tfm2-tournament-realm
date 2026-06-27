-- Store derived capacity inputs and round-format defaults for tournament generation.

alter table public.tournaments
  add column if not exists pre_semifinal_match_format public.match_format not null default 'bo1',
  add column if not exists semifinal_match_format public.match_format not null default 'bo3',
  add column if not exists final_match_format public.match_format not null default 'bo5';

grant insert (
  name,
  slug,
  description,
  rules,
  status,
  format,
  tournament_format,
  group_size,
  groups_count,
  qualifiers_per_group,
  group_stage_format,
  pre_semifinal_match_format,
  semifinal_match_format,
  final_match_format,
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
  group_size,
  groups_count,
  qualifiers_per_group,
  group_stage_format,
  pre_semifinal_match_format,
  semifinal_match_format,
  final_match_format,
  max_players,
  starts_at,
  registration_closes_at,
  external_community_url,
  updated_at
) on table public.tournaments to authenticated;

notify pgrst, 'reload schema';
