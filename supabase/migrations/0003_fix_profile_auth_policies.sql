-- Explicit Data API grants are required when automatic table exposure is off.
grant usage on schema public to anon, authenticated, service_role;
grant usage on type public.platform_role to authenticated, service_role;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.platform_roles from anon, authenticated;

grant select on table public.profiles to authenticated;
grant insert (id, display_name, discord_username, steam_profile_url) on table public.profiles to authenticated;
grant update (display_name, discord_username, steam_profile_url, updated_at) on table public.profiles to authenticated;

grant select, insert, update, delete on table public.platform_roles to authenticated;

grant all privileges on table public.profiles to service_role;
grant all privileges on table public.platform_roles to service_role;

grant execute on function public.is_admin() to authenticated, service_role;

drop policy if exists "Profiles are readable by authenticated users" on public.profiles;
drop policy if exists "Users insert their own profile" on public.profiles;
drop policy if exists "Users update their own profile" on public.profiles;
drop policy if exists "Roles are readable by authenticated users" on public.platform_roles;
drop policy if exists "Admins manage roles" on public.platform_roles;

create policy "Users read their own profile"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy "Users insert their own profile"
  on public.profiles
  for insert
  to authenticated
  with check (id = auth.uid());

create policy "Users update their own profile"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "Users read their own platform roles"
  on public.platform_roles
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "Admins insert platform roles"
  on public.platform_roles
  for insert
  to authenticated
  with check (public.is_admin());

create policy "Admins update platform roles"
  on public.platform_roles
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admins delete platform roles"
  on public.platform_roles
  for delete
  to authenticated
  using (public.is_admin());
