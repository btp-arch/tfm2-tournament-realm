# Next Milestone Checklist: Player Match History and Records

- [ ] Design player match-history data access around finalized player-vs-player matches only.
- [ ] Exclude BYEs from match history, official record, overall record, wins/losses, and game wins/losses.
- [ ] Use final series scores for game wins/losses once match history is implemented.
- [ ] Apply tournament classification rules: official records count `official` and `championship`; overall records count `community`, `official`, and `championship`; `test` and `exclude_from_stats` do not count.
- [ ] Keep dashboard calendar visibility independent from record eligibility.
- [ ] Add public player profile and match-history pages without building full group-stage support.
- [ ] Review RLS, grants, and public aggregate exposure before publishing record data.
- [ ] Keep automated game verification, Discord bot features, payments, buy-ins, wallets, paid subscriptions, and wagering out of scope.
- [ ] Run `npm run lint` and `npm run typecheck` after each follow-up change.
