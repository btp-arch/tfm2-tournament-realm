import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

type SetTournamentRegistrationSeedArgs = {
  seed_value: number | null;
  target_registration: string;
};

export async function updateTournamentRegistrationSeed(
  supabase: SupabaseClient<Database>,
  {
    seedValue,
    targetRegistration,
  }: {
    seedValue: number | null;
    targetRegistration: string;
  },
) {
  const args: SetTournamentRegistrationSeedArgs = {
    seed_value: seedValue,
    target_registration: targetRegistration,
  };

  // Seed clearing is valid at runtime: Postgres integer args accept null unless
  // declared NOT NULL, but Supabase codegen currently emits this RPC arg as number.
  return supabase.rpc(
    "set_tournament_registration_seed",
    args as Database["public"]["Functions"]["set_tournament_registration_seed"]["Args"],
  );
}
