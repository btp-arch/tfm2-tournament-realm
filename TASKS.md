# Next Milestone Checklist: Results Polish and Operations

- [ ] Apply `supabase/migrations/0012_results_evidence_disputes.sql` to local and hosted Supabase.
- [ ] Regenerate database types from the migrated database with `npm run db:types`.
- [ ] Browser-test player agreement, mismatch change, confirmed mismatch dispute, staff resolution, replay-required, and no-contest paths.
- [ ] Browser-test private evidence uploads and signed evidence viewing for participants, organizers, admins, and non-participants.
- [ ] Add score entry and validation for BO1, BO3, and BO5 if match scores become required.
- [ ] Add staff evidence retention controls for dispute evidence that should be kept longer than the default 30-day MVP expiration.
- [ ] Add a future cleanup job for expired evidence objects and metadata.
- [ ] Add future penalty review tooling based on report changes, missing reports, and confirmed mismatches.
- [ ] Keep automated game verification, Discord bot features, Elo/ranked queue, payments, buy-ins, wallets, subscriptions, and wagering out of scope.
- [ ] Run `npm run lint` and `npm run typecheck` after each follow-up change.
