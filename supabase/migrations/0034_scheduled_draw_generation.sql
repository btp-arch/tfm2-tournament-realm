-- Generate initial draws from scheduled automation after check-in/replacement windows close.

create or replace function public.get_round_duration_minutes(
  tournament_record public.tournaments,
  target_phase text,
  target_format public.match_format
)
returns integer
language plpgsql
stable
set search_path = public
as $$
begin
  if target_phase = 'group' then
    if target_format = 'bo3'::public.match_format then
      return tournament_record.group_bo3_round_minutes;
    end if;

    return tournament_record.group_bo1_round_minutes;
  end if;

  if target_format = 'bo5'::public.match_format then
    return tournament_record.bracket_bo5_round_minutes;
  end if;

  if target_format = 'bo3'::public.match_format then
    return tournament_record.bracket_bo3_round_minutes;
  end if;

  return tournament_record.bracket_bo1_round_minutes;
end;
$$;

create or replace function public.get_group_label(group_number integer)
returns text
language plpgsql
immutable
set search_path = public
as $$
begin
  if group_number between 1 and 26 then
    return 'Group ' || chr(64 + group_number);
  end if;

  return 'Group ' || group_number::text;
end;
$$;

create or replace function public.generate_single_elimination_draw_system(
  target_tournament uuid,
  actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tournament_record public.tournaments%rowtype;
  created_stage_id uuid;
  bracket_size integer;
  participant_count integer;
  manual_seed_count integer;
  round_count integer;
  bracket_round_number integer;
  bracket_round_id uuid;
  bracket_deadline timestamptz;
  seed_order integer[];
  slot_position integer;
  current_slot_count integer;
  match_number integer := 1;
  player_one record;
  player_two record;
  winning_player_id uuid;
  winning_seed integer;
  match_status public.match_status;
  result jsonb;
begin
  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if tournament_record.status <> 'check_in'
    or tournament_record.tournament_format <> 'single_elimination'::public.tournament_format
    or tournament_record.automation_mode <> 'automatic'
    or tournament_record.auto_generate_draw_after_replacement is not true
    or tournament_record.automation_paused_at is not null
    or tournament_record.timers_paused_at is not null
    or exists (
      select 1
      from public.tournament_stages s
      where s.tournament_id = target_tournament
    )
  then
    return jsonb_build_object('applied', false);
  end if;

  create temp table if not exists scheduled_draw_participants (
    user_id uuid primary key,
    manual_seed integer,
    registered_at timestamptz not null,
    checked_in_at timestamptz not null
  ) on commit drop;
  create temp table if not exists scheduled_draw_assigned_players (
    seed integer primary key,
    user_id uuid not null
  ) on commit drop;
  create temp table if not exists scheduled_draw_current_slots (
    slot_index integer primary key,
    slot_number integer not null,
    user_id uuid,
    seed integer
  ) on commit drop;
  create temp table if not exists scheduled_draw_next_slots (
    slot_index integer primary key,
    slot_number integer not null,
    user_id uuid,
    seed integer
  ) on commit drop;
  truncate table scheduled_draw_participants;
  truncate table scheduled_draw_assigned_players;
  truncate table scheduled_draw_current_slots;
  truncate table scheduled_draw_next_slots;

  insert into scheduled_draw_participants (user_id, manual_seed, registered_at, checked_in_at)
  select r.user_id, r.manual_seed, r.created_at, c.checked_in_at
  from public.tournament_registrations r
  join public.tournament_check_ins c
    on c.tournament_id = r.tournament_id
    and c.user_id = r.user_id
  where r.tournament_id = target_tournament
    and public.is_active_registration_status(r.status);

  select count(*)::integer
  into participant_count
  from scheduled_draw_participants;

  if participant_count < 2 then
    return jsonb_build_object('applied', false, 'reason', 'not_enough_checked_in_players');
  end if;

  bracket_size := case
    when tournament_record.max_players in (4, 8, 16, 32, 64) then tournament_record.max_players
    else public.get_playoff_bracket_size(participant_count)
  end;

  if bracket_size is null or participant_count > bracket_size then
    return jsonb_build_object(
      'applied', false,
      'reason', 'checked_in_count_exceeds_bracket_size',
      'checked_in_count', participant_count,
      'bracket_size', bracket_size
    );
  end if;

  if exists (
    select 1
    from scheduled_draw_participants p
    where p.manual_seed is not null
      and (p.manual_seed < 1 or p.manual_seed > least(8, bracket_size))
  ) then
    raise exception 'Manual seed is outside the supported bracket seed range.';
  end if;

  select count(*)::integer
  into manual_seed_count
  from scheduled_draw_participants
  where manual_seed is not null;

  insert into scheduled_draw_assigned_players (seed, user_id)
  select manual_seed, user_id
  from scheduled_draw_participants
  where manual_seed is not null
  order by manual_seed;

  with open_seeds as (
    select
      seed_value,
      row_number() over (order by seed_value) as seed_rank
    from generate_series(1, bracket_size) as seed_values(seed_value)
    where not exists (
      select 1
      from scheduled_draw_assigned_players assigned
      where assigned.seed = seed_value
    )
  ),
  ordered_unseeded as (
    select
      p.user_id,
      row_number() over (
        order by
          random(),
          p.user_id
      ) as seed_rank
    from scheduled_draw_participants p
    where p.manual_seed is null
  )
  insert into scheduled_draw_assigned_players (seed, user_id)
  select open_seeds.seed_value, ordered_unseeded.user_id
  from ordered_unseeded
  join open_seeds using (seed_rank);

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
    1,
    'Single Elimination',
    'single_elimination'::public.tournament_format,
    bracket_size,
    'random'::public.tournament_seeding_method,
    actor
  )
  returning id into created_stage_id;

  round_count := public.get_bracket_round_count(bracket_size);

  for bracket_round_number in 1..round_count loop
    bracket_deadline := case
      when bracket_round_number = 1 then now() + make_interval(
        mins => public.get_round_duration_minutes(
          tournament_record,
          'bracket',
          public.get_tournament_round_format(tournament_record, bracket_size, bracket_round_number)
        )
      )
      else null
    end;

    insert into public.tournament_rounds (
      tournament_id,
      stage_id,
      round_number,
      name,
      match_format,
      timer_started_at,
      deadline_at,
      timing_state
    )
    values (
      target_tournament,
      created_stage_id,
      bracket_round_number,
      public.get_bracket_round_name(bracket_size, bracket_round_number),
      public.get_tournament_round_format(tournament_record, bracket_size, bracket_round_number),
      case when bracket_round_number = 1 then now() else null end,
      bracket_deadline,
      case when bracket_round_number = 1 then 'active' else 'idle' end
    );
  end loop;

  seed_order := public.get_bracket_seed_order(bracket_size);

  for slot_position in 1..bracket_size loop
    insert into scheduled_draw_current_slots (slot_index, slot_number, user_id, seed)
    select
      slot_position,
      slot_position,
      assigned.user_id,
      seed_order[slot_position]
    from (select seed_order[slot_position] as seed) selected_seed
    left join scheduled_draw_assigned_players assigned
      on assigned.seed = selected_seed.seed;
  end loop;

  for bracket_round_number in 1..round_count loop
    truncate table scheduled_draw_next_slots;
    current_slot_count := (bracket_size / power(2, bracket_round_number - 1))::integer;

    select id
    into bracket_round_id
    from public.tournament_rounds tr
    where tr.stage_id = created_stage_id
      and tr.round_number = bracket_round_number;

    for slot_position in 1..current_slot_count by 2 loop
      select * into player_one
      from scheduled_draw_current_slots
      where slot_index = slot_position;

      select * into player_two
      from scheduled_draw_current_slots
      where slot_index = slot_position + 1;

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
        created_stage_id,
        bracket_round_id,
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

      insert into scheduled_draw_next_slots (slot_index, slot_number, user_id, seed)
      values (((slot_position - 1) / 2) + 1, ((slot_position - 1) / 2) + 1, winning_player_id, winning_seed);

      match_number := match_number + 1;
    end loop;

    truncate table scheduled_draw_current_slots;
    insert into scheduled_draw_current_slots
    select * from scheduled_draw_next_slots;
  end loop;

  select deadline_at
  into bracket_deadline
  from public.tournament_rounds tr
  where tr.stage_id = created_stage_id
    and tr.round_number = 1;

  update public.tournaments
  set
    status = 'active',
    current_bracket_round_deadline = bracket_deadline,
    timing_state = 'bracket_round',
    timing_note = 'Scheduled automation generated the bracket and started round one.',
    last_automation_run_at = now(),
    updated_at = now()
  where id = target_tournament;

  result := jsonb_build_object(
    'applied', true,
    'format', 'single_elimination',
    'checked_in_count', participant_count,
    'bracket_size', bracket_size,
    'matches_created', match_number - 1
  );

  perform public.log_scheduled_automation_event(target_tournament, 'generate_bracket', result);

  return result;
end;
$$;

create or replace function public.generate_group_stage_draw_system(
  target_tournament uuid,
  actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tournament_record public.tournaments%rowtype;
  participant_count integer;
  manual_seed_count integer;
  total_group_slots integer;
  group_stage_id uuid;
  draw_group_index integer;
  draw_slot_index integer;
  target_group_index integer;
  preferred_group_index integer;
  participant record;
  slot_record record;
  created_group_id uuid;
  created_member_id uuid;
  real_member_count integer;
  group_round_count integer;
  max_group_round_count integer := 0;
  group_round_number integer;
  group_round_id uuid;
  group_deadline timestamptz;
  match_number integer := 1;
  group_match_position integer;
  round_index integer;
  pair_index integer;
  player_count integer;
  first_slot record;
  second_slot record;
  player_one record;
  player_two record;
  generated_playoff boolean := false;
  result jsonb;
begin
  select *
  into tournament_record
  from public.tournaments
  where id = target_tournament
  for update;

  if not found then
    raise exception 'Tournament not found.';
  end if;

  if tournament_record.status <> 'check_in'
    or tournament_record.tournament_format <> 'group_stage_playoff'::public.tournament_format
    or tournament_record.automation_mode <> 'automatic'
    or tournament_record.auto_generate_draw_after_replacement is not true
    or tournament_record.automation_paused_at is not null
    or tournament_record.timers_paused_at is not null
    or tournament_record.group_size is null
    or tournament_record.groups_count is null
    or tournament_record.group_stage_format is null
    or exists (
      select 1
      from public.tournament_stages s
      where s.tournament_id = target_tournament
    )
  then
    return jsonb_build_object('applied', false);
  end if;

  total_group_slots := tournament_record.group_size * tournament_record.groups_count;

  create temp table if not exists scheduled_group_participants (
    user_id uuid primary key,
    manual_seed integer,
    registered_at timestamptz not null,
    checked_in_at timestamptz not null
  ) on commit drop;
  create temp table if not exists scheduled_group_slots (
    group_index integer not null,
    slot_index integer not null,
    user_id uuid,
    manual_seed integer,
    primary key (group_index, slot_index)
  ) on commit drop;
  create temp table if not exists scheduled_created_groups (
    group_index integer primary key,
    group_id uuid not null
  ) on commit drop;
  create temp table if not exists scheduled_created_group_members (
    member_id uuid primary key,
    group_index integer not null,
    slot_index integer not null,
    seed integer not null,
    draw_position integer not null,
    user_id uuid,
    is_bye boolean not null
  ) on commit drop;
  create temp table if not exists scheduled_group_rotation (
    position integer primary key,
    member_id uuid,
    user_id uuid,
    seed integer,
    draw_position integer
  ) on commit drop;
  create temp table if not exists scheduled_group_next_rotation (
    position integer primary key,
    member_id uuid,
    user_id uuid,
    seed integer,
    draw_position integer
  ) on commit drop;
  truncate table scheduled_group_participants;
  truncate table scheduled_group_slots;
  truncate table scheduled_created_groups;
  truncate table scheduled_created_group_members;
  truncate table scheduled_group_rotation;
  truncate table scheduled_group_next_rotation;

  insert into scheduled_group_participants (user_id, manual_seed, registered_at, checked_in_at)
  select r.user_id, r.manual_seed, r.created_at, c.checked_in_at
  from public.tournament_registrations r
  join public.tournament_check_ins c
    on c.tournament_id = r.tournament_id
    and c.user_id = r.user_id
  where r.tournament_id = target_tournament
    and public.is_active_registration_status(r.status);

  select count(*)::integer
  into participant_count
  from scheduled_group_participants;

  if participant_count < 2 then
    return jsonb_build_object('applied', false, 'reason', 'not_enough_checked_in_players');
  end if;

  if participant_count > total_group_slots then
    return jsonb_build_object(
      'applied', false,
      'reason', 'checked_in_count_exceeds_group_capacity',
      'checked_in_count', participant_count,
      'group_capacity', total_group_slots
    );
  end if;

  if exists (
    select 1
    from scheduled_group_participants p
    where p.manual_seed is not null
      and (p.manual_seed < 1 or p.manual_seed > 8)
  ) then
    raise exception 'Manual seeds must be between 1 and 8.';
  end if;

  for draw_group_index in 0..(tournament_record.groups_count - 1) loop
    for draw_slot_index in 0..(tournament_record.group_size - 1) loop
      insert into scheduled_group_slots (group_index, slot_index)
      values (draw_group_index, draw_slot_index);
    end loop;
  end loop;

  select count(*)::integer
  into manual_seed_count
  from scheduled_group_participants
  where manual_seed is not null;

  for participant in
    select *
    from scheduled_group_participants
    where manual_seed is not null
    order by manual_seed
  loop
    preferred_group_index := case
      when tournament_record.groups_count <= 1 then 0
      when mod(((participant.manual_seed - 1) / tournament_record.groups_count)::integer, 2) = 0
        then mod(participant.manual_seed - 1, tournament_record.groups_count)
      else tournament_record.groups_count - 1 - mod(participant.manual_seed - 1, tournament_record.groups_count)
    end;

    select candidate.group_index
    into target_group_index
    from (
      select
        gs.group_index,
        count(gs.user_id) filter (where gs.user_id is not null) as real_count,
        min(abs(gs.group_index - preferred_group_index)) as preferred_distance,
        bool_or(gs.user_id is null) as has_room
      from scheduled_group_slots gs
      group by gs.group_index
    ) candidate
    where candidate.has_room
    order by
      case when candidate.group_index = preferred_group_index then 0 else 1 end,
      candidate.real_count,
      candidate.preferred_distance,
      candidate.group_index
    limit 1;

    if target_group_index is null then
      raise exception 'Group draw capacity was exceeded.';
    end if;

    update scheduled_group_slots gs
    set user_id = participant.user_id,
        manual_seed = participant.manual_seed
    where gs.group_index = target_group_index
      and gs.slot_index = (
        select min(open_slot.slot_index)
        from scheduled_group_slots open_slot
        where open_slot.group_index = target_group_index
          and open_slot.user_id is null
      );
  end loop;

  for participant in
    select *
    from scheduled_group_participants p
    where p.manual_seed is null
    order by
      random(),
      p.user_id
  loop
    select candidate.group_index
    into target_group_index
    from (
      select
        gs.group_index,
        count(gs.user_id) filter (where gs.user_id is not null) as real_count,
        bool_or(gs.user_id is null) as has_room
      from scheduled_group_slots gs
      group by gs.group_index
    ) candidate
    where candidate.has_room
    order by candidate.real_count, candidate.group_index
    limit 1;

    if target_group_index is null then
      raise exception 'Group draw capacity was exceeded.';
    end if;

    update scheduled_group_slots gs
    set user_id = participant.user_id,
        manual_seed = null
    where gs.group_index = target_group_index
      and gs.slot_index = (
        select min(open_slot.slot_index)
        from scheduled_group_slots open_slot
        where open_slot.group_index = target_group_index
          and open_slot.user_id is null
      );
  end loop;

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
    1,
    'Group Stage',
    'group_stage_playoff'::public.tournament_format,
    total_group_slots,
    'random'::public.tournament_seeding_method,
    actor
  )
  returning id into group_stage_id;

  for draw_group_index in 0..(tournament_record.groups_count - 1) loop
    insert into public.tournament_groups (
      tournament_id,
      stage_id,
      group_number,
      name,
      draw_method,
      generated_by
    )
    values (
      target_tournament,
      group_stage_id,
      draw_group_index + 1,
      public.get_group_label(draw_group_index + 1),
      'random'::public.tournament_seeding_method,
      actor
    )
    returning id into created_group_id;

    insert into scheduled_created_groups (group_index, group_id)
    values (draw_group_index, created_group_id);
  end loop;

  for slot_record in
    select *
    from scheduled_group_slots
    order by group_index, slot_index
  loop
    insert into public.tournament_group_members (
      tournament_id,
      group_id,
      user_id,
      is_bye,
      seed,
      draw_position
    )
    select
      target_tournament,
      cg.group_id,
      slot_record.user_id,
      slot_record.user_id is null,
      slot_record.slot_index + 1,
      (slot_record.group_index * tournament_record.group_size) + slot_record.slot_index + 1
    from scheduled_created_groups cg
    where cg.group_index = slot_record.group_index
    returning id into created_member_id;

    insert into scheduled_created_group_members (
      member_id,
      group_index,
      slot_index,
      seed,
      draw_position,
      user_id,
      is_bye
    )
    values (
      created_member_id,
      slot_record.group_index,
      slot_record.slot_index,
      slot_record.slot_index + 1,
      (slot_record.group_index * tournament_record.group_size) + slot_record.slot_index + 1,
      slot_record.user_id,
      slot_record.user_id is null
    );
  end loop;

  select coalesce(max(case
    when real_count < 2 then 0
    when mod(real_count, 2) = 0 then real_count - 1
    else real_count
  end), 0)::integer
  into max_group_round_count
  from (
    select group_index, count(*)::integer as real_count
    from scheduled_created_group_members
    where is_bye is false
      and user_id is not null
    group by group_index
  ) counts;

  if max_group_round_count > 0 then
    for group_round_number in 1..max_group_round_count loop
      group_deadline := case
        when group_round_number = 1 then now() + make_interval(
          mins => public.get_round_duration_minutes(
            tournament_record,
            'group',
            tournament_record.group_stage_format
          )
        )
        else null
      end;

      insert into public.tournament_rounds (
        tournament_id,
        stage_id,
        round_number,
        name,
        match_format,
        timer_started_at,
        deadline_at,
        timing_state
      )
      values (
        target_tournament,
        group_stage_id,
        group_round_number,
        'Group Round ' || group_round_number::text,
        tournament_record.group_stage_format,
        case when group_round_number = 1 then now() else null end,
        group_deadline,
        case when group_round_number = 1 then 'active' else 'idle' end
      );
    end loop;
  end if;

  for draw_group_index in 0..(tournament_record.groups_count - 1) loop
    truncate table scheduled_group_rotation;
    truncate table scheduled_group_next_rotation;

    insert into scheduled_group_rotation (position, member_id, user_id, seed, draw_position)
    select
      row_number() over (order by seed)::integer,
      member_id,
      user_id,
      seed,
      draw_position
    from scheduled_created_group_members
    where group_index = draw_group_index
      and is_bye is false
      and user_id is not null
    order by seed;

    select count(*)::integer
    into real_member_count
    from scheduled_group_rotation;

    if real_member_count < 2 then
      continue;
    end if;

    player_count := case
      when mod(real_member_count, 2) = 0 then real_member_count
      else real_member_count + 1
    end;
    group_round_count := player_count - 1;

    if player_count > real_member_count then
      insert into scheduled_group_rotation (position, member_id, user_id, seed, draw_position)
      values (player_count, null, null, null, null);
    end if;

    group_match_position := 1;

    for round_index in 0..(group_round_count - 1) loop
      select id
      into group_round_id
      from public.tournament_rounds tr
      where tr.stage_id = group_stage_id
        and tr.round_number = round_index + 1;

      for pair_index in 0..((player_count / 2) - 1) loop
        select *
        into first_slot
        from scheduled_group_rotation
        where position = pair_index + 1;

        select *
        into second_slot
        from scheduled_group_rotation
        where position = player_count - pair_index;

        if first_slot.user_id is not null and second_slot.user_id is not null then
          if mod(round_index, 2) = 0 then
            player_one := first_slot;
            player_two := second_slot;
          else
            player_one := second_slot;
            player_two := first_slot;
          end if;

          insert into public.matches (
            tournament_id,
            stage_id,
            round_id,
            group_id,
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
            result_type
          )
          select
            target_tournament,
            group_stage_id,
            group_round_id,
            cg.group_id,
            round_index + 1,
            match_number,
            group_match_position,
            player_one.user_id,
            player_two.user_id,
            player_one.seed,
            player_two.seed,
            player_one.draw_position,
            player_two.draw_position,
            tournament_record.group_stage_format,
            case when round_index = 0 then 'assigned'::public.match_status else 'pending'::public.match_status end,
            'played'::public.match_result_type
          from scheduled_created_groups cg
          where cg.group_index = draw_group_index;

          match_number := match_number + 1;
          group_match_position := group_match_position + 1;
        end if;
      end loop;

      truncate table scheduled_group_next_rotation;

      insert into scheduled_group_next_rotation
      select * from scheduled_group_rotation where position = 1;

      insert into scheduled_group_next_rotation (position, member_id, user_id, seed, draw_position)
      select 2, member_id, user_id, seed, draw_position
      from scheduled_group_rotation
      where position = player_count;

      insert into scheduled_group_next_rotation (position, member_id, user_id, seed, draw_position)
      select position + 1, member_id, user_id, seed, draw_position
      from scheduled_group_rotation
      where position between 2 and player_count - 1
      order by position;

      truncate table scheduled_group_rotation;
      insert into scheduled_group_rotation
      select * from scheduled_group_next_rotation;
    end loop;
  end loop;

  if match_number = 1 then
    generated_playoff := public.auto_generate_group_playoff(target_tournament, actor);
    perform public.apply_ready_match_openings(target_tournament);

    update public.tournaments
    set
      status = 'active',
      timing_state = case when generated_playoff then 'bracket_round' else 'active' end,
      timing_note = 'Scheduled automation generated the group draw.',
      last_automation_run_at = now(),
      updated_at = now()
    where id = target_tournament;
  else
    select deadline_at
    into group_deadline
    from public.tournament_rounds tr
    where tr.stage_id = group_stage_id
      and tr.round_number = 1;

    update public.tournaments
    set
      status = 'active',
      current_group_round_deadline = group_deadline,
      timing_state = 'group_round',
      timing_note = 'Scheduled automation generated the group draw and started group round one.',
      last_automation_run_at = now(),
      updated_at = now()
    where id = target_tournament;
  end if;

  result := jsonb_build_object(
    'applied', true,
    'format', 'group_stage_playoff',
    'checked_in_count', participant_count,
    'group_capacity', total_group_slots,
    'groups_count', tournament_record.groups_count,
    'matches_created', match_number - 1,
    'playoff_generated', generated_playoff
  );

  perform public.log_scheduled_automation_event(target_tournament, 'generate_group_draw', result);

  return result;
end;
$$;

create or replace function public.run_due_tournament_draw_automation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tournament_record public.tournaments%rowtype;
  draw_result jsonb;
  bracket_generated_count integer := 0;
  group_draw_generated_count integer := 0;
begin
  for tournament_record in
    select *
    from public.tournaments t
    where t.automation_mode = 'automatic'
      and t.auto_generate_draw_after_replacement is true
      and t.automation_paused_at is null
      and t.timers_paused_at is null
      and t.status = 'check_in'
      and not exists (
        select 1
        from public.tournament_stages s
        where s.tournament_id = t.id
      )
      and (
        t.timing_state = 'expired'
        or (
          t.replacement_window_enabled is true
          and coalesce(
            t.current_replacement_deadline,
            coalesce(
              t.current_check_in_deadline,
              t.starts_at + make_interval(mins => t.check_in_window_minutes)
            ) + make_interval(mins => t.replacement_window_minutes)
          ) <= now()
        )
        or (
          t.replacement_window_enabled is not true
          and coalesce(
            t.current_check_in_deadline,
            t.starts_at + make_interval(mins => t.check_in_window_minutes)
          ) <= now()
        )
      )
    for update skip locked
  loop
    if tournament_record.tournament_format = 'group_stage_playoff'::public.tournament_format then
      draw_result := public.generate_group_stage_draw_system(tournament_record.id, null);

      if (draw_result ->> 'applied')::boolean then
        group_draw_generated_count := group_draw_generated_count + 1;
      end if;
    elsif tournament_record.tournament_format = 'single_elimination'::public.tournament_format then
      draw_result := public.generate_single_elimination_draw_system(tournament_record.id, null);

      if (draw_result ->> 'applied')::boolean then
        bracket_generated_count := bracket_generated_count + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'brackets_generated', bracket_generated_count,
    'group_draws_generated', group_draw_generated_count
  );
end;
$$;

grant execute on function public.generate_single_elimination_draw_system(uuid, uuid) to service_role;
grant execute on function public.generate_group_stage_draw_system(uuid, uuid) to service_role;
grant execute on function public.run_due_tournament_draw_automation() to service_role;

do $$
begin
  perform cron.unschedule('tfm2_due_tournament_automation');
exception
  when others then
    null;
end;
$$;

select cron.schedule(
  'tfm2_due_tournament_automation',
  '* * * * *',
  'select public.run_due_tournament_automation(), public.run_due_tournament_draw_automation();'
);

notify pgrst, 'reload schema';
