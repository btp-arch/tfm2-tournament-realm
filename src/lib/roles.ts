import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/errors";
import type { Database } from "@/types/database.generated";

export type PlatformRole = Database["public"]["Enums"]["platform_role"];
export type PlatformRoleRow = Database["public"]["Tables"]["platform_roles"]["Row"];

export type RoleState = {
  roles: PlatformRole[];
  isPlayer: boolean;
  isOrganizer: boolean;
  isAdmin: boolean;
};

export const emptyRoleState: RoleState = {
  roles: [],
  isPlayer: true,
  isOrganizer: false,
  isAdmin: false,
};

const roleOrder: Record<PlatformRole, number> = {
  player: 0,
  organizer: 1,
  admin: 2,
};

function normalizeRoles(roles: PlatformRole[]) {
  return Array.from(new Set(roles)).sort((first, second) => roleOrder[first] - roleOrder[second]);
}

export function getRoleState(roles: PlatformRole[]): RoleState {
  const normalizedRoles = normalizeRoles(roles);

  return {
    roles: normalizedRoles,
    isPlayer: true,
    isOrganizer: isOrganizer(normalizedRoles),
    isAdmin: isAdmin(normalizedRoles),
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

export async function getCurrentUserRoles(supabase: SupabaseClient<Database>): Promise<RoleState> {
  const { data, error } = await supabase.auth.getUser();

  if (error) {
    logError("Unable to load current user for roles.", error);
    throw error;
  }

  if (!data.user) {
    return emptyRoleState;
  }

  return getPlatformRoles(supabase, data.user.id);
}

export function isOrganizer(roles: PlatformRole[] | RoleState) {
  const roleList = Array.isArray(roles) ? roles : roles.roles;
  return roleList.includes("organizer") || roleList.includes("admin");
}

export function isAdmin(roles: PlatformRole[] | RoleState) {
  const roleList = Array.isArray(roles) ? roles : roles.roles;
  return roleList.includes("admin");
}

export function canManageTournament(roles: PlatformRole[] | RoleState) {
  return isOrganizer(roles);
}
