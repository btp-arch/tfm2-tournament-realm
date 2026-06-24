import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/errors";
import type { Database } from "@/types/database.generated";

export type PlatformRole = Database["public"]["Enums"]["platform_role"];

export type RoleState = {
  roles: PlatformRole[];
  isPlayer: boolean;
  isOrganizer: boolean;
  isAdmin: boolean;
};

export function getRoleState(roles: PlatformRole[]): RoleState {
  return {
    roles,
    isPlayer: true,
    isOrganizer: roles.includes("organizer") || roles.includes("admin"),
    isAdmin: roles.includes("admin"),
  };
}

export async function getPlatformRoles(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<RoleState> {
  const { data, error } = await supabase
    .from("platform_roles")
    .select("role")
    .eq("user_id", userId);

  if (error) {
    logError("Unable to select platform roles.", error);
    throw error;
  }

  return getRoleState(data.map(({ role }) => role));
}
