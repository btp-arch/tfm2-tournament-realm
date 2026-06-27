-- Allow group-stage playoff generation when a valid group draw has no player-vs-player group matches.

create or replace function public.auto_generate_group_playoff(
  target_tournament uuid,
  actor uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  tournament_record public.tournaments%rowtype;
  group_stage_record public.tournament_stages%rowtype;
  playoff_stage_id uuid;
  bracket_size integer;
  qualifier_count integer;
  round_count integer;
  bracket_round_number integer;
  match_number integer := 1;
  seed_order integer[];
  slot_position integer;
  current_slot_count integer;
  player_one record;
  player_two record;
  winning_player_id uuid;
  winning_seed integer;
  match_status public.match_status;
  match_round_id uuid;
begin
  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found or tournament_record.tournament_format::text <> 'group_stage_playoff' then
    return false;
  end if;

  select *
  into group_stage_record
  from public.tournament_stages
  where tournament_id = target_tournament
    and bracket_type::text = 'group_stage_playoff'
  order by stage_number
  limit 1;

  if not found then
    return false;
  end if;

  if exists (
    select 1
    from public.tournament_stages
    where tournament_id = target_tournament
      and bracket_type::text = 'single_elimination'
      and stage_number > group_stage_record.stage_number
  ) then
    return false;
  end if;

  if not exists (
    select 1
    from public.tournament_group_members gm
    where gm.tournament_id = target_tournament
      and gm.is_bye = false
      and gm.user_id is not null
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.matches
    where tournament_id = target_tournament
      and group_id is not null
      and status <> 'finalized'::public.match_status
  ) then
    return false;
  end if;

  create temp table if not exists auto_playoff_qualifiers (
    user_id uuid not null,
    playoff_seed integer not null,
    source_group_id uuid not null,
    primary key (playoff_seed)
  ) on commit drop;
  truncate table auto_playoff_qualifiers;

  with real_members as (
    select
      g.id as group_id,
      g.group_number,
      m.user_id,
      m.seed as draw_seed,
      m.qualifier_seed
    from public.tournament_groups g
    join public.tournament_group_members m on m.group_id = g.id
    where g.tournament_id = target_tournament
      and m.is_bye = false
      and m.user_id is not null
  ),
  match_player_stats as (
    select
      match_stats.group_id,
      match_stats.user_id,
      sum(match_stats.match_wins)::integer as match_wins,
      sum(match_stats.match_losses)::integer as match_losses,
      sum(match_stats.game_wins)::integer as game_wins,
      sum(match_stats.game_losses)::integer as game_losses,
      sum(match_stats.forfeit_losses)::integer as forfeit_losses
    from (
      select
        m.group_id,
        m.player_one_id as user_id,
        case when m.winner_id = m.player_one_id then 1 else 0 end as match_wins,
        case when m.winner_id = m.player_two_id then 1 else 0 end as match_losses,
        case
          when m.result_type = 'played'::public.match_result_type and m.winner_id = m.player_one_id then coalesce(m.final_winner_score, 0)
          when m.result_type = 'played'::public.match_result_type and m.winner_id = m.player_two_id then coalesce(m.final_loser_score, 0)
          else 0
        end as game_wins,
        case
          when m.result_type = 'played'::public.match_result_type and m.winner_id = m.player_one_id then coalesce(m.final_loser_score, 0)
          when m.result_type = 'played'::public.match_result_type and m.winner_id = m.player_two_id then coalesce(m.final_winner_score, 0)
          else 0
        end as game_losses,
        case when m.result_type = 'forfeit'::public.match_result_type and m.winner_id = m.player_two_id then 1 else 0 end as forfeit_losses
      from public.matches m
      where m.tournament_id = target_tournament
        and m.group_id is not null
        and m.status = 'finalized'::public.match_status
        and m.player_one_id is not null
      union all
      select
        m.group_id,
        m.player_two_id as user_id,
        case when m.winner_id = m.player_two_id then 1 else 0 end as match_wins,
        case when m.winner_id = m.player_one_id then 1 else 0 end as match_losses,
        case
          when m.result_type = 'played'::public.match_result_type and m.winner_id = m.player_two_id then coalesce(m.final_winner_score, 0)
          when m.result_type = 'played'::public.match_result_type and m.winner_id = m.player_one_id then coalesce(m.final_loser_score, 0)
          else 0
        end as game_wins,
        case
          when m.result_type = 'played'::public.match_result_type and m.winner_id = m.player_two_id then coalesce(m.final_loser_score, 0)
          when m.result_type = 'played'::public.match_result_type and m.winner_id = m.player_one_id then coalesce(m.final_winner_score, 0)
          else 0
        end as game_losses,
        case when m.result_type = 'forfeit'::public.match_result_type and m.winner_id = m.player_one_id then 1 else 0 end as forfeit_losses
      from public.matches m
      where m.tournament_id = target_tournament
        and m.group_id is not null
        and m.status = 'finalized'::public.match_status
        and m.player_two_id is not null
    ) match_stats
    group by match_stats.group_id, match_stats.user_id
  ),
  standings as (
    select
      rm.group_id,
      rm.group_number,
      rm.user_id,
      rm.draw_seed,
      rm.qualifier_seed,
      coalesce(mps.match_wins, 0) as match_wins,
      coalesce(mps.match_losses, 0) as match_losses,
      coalesce(mps.game_wins, 0) as game_wins,
      coalesce(mps.game_losses, 0) as game_losses,
      coalesce(mps.game_wins, 0) - coalesce(mps.game_losses, 0) as game_diff,
      coalesce(mps.forfeit_losses, 0) as forfeit_losses
    from real_members rm
    left join match_player_stats mps
      on mps.group_id = rm.group_id
      and mps.user_id = rm.user_id
  ),
  group_counts as (
    select
      group_id,
      count(*)::integer as real_count,
      count(*) filter (where qualifier_seed is not null)::integer as manual_count
    from standings
    group by group_id
  ),
  ranked as (
    select
      s.*,
      gc.manual_count,
      least(coalesce(tournament_record.qualifiers_per_group, 0), gc.real_count) as group_qualifier_count,
      row_number() over (
        partition by s.group_id
        order by s.match_wins desc, s.game_diff desc, s.game_wins desc, s.forfeit_losses asc, s.draw_seed asc, s.user_id asc
      ) as standing_rank
    from standings s
    join group_counts gc on gc.group_id = s.group_id
  ),
  cutoff_ties as (
    select 1
    from ranked cutoff
    join ranked next_standing
      on next_standing.group_id = cutoff.group_id
      and next_standing.standing_rank = cutoff.group_qualifier_count + 1
    where cutoff.standing_rank = cutoff.group_qualifier_count
      and cutoff.manual_count < cutoff.group_qualifier_count
      and cutoff.group_qualifier_count > 0
      and cutoff.match_wins = next_standing.match_wins
      and cutoff.game_diff = next_standing.game_diff
      and cutoff.game_wins = next_standing.game_wins
  ),
  selected_qualifiers as (
    select
      r.user_id,
      r.group_id,
      r.group_number,
      coalesce(r.qualifier_seed, r.standing_rank)::integer as placement,
      r.match_wins,
      r.game_diff,
      r.game_wins,
      r.forfeit_losses,
      r.draw_seed
    from ranked r
    where r.group_qualifier_count > 0
      and (
        (r.manual_count >= r.group_qualifier_count and r.qualifier_seed between 1 and r.group_qualifier_count)
        or
        (r.manual_count < r.group_qualifier_count and r.standing_rank <= r.group_qualifier_count)
      )
      and not exists (select 1 from cutoff_ties)
  )
  insert into auto_playoff_qualifiers (user_id, playoff_seed, source_group_id)
  select
    user_id,
    row_number() over (
      order by placement asc, match_wins desc, game_diff desc, game_wins desc, forfeit_losses asc, draw_seed asc, group_number asc, user_id asc
    )::integer as playoff_seed,
    group_id
  from selected_qualifiers
  order by placement asc, match_wins desc, game_diff desc, game_wins desc, forfeit_losses asc, draw_seed asc, group_number asc, user_id asc;

  select count(*)::integer into qualifier_count from auto_playoff_qualifiers;

  if qualifier_count = 0 then
    return false;
  end if;

  bracket_size := public.get_playoff_bracket_size(qualifier_count);

  if bracket_size is null then
    return false;
  end if;

  insert into public.tournament_stages (
    tournament_id,
    stage_number,
    name,
    bracket_type,
    bracket_size,
    seeding_method,
    generated_by
  )
  values (
    target_tournament,
    group_stage_record.stage_number + 1,
    'Playoff Bracket',
    'single_elimination'::public.tournament_format,
    bracket_size,
    'group_finish'::public.tournament_seeding_method,
    actor
  )
  on conflict (tournament_id, stage_number) do nothing
  returning id into playoff_stage_id;

  if playoff_stage_id is null then
    return false;
  end if;

  round_count := public.get_bracket_round_count(bracket_size);

  for bracket_round_number in 1..round_count loop
    insert into public.tournament_rounds (
      tournament_id,
      stage_id,
      round_number,
      name,
      match_format
    )
    values (
      target_tournament,
      playoff_stage_id,
      bracket_round_number,
      public.get_bracket_round_name(bracket_size, bracket_round_number),
      public.get_tournament_round_format(tournament_record, bracket_size, bracket_round_number)
    );
  end loop;

  seed_order := public.get_bracket_seed_order(bracket_size);

  create temp table if not exists auto_playoff_current_slots (
    slot_index integer primary key,
    slot_number integer not null,
    user_id uuid,
    seed integer
  ) on commit drop;
  create temp table if not exists auto_playoff_next_slots (
    slot_index integer primary key,
    slot_number integer not null,
    user_id uuid,
    seed integer
  ) on commit drop;
  truncate table auto_playoff_current_slots;
  truncate table auto_playoff_next_slots;

  for slot_position in 1..bracket_size loop
    insert into auto_playoff_current_slots (slot_index, slot_number, user_id, seed)
    select
      slot_position,
      slot_position,
      q.user_id,
      seed_order[slot_position]
    from (select seed_order[slot_position] as seed) selected_seed
    left join auto_playoff_qualifiers q on q.playoff_seed = selected_seed.seed;
  end loop;

  for bracket_round_number in 1..round_count loop
    truncate table auto_playoff_next_slots;
    current_slot_count := (bracket_size / power(2, bracket_round_number - 1))::integer;

    select id
    into match_round_id
    from public.tournament_rounds tr
    where tr.stage_id = playoff_stage_id
      and tr.round_number = bracket_round_number;

    for slot_position in 1..current_slot_count by 2 loop
      select * into player_one
      from auto_playoff_current_slots
      where auto_playoff_current_slots.slot_index = slot_position;

      select * into player_two
      from auto_playoff_current_slots
      where auto_playoff_current_slots.slot_index = slot_position + 1;

      winning_player_id := case
        when player_one.user_id is not null and player_two.user_id is null then player_one.user_id
        when player_one.user_id is null and player_two.user_id is not null then player_two.user_id
        else null
      end;
      winning_seed := case
        when winning_player_id = player_one.user_id then player_one.seed
        when winning_player_id = player_two.user_id then player_two.seed
        else null
      end;
      match_status := case
        when player_one.user_id is not null and player_two.user_id is not null then 'assigned'::public.match_status
        when winning_player_id is not null then 'bye'::public.match_status
        else 'pending'::public.match_status
      end;

      insert into public.matches (
        tournament_id,
        stage_id,
        round_id,
        round_number,
        match_number,
        bracket_position,
        player_one_id,
        player_two_id,
        player_one_seed,
        player_two_seed,
        player_one_slot,
        player_two_slot,
        format,
        status,
        winner_id,
        result_type
      )
      values (
        target_tournament,
        playoff_stage_id,
        match_round_id,
        bracket_round_number,
        match_number,
        ((slot_position - 1) / 2) + 1,
        player_one.user_id,
        player_two.user_id,
        player_one.seed,
        player_two.seed,
        player_one.slot_number,
        player_two.slot_number,
        public.get_tournament_round_format(tournament_record, bracket_size, bracket_round_number),
        match_status,
        winning_player_id,
        case when match_status = 'bye'::public.match_status then 'bye'::public.match_result_type else 'played'::public.match_result_type end
      );

      insert into auto_playoff_next_slots (slot_index, slot_number, user_id, seed)
      values (((slot_position - 1) / 2) + 1, ((slot_position - 1) / 2) + 1, winning_player_id, winning_seed);

      match_number := match_number + 1;
    end loop;

    truncate table auto_playoff_current_slots;
    insert into auto_playoff_current_slots
    select * from auto_playoff_next_slots;
  end loop;

  if qualifier_count = 1 then
    update public.tournaments
    set status = 'completed'::public.tournament_status,
        updated_at = now()
    where id = target_tournament;
  end if;

  return true;
end;
$$;

do $$
declare
  tournament_record record;
begin
  for tournament_record in
    select distinct t.id
    from public.tournaments t
    join public.tournament_stages s
      on s.tournament_id = t.id
      and s.bracket_type::text = 'group_stage_playoff'
    where t.tournament_format::text = 'group_stage_playoff'
      and exists (
        select 1
        from public.tournament_group_members gm
        where gm.tournament_id = t.id
          and gm.is_bye = false
          and gm.user_id is not null
      )
      and not exists (
        select 1
        from public.matches pending_match
        where pending_match.tournament_id = t.id
          and pending_match.group_id is not null
          and pending_match.status <> 'finalized'::public.match_status
      )
      and not exists (
        select 1
        from public.tournament_stages playoff
        where playoff.tournament_id = t.id
          and playoff.bracket_type::text = 'single_elimination'
          and playoff.stage_number > s.stage_number
      )
  loop
    perform public.auto_generate_group_playoff(tournament_record.id, null);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
