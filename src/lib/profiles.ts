import type { SupabaseClient, User } from "@supabase/supabase-js";
import { logError } from "@/lib/errors";
import type { Database } from "@/types/database.generated";

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type ProfileUpdate = Pick<
  Database["public"]["Tables"]["profiles"]["Update"],
  "display_name" | "discord_username" | "steam_profile_url" | "updated_at"
>;

export const profileSelect =
  "id, display_name, discord_username, steam_profile_url, tfm2_handle, bio, created_at, updated_at";

export function buildDefaultDisplayName(user: User) {
  const metadataName = user.user_metadata?.display_name;
  const emailName = user.email?.split("@")[0];
  const candidate = typeof metadataName === "string" ? metadataName : emailName;
  const trimmed = candidate?.trim() || "Player";

  if (trimmed.length < 2) {
    return "Player";
  }

  return trimmed.slice(0, 40);
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505",
  );
}

async function loadProfileById(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Profile | null> {
  const existing = await supabase
    .from("profiles")
    .select(profileSelect)
    .eq("id", userId)
    .maybeSingle();

  if (existing.error) {
    logError("Unable to select profile.", existing.error);
    throw existing.error;
  }

  return existing.data;
}

export async function ensureProfile(
  supabase: SupabaseClient<Database>,
  user: User,
): Promise<Profile> {
  const existingProfile = await loadProfileById(supabase, user.id);

  if (existingProfile) {
    return existingProfile;
  }

  const created = await supabase
    .from("profiles")
    .insert({
      id: user.id,
      display_name: buildDefaultDisplayName(user),
    })
    .select(profileSelect)
    .single();

  if (created.error) {
    if (isUniqueViolation(created.error)) {
      const recoveredProfile = await loadProfileById(supabase, user.id);

      if (recoveredProfile) {
        return recoveredProfile;
      }
    }

    logError("Unable to create profile.", created.error);
    throw created.error;
  }

  return created.data;
}

export function normalizeOptionalText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
