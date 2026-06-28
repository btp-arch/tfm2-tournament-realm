-- Timer expiry RPCs insert match_events rows with event_type = 'timer_expired'.
-- Add the enum value for databases that already applied the timer migrations.

alter type public.match_event_type add value if not exists 'timer_expired';

notify pgrst, 'reload schema';
