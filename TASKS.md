# Next Milestone Checklist: Scores, Retention, and Review Polish

- [ ] Apply `supabase/migrations/0013_notifications_live_hardening.sql` to local and hosted Supabase.
- [ ] Regenerate database types from the migrated database with `npm run db:types`.
- [ ] Browser-test notifications, active action banner, and polling across two player sessions plus organizer/admin.
- [ ] Add score entry and validation for BO1, BO3, and BO5 if match scores become required.
- [ ] Add staff evidence retention controls for dispute evidence that should be kept longer than the default 30-day MVP expiration.
- [ ] Add a future cleanup job for expired evidence objects and metadata.
- [ ] Add notification preferences only after the base notification flow is stable.
- [ ] Add future penalty review tooling based on report changes, missing reports, and confirmed mismatches.
- [ ] Keep automated game verification, Discord bot features, Elo/ranked queue, payments, buy-ins, wallets, subscriptions, and wagering out of scope.
- [ ] Run `npm run lint` and `npm run typecheck` after each follow-up change.
