-- Keep app-visible profiles aligned with Supabase Auth users.

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_display_name text;
begin
  candidate_display_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(new.email, '@', 1), ''),
    'Player'
  );

  if char_length(candidate_display_name) < 2 then
    candidate_display_name := 'Player';
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, left(candidate_display_name, 40))
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists create_profile_for_auth_user on auth.users;

create trigger create_profile_for_auth_user
  after insert on auth.users
  for each row
  execute function public.create_profile_for_auth_user();

insert into public.profiles (id, display_name)
select
  auth_user.id,
  left(
    case
      when char_length(candidate.display_name) < 2 then 'Player'
      else candidate.display_name
    end,
    40
  ) as display_name
from auth.users auth_user
cross join lateral (
  select coalesce(
    nullif(btrim(auth_user.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(auth_user.email, '@', 1), ''),
    'Player'
  ) as display_name
) candidate
where not exists (
  select 1
  from public.profiles profile
  where profile.id = auth_user.id
)
on conflict (id) do nothing;
