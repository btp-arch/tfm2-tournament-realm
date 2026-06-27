# Next Milestone Checklist: Series Score Reporting

- [ ] Add score entry and validation for BO1, BO3, and BO5 match formats.
- [ ] Keep winner selection authoritative until score reporting is fully validated.
- [ ] Show score summaries in match rooms, tournament match lists, and bracket cards.
- [ ] Confirm score reporting preserves result mismatch confirmation, disputes, evidence upload, notifications, and winner advancement.
- [ ] Re-test BYE/TBD/non-playable matches so they never ask for scores.
- [ ] Keep group stages, double elimination, seasons, regions, automated game verification, Discord bot features, payments, buy-ins, wallets, subscriptions, and wagering out of scope.
- [ ] Run `npm run lint` and `npm run typecheck` after each follow-up change.

# Following Milestone: Player Match History / Records

- [ ] Design public player profile and match-history pages.
- [ ] Use tournament classification rules: official records count `official` and `championship`; overall records count `community`, `official`, and `championship`; `test` and `exclude_from_stats` do not count.
- [ ] Confirm dashboard calendar visibility remains independent from record eligibility.
- [ ] Review RLS and grants before exposing public record aggregates.
