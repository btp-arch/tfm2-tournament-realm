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
- `/organizer` requires organizer or admin access and shows the Milestone 3 tournament creation placeholder.
- `/admin` requires admin access and includes profile search plus organizer/admin role management.

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
