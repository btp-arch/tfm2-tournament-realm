# Next Milestone Checklist: Tournament Tabs + Bracket Visualization

- [ ] Apply `supabase/migrations/0015_tournament_classification.sql` to local and hosted Supabase.
- [ ] Regenerate database types from the migrated database with `npm run db:types`.
- [ ] Browser-test admin tournament classification from `/admin`, including `community`, `official`, `championship`, `test`, and `exclude_from_stats`.
- [ ] Confirm calendar visibility remains independent from tournament classification.
- [ ] Confirm organizers can see classification state but cannot change official/stat classification unless they are also admins.
- [ ] Design tournament detail tabs for Overview, Players, Bracket, Matches, and Rules without changing group-stage or scoring behavior.
- [ ] Add a clearer single-elimination bracket visualization for generated stages.
- [ ] Keep series score reporting as the alternate next milestone if bracket visualization is deferred.
- [ ] Re-test tournament detail registration, check-in, bracket generation, and management panels after the tab/bracket UI changes.
- [ ] Re-test match room check-in, host assignment, result reporting, mismatch confirmation, disputes, evidence upload, and winner advancement.
- [ ] Review RLS and grants for any future public dashboard fields before exposing them.
- [ ] Add score entry and validation for BO1, BO3, and BO5 only if match scores become required.
- [ ] Add staff evidence retention controls for dispute evidence that should be kept longer than the default 30-day MVP expiration.
- [ ] Add a future cleanup job for expired evidence objects and metadata.
- [ ] Keep automated game verification, Discord bot features, Elo/ranked queue, payments, buy-ins, wallets, subscriptions, and wagering out of scope.
- [ ] Run `npm run lint` and `npm run typecheck` after each follow-up change.
