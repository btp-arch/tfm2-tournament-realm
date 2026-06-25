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
- `/admin` lists all tournaments with organizer, status, and registered participant count.

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
5. Confirm `/matches/[id]` shows tournament, round, match number, player names, match format, status, lobby instructions, patch/game version as not specified, and the timeline.
6. Sign in as Player A and check in for the match.
7. Sign in as Player B and check in for the match.
8. Confirm both check-ins move the match to host setup and randomly assign either player as host.
9. Confirm the host is shown as Blue, the guest is shown as Red, and the lobby name is the guest/opponent display name.
10. As the assigned host, create a public friendly game in TFM2 using the shown lobby name, then click Match Created.
11. Confirm the match status becomes In Game without a guest joined click.
12. Sign in as a non-participant and confirm public match info is visible but player action buttons are unavailable.
13. Sign in as organizer/admin and confirm staff can reset the match room, assign/reassign host, and mark Match Created without any result reporting controls.
14. Open BYE/TBD matches and confirm they clearly show that no player match-room action is required yet.

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
