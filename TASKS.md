# Next Milestone Checklist: Results, Evidence, and Disputes

- [ ] Apply the latest match-room migrations to local and hosted Supabase.
- [ ] Regenerate database types from the migrated database.
- [ ] Define match result reporting rules for BO1, BO3, and BO5.
- [ ] Add player result reporting without advancing winners automatically until confirmed.
- [ ] Add score fields and validation for match format limits.
- [ ] Add opponent confirmation flow for submitted results.
- [ ] Add screenshot/evidence upload through Supabase Storage with RLS-protected paths.
- [ ] Add dispute opening flow for contested results.
- [ ] Add organizer/admin dispute review and resolution tools.
- [ ] Add staff override for confirmed results and replay-required outcomes.
- [ ] Advance winners only after the result confirmation/resolution rules are satisfied.
- [ ] Keep automated game verification, Discord bot features, Elo/ranked queue, payments, buy-ins, wallets, subscriptions, and wagering out of scope.
- [ ] Add manual QA for reporter, opponent, organizer, admin, non-participant, BYE, and TBD behavior.
- [ ] Run `npm run lint` and `npm run typecheck`.
