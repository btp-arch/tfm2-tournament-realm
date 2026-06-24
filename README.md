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

## GUI Git option

If you prefer GitHub Desktop, open this repository folder, review the changed files, write a commit message, commit to the current branch, and push using the app's buttons.
