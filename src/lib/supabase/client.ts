import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

type SupabaseGlobal = typeof globalThis & {
  __tfm2TournamentRealmSupabase?: SupabaseClient<Database>;
};

export function createClient(): SupabaseClient<Database> {
  const globalScope = globalThis as SupabaseGlobal;

  if (!globalScope.__tfm2TournamentRealmSupabase) {
    globalScope.__tfm2TournamentRealmSupabase = createSupabaseClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          storageKey: "tfm2-tournament-realm-auth",
        },
      },
    );
  }

  return globalScope.__tfm2TournamentRealmSupabase;
}
