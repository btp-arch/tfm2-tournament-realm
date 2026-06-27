# TFM2 Tournament Realm

Unofficial free-entry competitive tournament hub for Teamfight Manager 2.

## Guardrails

This project is for community tournament organization only. Do not add gambling, betting, wagers, buy-ins, wallets, deposits, withdrawals, cash pots, rake, payment flows, paid organizer subscriptions, Discord bot features, or automated game-result verification in the current scope.

## Requirements

- Node.js 20 or newer
- npm
- Supabase CLI

## Install dependencies

```bash
npm install
```

## Supabase CLI

Install or verify the Supabase CLI:

```bash
supabase --version
```

If it is missing, follow the official Supabase CLI installation instructions for your operating system.

## Environment variables

Copy the placeholder file and fill in local values yourself:

```bash
cp .env.example .env.local
```

Required variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_PROJECT_ID`

Never commit `.env.local` or real secrets.

## Run the app

```bash
npm run dev
```

Open the local URL printed by Next.js.

## Apply Supabase migrations

For local Supabase development:

```bash
supabase start
supabase db reset
```

For a linked cloud project, link the project and push migrations:

```bash
supabase link --project-ref "$SUPABASE_PROJECT_ID"
supabase db push
```

Cloud execution may require Supabase access tokens configured in your shell or CI provider secrets.

## Supabase Auth setup

Enable email/password authentication in Supabase Auth. If email confirmations are enabled, add your local app URL to the allowed redirect URLs:

- `http://localhost:3000`
- `http://localhost:3000/auth`
- `http://localhost:3000/profile`
- `http://localhost:3000/organizer`
- `http://localhost:3000/admin`

The app uses the public Supabase URL and anon key from `.env.local`. Do not put service-role keys in the browser environment.

## Auth and profiles

- `/auth` provides sign-in and sign-up with Supabase Auth.
- The top navigation reads the browser session and shows `Sign In` when logged out, or `Profile` and `Sign Out` when logged in.
- `/profile` redirects logged-out visitors to `/auth?redirectTo=/profile`.
- On successful sign-in, sign-up with an active session, or first profile load, app code calls `ensureProfile` to create the authenticated user's `profiles` row if it does not already exist.
- Profile auto-creation is handled in app code instead of a database trigger for this milestone, so profile defaults can be kept near the auth/profile UI. The `profiles` table still uses RLS and only allows users to insert or update their own row.
- Player is the default experience. Organizer/admin role detection reads `platform_roles`.
- `/organizer` requires organizer or admin access and lists tournaments the organizer can manage.
- `/admin` requires admin access and includes profile search plus organizer/admin role management.

## Tournament creation and registration

- Organizers and admins can open `/tournaments/create` to create free-entry tournaments.
- The creator is inserted into `tournament_organizers` after tournament creation.
- V1 supports `single_elimination` tournaments and BO1/BO3/BO5 match formats.
- Public visitors can browse public tournament statuses on `/tournaments` and `/tournaments/[id]`.
- Signed-in players can register themselves while status is `registration_open`, capacity is available, and the registration close time has not passed.
- Registered players can withdraw themselves before registration closes.
- Organizers get safe live-event controls on the tournament detail page: close registration, open check-in, and generate the bracket to start.

### Tournament statuses

- `draft`: setup only, no registration
- `registration_open`: players may register
- `registration_closed`: registration locked
- `check_in`: registered players check in
- `active`: tournament has started
- `completed`: tournament finished
- `cancelled`: tournament called off

### Tournament management

- Organizers and admins can edit tournament details from `/tournaments/[id]/edit`.
- Editable fields include title, description, scheduled start time, registration close time, max participants, tournament format, match format, rules, external community link, and status.
- Tournament detail pages include a management panel for staff with edit, event-flow, cancel, delete, and participant count controls.
- Normal organizer start requires status `check_in`, a generated bracket size that can hold the field, and at least 2 checked-in players.
- Generating the bracket also starts the tournament by moving status to `active`.
- Cancel sets the tournament status to `cancelled`, keeps the tournament visible in history, and prevents new registration.
- Organizer delete is limited to tournaments they created that are still empty drafts.
- Admins have a platform-owner delete override for any tournament. The admin delete UI shows the tournament title, status, active participant count, total registration records, and requires typing `DELETE`. Cancel is still preferred for real events with participants.
- Admins have status overrides plus force controls for opening check-in and starting tournaments. If an admin force-starts a tournament with registered players but no check-ins, the UI requires confirmation before marking all registered players checked in and shows how many players will be included.
- Admins can close registration by setting status to `registration_closed`, and can reopen registration by setting status to `registration_open` only when the registration close time is in the future.
- `/organizer` groups managed tournaments by status and links to manage/edit.
- `/organizer` flags tournaments with result reports or disputes needing review.
- `/admin` lists all tournaments with organizer, status, registered participant count, dashboard calendar visibility, tournament tier, and stat-exclusion state.
- Admins control public dashboard calendar visibility from `/admin` tournament management. The dashboard reads only tournaments with `show_on_calendar = true`; organizers can still create and manage tournaments, but calendar placement is an admin decision.
- Admins control tournament classification from `/admin` tournament management. Classification is separate from calendar visibility and uses `tournament_tier` values of `test`, `community`, `official`, or `championship`, plus `exclude_from_stats`.
- Organizers can see classification state on organizer and tournament detail surfaces, but only admins can mark official/championship tiers or exclude tournaments from stats.

### Tournament records foundation

- Public player record pages are not implemented yet.
- Future official records should count only tournaments where `tournament_tier` is `official` or `championship`.
- Future overall records should count tournaments where `tournament_tier` is `community`, `official`, or `championship`.
- `test` tournaments should not count toward public player records.
- If `exclude_from_stats` is true, the tournament should be excluded from both official and overall public stats regardless of tier.
- Dashboard calendar visibility remains controlled only by `show_on_calendar`. A tournament can be calendar-visible without being official, and official/championship tournaments can be hidden from the dashboard calendar.

### Player dashboard and calendar

- `/` is a player-facing dashboard, not an organizer/admin control panel.
- The site-wide active action banner remains near the top of the app and links signed-in users to their highest-priority tournament or match action.
- The dashboard calendar shows 7 local-date columns: yesterday, today, and the next five days.
- Calendar cards show scheduled start time, tournament name, status, registered/max players, official/championship tier badges when applicable, and winner information for completed tournaments when a finalized winner can be derived from the bracket.
- Signed-in users also see `My Events`, which lists their registered tournaments and active match rooms without admin/organizer controls.
- Signed-out users see the public calendar plus a compact getting-started checklist.
- `Recent Winners` lists recently completed calendar-visible tournaments. Winner names are derived from the highest-round completed match with a winner, so older completed tournaments without finalized match data may show the winner as pending.

### Results, evidence, and disputes

- Match rooms support player result reporting after the match reaches `In Game`.
- Normal winner reporting asks only for the winner and optional notes. Evidence is not requested during aligned result reporting.
- Both players report the winner. If reports match, the result finalizes automatically and the winner advances in the single-elimination bracket.
- If reports differ, both players see a mismatch confirmation state. A player can change their report; if reports align, the match finalizes.
- If both players confirm different winners, a dispute opens for organizer/admin review.
- Staff can resolve review by confirming a winner, requiring replay, or marking no contest. Confirming a winner finalizes the match and advances that player.
- Evidence upload appears only in review contexts, such as an open dispute or organizer/admin review panel.
- Evidence uploads use the private `match-evidence` Supabase Storage bucket. Images are limited to PNG, JPG/JPEG, or WEBP, 5 MB each, and 3 uploads per player report.
- Evidence metadata stores match/report/user, type, file path/name, MIME type, size, notes, `expires_at`, and `retained_by_admin`. The MVP records a 30-day expiration timestamp but does not run automatic cleanup yet.

### Live UX and notifications

- Match setup is locked after a match moves past `awaiting_host_setup`, after lobby setup completes, after result reports exist, or after review/finalization begins. Staff must use the explicit reset action to recover setup.
- In-app notifications are stored in the private `notifications` table. Users can read/update/delete their own notifications; admins can manage notifications through RLS.
- Database triggers create notifications for tournament check-in opening, opponent check-in, match room ready, host assignment, result reporting needed, report mismatch, dispute opened/resolved, and player advancement.
- The top navigation includes a notifications menu with unread count, recent items, and mark-all-read.
- `/notifications` shows notification history with per-item and mark-all-read controls.
- A site-wide active action banner polls for the highest-priority signed-in user action and links directly to the tournament or match.
- Live pages poll for updates: match rooms and notifications every 12 seconds, tournament detail and organizer dashboard every 15 seconds.

### Manual tournament smoke test

1. Apply migrations and regenerate types for your target environment.
2. Start the app with `npm run dev`.
3. Sign in as an admin and grant organizer access to a test profile from `/admin`.
4. Sign in as that organizer and open `/tournaments/create`.
5. Create a tournament with status `Registration Open`, a future registration close time, and a later start time.
6. Confirm the tournament appears on `/tournaments` and the organizer dashboard.
7. Sign in as a normal player, open the tournament detail page, and register.
8. Refresh the detail page and confirm the participant count increments and the button changes to withdraw.
9. Withdraw before registration closes and confirm the participant count decrements.
10. As the organizer or admin, change the tournament status to `Registration Closed` and confirm normal players can no longer register.

### Manual tournament management smoke test

1. Sign in as an organizer or admin and create a draft tournament.
2. Open the tournament detail page and confirm the management panel shows the edit link, status control, cancel action, delete action, and registered participant count.
3. Open the edit page, change each editable field, save, and confirm the detail page reflects the changes.
4. Confirm a normal player cannot open the edit URL or see the management panel.
5. As the organizer who created an empty draft, delete it and confirm it disappears.
6. Create another tournament, open registration, register a player, then confirm delete is blocked with a reason.
7. Cancel that tournament and confirm it remains visible with a cancelled message and no registration button.
8. Confirm the organizer dashboard groups managed tournaments by status.
9. Confirm the admin dashboard lists all tournaments with organizer, status, participant count, and manage/edit links.

### Manual admin override smoke test

1. Sign in as an admin and open a tournament created by another organizer.
2. Confirm the admin can open `/tournaments/[id]/edit` and save changes.
3. Set the registration close time to the past, then try to reopen registration and confirm the UI requires a future close time.
4. Update the registration close time to the future, then reopen registration.
5. Close registration and confirm normal players can no longer register.
6. Force open check-in from an admin-managed tournament and confirm the status changes to `Check-in`.
7. Create another admin-managed tournament with 2-4 registered players and no check-ins, then click Admin Force Start Tournament.
8. Confirm the force-start dialog says how many registered players will be checked in, accept it, and verify the tournament moves to `Active` with a generated bracket.
9. Confirm the admin delete section shows title, status, participant counts, and total registration records.
10. Type `DELETE`, delete a tournament with registrations, and confirm the override succeeds.
11. Confirm an organizer still cannot delete a non-draft tournament or a draft tournament with any registration rows.

### Manual check-in and bracket smoke test

1. Apply migrations and regenerate types for your target environment.
2. Start the app with `npm run dev`.
3. Sign in as an organizer or admin and create a 4-player test tournament.
4. Set the tournament to `Registration Open`.
5. Register 2-4 signed-in test player accounts.
6. As staff, close registration and open check-in from the tournament detail management panel.
7. As registered players, confirm the Check In button appears only while status is `check_in`.
8. Check in at least two players.
9. As staff, confirm the participant list shows checked-in and missing players and that staff can manually mark or remove check-ins before bracket generation.
10. Choose bracket size 4, confirm semifinal/final round formats, and generate the bracket with Generate Bracket & Start Tournament.
11. Confirm the tournament moves to `active` and the detail page shows rounds, match numbers, player slots, BYE/TBD placeholders, round match formats, and match statuses.
12. Confirm a normal player can view the bracket but cannot see generate/reset controls.
13. Before match events or reports exist, reset the bracket and confirm the tournament returns to `check_in`.

### Manual match-room smoke test

1. Apply migrations and regenerate types for your target environment.
2. Start the app with `npm run dev`.
3. Use an active tournament with a generated bracket and at least one non-BYE player-vs-player match.
4. Open the tournament detail page and click Match Room on a real match.
5. Confirm `/matches/[id]` shows the Current Step card, tournament, round, match ID, player names, BO format, host/sides, lobby name instruction, lobby instructions, and the timeline.
6. Sign in as Player A and check in for the match.
7. Sign in as Player B and check in for the match.
8. Confirm both check-ins move the match to host setup and randomly assign either player as host.
9. Confirm the host is shown as Blue, the guest is shown as Red, and the lobby name is the guest/opponent display name.
10. As the assigned host, create a public friendly game in TFM2 using the shown lobby name, then click Match Created.
11. Confirm the match status becomes In Game without a guest joined click.
12. Confirm the Match Created button is disabled after the match reaches In Game, after reports exist, and after the result is confirmed.
13. Sign in as a non-participant and confirm public match info is visible but player action buttons are unavailable.
14. Sign in as organizer/admin and confirm staff can reset the match room, assign/reassign host before setup is past, mark Match Created, and resolve match review.
15. Open BYE/TBD matches and confirm they clearly show that no player match-room action is required yet.

### Manual result reporting smoke test

1. Apply migrations and regenerate types for your target environment.
2. Start the app with `npm run dev`.
3. Use an active tournament with a generated match between two signed-in player accounts.
4. Move the match to `In Game` through match-room check-in and host `Match Created`.
5. As Player A, report Player A as winner without uploading evidence.
6. As Player B, report Player A as winner.
7. Confirm the match finalizes, shows the winner, and advances the winner to the next-round TBD slot or completes the tournament if it was the final.
8. On another match, have Player A report Player A and Player B report Player B.
9. Confirm both players see “Reports do not match. Please confirm or change your report.”
10. Have one player change their report to match the other and confirm the match auto-finalizes.
11. Repeat the mismatch path, then have both players confirm their different reports.
12. Confirm the match becomes disputed and appears as needing review on `/organizer`.
13. Confirm the Review Evidence section appears for the disputed match and a participant can upload one PNG/JPG/WEBP screenshot.
14. As organizer/admin, confirm the review panel shows both player reports, confirmation states, evidence links, and resolution controls.
15. Resolve by confirming a winner and verify advancement.
16. Confirm non-participants cannot upload evidence, mutate reports, or view private evidence links.

### Manual live UX and notifications smoke test

1. Apply migrations and regenerate types for your target environment.
2. Start the app with `npm run dev`.
3. Open two signed-in player sessions and one organizer/admin session.
4. Move a tournament to `Check-In` and confirm registered players receive a notification and active action banner.
5. Have Player A check in for a match and confirm Player B sees an opponent check-in notification without refreshing after polling.
6. Have both players check in and confirm the host sees a host assignment notification and active action banner.
7. Have the host click Match Created and confirm both players see result-report actions after polling.
8. Submit mismatched reports and confirm both players receive mismatch notifications.
9. Confirm different reports from both players and verify dispute notifications plus organizer/admin active review banner.
10. Resolve the dispute and confirm dispute resolved and player advanced notifications.
11. Open `/notifications`, mark one item read, then mark all read and confirm the nav unread count updates.

### Manual dashboard calendar smoke test

1. Apply migrations and regenerate types for your target environment.
2. Start the app with `npm run dev`.
3. Open `/` while signed out and confirm the 7-day calendar displays yesterday, today, and the next five days.
4. Confirm only tournaments marked calendar-visible in `/admin` appear on the dashboard calendar.
5. Sign in as a player and confirm `My Events` shows player registrations and match rooms without organizer/admin controls.
6. Sign in as an admin and confirm `/` remains player-facing.
7. Open `/admin`, toggle a tournament with a start date inside the 7-day window to `Show On Calendar`, and confirm it appears on `/`.
8. Toggle the same tournament to hidden and confirm it disappears from `/`.
9. Inspect a completed visible tournament with a finalized winner and confirm `Recent Winners` shows the winner line.
10. Confirm the nav notification bell and site-wide active action banner still work.

## First admin bootstrap

Role management is intentionally admin-only, so a fresh environment needs one manual bootstrap if no admin exists yet. After the intended admin account has signed up, run this SQL with database owner privileges, replacing the placeholder email and display name:

```sql
insert into public.profiles (id, display_name)
select id, 'Platform Admin'
from auth.users
where email = 'admin@example.com'
on conflict (id) do nothing;

insert into public.platform_roles (user_id, role, granted_by)
select id, 'admin', null
from auth.users
where email = 'admin@example.com'
on conflict (user_id, role) do nothing;
```

After that admin signs in, use `/admin` for future organizer/admin grants. The database prevents removal of the final remaining admin role.

## Database types

After applying migrations locally, generate TypeScript database types:

```bash
npm run db:types
```

The generated file is expected at `src/types/database.generated.ts`.

## Checks

```bash
npm run lint
npm run typecheck
```

## Manual auth smoke test

1. Start the app with `npm run dev`.
2. Open `/auth` and create a test user with email/password.
3. If Supabase requires email confirmation, confirm the user in Supabase Auth or through the email link, then sign in.
4. Confirm the nav changes from `Sign In` to `Profile` and `Sign Out`.
5. Open `/profile`, edit display name, Discord username, and Steam profile URL, then save.
6. Confirm a player account does not see Organizer or Admin links in the nav.
7. Bootstrap or grant an admin role, then confirm `/admin` loads role management.
8. Grant an organizer role to a test profile, then confirm that account can open `/organizer`.
9. Sign out and confirm `/profile` sends the browser back to sign in.

## GUI Git option

If you prefer GitHub Desktop, open this repository folder, review the changed files, write a commit message, commit to the current branch, and push using the app's buttons.
