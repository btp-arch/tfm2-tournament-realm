-- Allow admins to find profiles for platform role management.
-- Regular authenticated users remain limited to their own profile row.

drop policy if exists "Users read their own profile" on public.profiles;

create policy "Users read own profile and admins read profiles"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

create or replace function public.prevent_last_admin_role_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    (tg_op = 'DELETE' and old.role = 'admin')
    or (
      tg_op = 'UPDATE'
      and old.role = 'admin'
      and (new.role <> 'admin' or new.user_id <> old.user_id)
    )
  ) then
    if not exists (
      select 1
      from public.platform_roles
      where role = 'admin'
        and not (user_id = old.user_id and role = old.role)
    ) then
      raise exception 'Cannot remove the last platform admin.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_last_admin_role_removal on public.platform_roles;

create trigger prevent_last_admin_role_removal
  before update or delete on public.platform_roles
  for each row
  execute function public.prevent_last_admin_role_removal();
