# Next Milestone Checklist: Tournament Check-In and Bracket Setup

- [ ] Apply latest tournament management and admin override migrations to local and hosted Supabase.
- [ ] Regenerate database types from the migrated database.
- [ ] Define check-in windows, checked-in participant state, and RLS policies in a new migration.
- [ ] Add player check-in UI for registered players only.
- [ ] Add organizer/admin controls for opening and closing check-in.
- [ ] Show checked-in, not checked-in, and withdrawn participant counts to tournament staff.
- [ ] Define bracket tables, seed storage, and RLS policies in a new migration.
- [ ] Generate single-elimination brackets from checked-in players, with a fallback path for organizers to seed from registered players.
- [ ] Add bracket viewing to tournament detail pages.
- [ ] Add organizer/admin controls for seeding and bracket reset before matches begin.
- [ ] Prevent bracket generation for draft, cancelled, completed, or empty tournaments.
- [ ] Keep match rooms, result reporting, Discord bot features, automated verification, and monetization out of scope.
- [ ] Add manual QA for player, organizer, admin, and RLS behavior.
- [ ] Run `npm run lint` and `npm run typecheck`.
