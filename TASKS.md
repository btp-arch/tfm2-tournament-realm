# Next Milestone Checklist: Public Test Tournament Dry Run / Test Data Tools

## Public Test Dry Run

- [ ] Run one 4-player single-elimination tournament from registration through final completion with test accounts.
- [ ] Run one small group-stage playoff tournament from registration through playoff completion with test accounts.
- [ ] Exercise a replacement-window path before bracket or group generation.
- [ ] Exercise one dispute path with evidence upload and organizer/admin resolution.
- [ ] Exercise one forfeit path and one no-contest path.
- [ ] Confirm random advancement remains clearly labeled and excluded from public records.

## Test Data Tools

- [ ] Decide whether a local-only seed script is needed for repeatable player, organizer, and admin test accounts.
- [ ] Add safe test-data helpers only if they avoid real secrets and production user data.
- [ ] Document how to clean up test tournaments without deleting real event history.
- [ ] Keep all database changes represented in `supabase/migrations` with RLS enabled and explicit policies.

## Operational Readiness

- [ ] Document the no-cron/no-Edge-Function limitation: current automation is lazy and depends on app activity.
- [ ] Review RLS policies for tournament automation events before public launch.
- [ ] Verify Supabase Auth Site URL and redirect URLs in the production dashboard.
- [ ] Verify Vercel environment variables before public testing.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check` before release.

## Always

- [ ] Keep automated game verification, Discord bot features, payments, paid organizer subscriptions, and wagering out of scope.
- [ ] Keep all tournaments free-entry and unofficial.
- [ ] Keep dashboard calendar visibility independent from record eligibility.
- [ ] Treat admin corrections as source-data corrections.
