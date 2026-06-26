# Next Milestone Checklist: Pre-Live Dashboard Hardening

- [ ] Apply `supabase/migrations/0014_dashboard_calendar_visibility.sql` to local and hosted Supabase.
- [ ] Regenerate database types from the migrated database with `npm run db:types`.
- [ ] Browser-test the signed-out dashboard calendar across desktop and mobile widths.
- [ ] Browser-test signed-in player `My Events`, active action banner, and notification bell behavior.
- [ ] Browser-test admin calendar visibility toggling from `/admin` and confirm hidden tournaments do not appear on `/`.
- [ ] Seed or inspect at least one completed tournament with a finalized winner and confirm `Recent Winners` displays the winner.
- [ ] Re-test tournament detail registration, check-in, bracket generation, and management panels after the UI polish.
- [ ] Re-test match room check-in, host assignment, result reporting, mismatch confirmation, disputes, evidence upload, and winner advancement.
- [ ] Review RLS and grants for any future public dashboard fields before exposing them.
- [ ] Add score entry and validation for BO1, BO3, and BO5 only if match scores become required.
- [ ] Add staff evidence retention controls for dispute evidence that should be kept longer than the default 30-day MVP expiration.
- [ ] Add a future cleanup job for expired evidence objects and metadata.
- [ ] Keep automated game verification, Discord bot features, Elo/ranked queue, payments, buy-ins, wallets, subscriptions, and wagering out of scope.
- [ ] Run `npm run lint` and `npm run typecheck` after each follow-up change.
