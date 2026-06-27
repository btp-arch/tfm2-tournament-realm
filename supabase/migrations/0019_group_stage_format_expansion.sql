-- Milestone 9B: group-stage format expansion, group BYEs, and larger playoff brackets.

alter table public.tournaments
  drop constraint if exists tournaments_group_stage_settings_check,
  add constraint tournaments_group_stage_settings_check
    check (
      (
        tournament_format::text = 'single_elimination'
        and group_size is null
        and groups_count is null
        and qualifiers_per_group is null
        and group_stage_format is null
      )
      or (
        tournament_format::text = 'group_stage_playoff'
        and group_size in (4, 8)
        and groups_count > 0
        and qualifiers_per_group between 1 and 4
        and qualifiers_per_group <= group_size
        and group_stage_format in ('bo1'::public.match_format, 'bo3'::public.match_format)
        and groups_count * qualifiers_per_group between 2 and 64
      )
    );

alter table public.tournament_group_members
  alter column user_id drop not null,
  add column if not exists is_bye boolean not null default false;

alter table public.tournament_group_members
  drop constraint if exists tournament_group_members_bye_shape_check,
  add constraint tournament_group_members_bye_shape_check
    check (
      (is_bye = true and user_id is null)
      or (is_bye = false and user_id is not null)
    );

alter table public.tournament_stages
  drop constraint if exists tournament_stages_bracket_size_check,
  add constraint tournament_stages_bracket_size_check
    check (bracket_size in (4, 8, 16, 32, 64));

drop index if exists tournament_group_members_group_idx;
create index if not exists tournament_group_members_group_idx
  on public.tournament_group_members(group_id, is_bye, qualifier_seed, seed);

drop index if exists tournament_group_members_user_idx;
create index if not exists tournament_group_members_user_idx
  on public.tournament_group_members(user_id)
  where user_id is not null;
