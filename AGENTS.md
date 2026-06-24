# TFM2 Tournament Realm Agent Instructions

- Keep the app simple, readable, and maintainable.
- This is an unofficial Teamfight Manager 2 community tournament hub.
- Free-entry tournaments and organizer tools are allowed.
- Never implement gambling, betting, wagers, buy-ins, wallets, deposits, withdrawals, cash pots, rake, payment features, or wager-site language.
- Do not build paid organizer subscriptions, Discord bot features, or automated game result verification until explicitly requested in a later milestone.
- Use Next.js, TypeScript, Supabase Auth, Supabase Postgres, Supabase Storage, SQL migrations, and Vercel-compatible patterns.
- Every database schema change must be represented in `supabase/migrations`.
- Every table must have RLS enabled and explicit policies.
- Never disable RLS as a workaround.
- Never commit `.env.local` or real secrets. Use `.env.example` with placeholder variable names only.
- Do not ask users for real Supabase keys in prompts.
