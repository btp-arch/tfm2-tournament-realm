# Next Milestone Checklist: Pre-Live Smoke Testing and Public Help Pages

## Pre-Live Smoke Testing

- [ ] Run full browser smoke tests for single-elimination tournaments from registration through completion.
- [ ] Run full browser smoke tests for group-stage playoff tournaments, including underfilled groups, BYE/off-slots, qualifier ties, and playoff generation.
- [ ] Verify automation defaults to Manual and never Automatic unless organizer/admin explicitly enables it.
- [ ] Verify Automatic mode respects paused timers, paused automation, disabled toggles, disputes, existing reports, and repeated page polling.
- [ ] Verify random timeout advancement is labeled, advances only tournament progression, and remains excluded from public player/game records.
- [ ] Verify normal players cannot edit automation policy, run automation, see private evidence, or access Live Control.
- [ ] Confirm repeated Run Automation Now calls do not duplicate groups, brackets, rounds, matches, notifications, or automation events beyond the attempted run log.

## Public Help Pages

- [ ] Add concise public help copy for tournament registration, check-in, replacement slots, match rooms, result reporting, and disputes.
- [ ] Add player-facing help for automation modes and timeout policies without exposing organizer-only control details.
- [ ] Add record-counting help that clearly excludes FF, BYE, no-contest, random advancement, unresolved disputes, and test/stat-excluded tournaments.
- [ ] Add organizer-facing help for Live Control, timer pause/resume/extend, and emergency Manual mode.

## Operational Readiness

- [ ] Add focused tests for automation policy normalization, generated rules text, and timeout outcome policy selection.
- [ ] Add database tests or seed scripts for timeout FF, no-contest, random advancement, and staff-review paths.
- [ ] Document the no-cron/no-Edge-Function limitation: current automation is lazy and depends on app activity.
- [ ] Review RLS policies for tournament automation events before public launch.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check` before release.

## Always

- [ ] Keep automated game verification, Discord bot features, payments, buy-ins, wallets, paid subscriptions, and wagering out of scope.
- [ ] Keep dashboard calendar visibility independent from record eligibility.
- [ ] Treat admin corrections as source-data corrections.
