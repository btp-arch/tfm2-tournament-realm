-- Follow-up for Milestone 10C: collapse automation modes to Manual/Automatic.
-- This is separate from 0029 so databases that already applied the earlier
-- three-mode constraint can move forward safely.

alter table public.tournaments
  alter column automation_mode set default 'manual';

update public.tournaments
set automation_mode = case
  when automation_mode = 'hands_off' then 'automatic'
  else 'manual'
end
where automation_mode in ('assisted', 'hands_off')
   or automation_mode is null;

alter table public.tournaments
  drop constraint if exists tournaments_automation_mode_known,
  add constraint tournaments_automation_mode_known
    check (automation_mode in ('manual', 'automatic'));

notify pgrst, 'reload schema';
