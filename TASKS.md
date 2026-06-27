# Next Milestone Checklist: Group Stage Hardening / Group UI Polish / Tiebreaker Review

## Group Stage Hardening

- [ ] Add focused tests for group BYE generation, group reset safety, group match generation counts, playoff BYE placement, and playoff bracket generation.
- [ ] Add focused tests for derived tournament capacity from single-elimination bracket size and group size/count.
- [ ] Add focused tests for pre-semifinal/semifinal/final round-format defaults in generated brackets.
- [ ] Add database-level RPC coverage for group draw and playoff generation if staff action auditing needs to move fully server-side.
- [ ] Add safeguards for deleting or editing group-stage settings after a draw exists.
- [ ] Add clearer admin recovery tools for accidental FF or qualifier override mistakes.
- [ ] Confirm group-stage notifications behave well for large 64-player events.
- [ ] Add test coverage for same-group first-round rematch avoidance across top 2/top 3/top 4 formats.

## Group Tiebreakers

- [ ] Expand head-to-head handling beyond simple two-player ties.
- [ ] Add an explicit tiebreaker review queue or staff badge when a cutoff tie blocks playoff generation.
- [ ] Add optional tiebreaker match support if manual overrides are not enough.
- [ ] Keep standings computed from match source data, not manually edited totals.
- [ ] Document final tournament policy for multi-way ties before official/championship use.

## Group UI Polish

- [ ] Improve mobile density for group cards and standings tables after browser QA.
- [ ] Add clearer visual qualification lines for top 1/top 2/top 3/top 4.
- [ ] Add filters for group/playoff/stage in the Matches tab if event sizes make the list noisy.
- [ ] Add a small read-only explainer for FF and record-counting rules if users ask.
- [ ] Keep normal player views free of organizer/admin group controls.
- [ ] Consider a playoff seed preview table if organizers ask for more visibility before generation.

## Profile/Records Follow-Up

- [ ] Add focused tests for record eligibility, BYE exclusion, FF exclusion, no-contest exclusion, and tournament tier rules.
- [ ] Add profile page empty states for players with registrations but no finalized matches.
- [ ] Improve tournament result labels once richer placement data exists.
- [ ] Review `public_profiles` exposure before adding any new public profile fields.

## Always

- [ ] Keep automated game verification, Discord bot features, payments, buy-ins, wallets, paid subscriptions, and wagering out of scope.
- [ ] Keep dashboard calendar visibility independent from record eligibility.
- [ ] Treat admin corrections as source-data corrections.
- [ ] Run `npm run lint` and `npm run typecheck` after each follow-up change.
