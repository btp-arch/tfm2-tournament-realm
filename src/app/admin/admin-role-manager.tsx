"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { formatError, logError } from "@/lib/errors";
import { ensureProfile, profileSelect, type Profile } from "@/lib/profiles";
import {
  emptyRoleState,
  getCurrentUserRoles,
  type PlatformRole,
  type PlatformRoleRow,
  type RoleState,
} from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";

const roleLabels: Record<PlatformRole, string> = {
  player: "Player",
  organizer: "Organizer",
  admin: "Admin",
};

type ProfileRoleSummary = {
  profile: Profile;
  roles: PlatformRoleRow[];
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function profileMatchesSearch(profile: Profile, searchTerm: string) {
  const normalizedSearch = searchTerm.trim().toLowerCase();

  if (!normalizedSearch) {
    return true;
  }

  return [
    profile.display_name,
    profile.discord_username,
    profile.steam_profile_url,
    profile.id,
  ].some((value) => value?.toLowerCase().includes(normalizedSearch));
}

export function AdminRoleManager() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [roleRows, setRoleRows] = useState<PlatformRoleRow[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adminRoleCount = useMemo(
    () => roleRows.filter((roleRow) => roleRow.role === "admin").length,
    [roleRows],
  );

  const profileSummaries = useMemo<ProfileRoleSummary[]>(() => {
    return profiles
      .filter((loadedProfile) => profileMatchesSearch(loadedProfile, searchTerm))
      .map((loadedProfile) => ({
        profile: loadedProfile,
        roles: roleRows.filter((roleRow) => roleRow.user_id === loadedProfile.id),
      }));
  }, [profiles, roleRows, searchTerm]);

  const loadRoleManagementData = useCallback(async () => {
    const [profilesResult, rolesResult] = await Promise.all([
      supabase.from("profiles").select(profileSelect).order("display_name").limit(250),
      supabase.from("platform_roles").select("user_id, role, granted_by, created_at"),
    ]);

    if (profilesResult.error) {
      throw profilesResult.error;
    }

    if (rolesResult.error) {
      throw rolesResult.error;
    }

    setProfiles(profilesResult.data);
    setRoleRows(rolesResult.data);
  }, [supabase]);

  useEffect(() => {
    let isMounted = true;

    async function loadAdminDashboard() {
      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        router.replace("/auth?redirectTo=/admin");
        return;
      }

      try {
        const [loadedProfile, loadedRoles] = await Promise.all([
          ensureProfile(supabase, data.user),
          getCurrentUserRoles(supabase),
        ]);

        if (!isMounted) {
          return;
        }

        setUser(data.user);
        setProfile(loadedProfile);
        setRoles(loadedRoles);

        if (loadedRoles.isAdmin) {
          await loadRoleManagementData();
        }
      } catch (caughtError) {
        if (isMounted) {
          logError("Admin dashboard load failed.", caughtError);
          setError(formatError(caughtError, "Unable to load admin dashboard."));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadAdminDashboard();

    return () => {
      isMounted = false;
    };
  }, [loadRoleManagementData, router, supabase]);

  async function refreshAfterRoleChange(message: string) {
    const loadedRoles = await getCurrentUserRoles(supabase);
    setRoles(loadedRoles);

    if (loadedRoles.isAdmin) {
      await loadRoleManagementData();
    }

    setNotice(message);
  }

  async function grantRole(profileId: string, role: Exclude<PlatformRole, "player">) {
    if (!user) {
      return;
    }

    if (role === "admin") {
      const confirmed = window.confirm("Grant admin access to this account?");
      if (!confirmed) {
        return;
      }
    }

    setIsSaving(true);
    setNotice(null);
    setError(null);

    const { error: insertError } = await supabase.from("platform_roles").insert({
      user_id: profileId,
      role,
      granted_by: user.id,
    });

    if (insertError) {
      logError("Role grant failed.", insertError);
      setError(formatError(insertError, `Unable to grant ${roleLabels[role]} access.`));
      setIsSaving(false);
      return;
    }

    await refreshAfterRoleChange(`${roleLabels[role]} access granted.`);
    setIsSaving(false);
  }

  async function revokeRole(profileId: string, role: Exclude<PlatformRole, "player">) {
    if (role === "admin") {
      if (profileId === user?.id && adminRoleCount <= 1) {
        setError("You cannot remove your own last admin access.");
        return;
      }

      const confirmed = window.confirm("Revoke admin access from this account?");
      if (!confirmed) {
        return;
      }
    }

    setIsSaving(true);
    setNotice(null);
    setError(null);

    const { error: deleteError } = await supabase
      .from("platform_roles")
      .delete()
      .eq("user_id", profileId)
      .eq("role", role);

    if (deleteError) {
      logError("Role revoke failed.", deleteError);
      setError(formatError(deleteError, `Unable to revoke ${roleLabels[role]} access.`));
      setIsSaving(false);
      return;
    }

    await refreshAfterRoleChange(`${roleLabels[role]} access revoked.`);
    setIsSaving(false);
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
  }

  if (isLoading) {
    return <p className="muted">Loading admin dashboard...</p>;
  }

  if (error && !profile) {
    return <p className="error">{error}</p>;
  }

  if (!user || !profile || !roles.isAdmin) {
    return <AccessDenied message="Admin tools are available only to platform admins." />;
  }

  return (
    <>
      <h1>Admin Dashboard</h1>
      <p className="muted">Signed in as {profile.display_name}.</p>

      <section className="grid">
        <div className="card">
          <h2>Admin Identity</h2>
          <p>{profile.display_name}</p>
          <p className="muted">{user.email ?? user.id}</p>
        </div>

        <div className="card">
          <h2>Platform Safety</h2>
          <p className="muted">
            Keep events free-entry and community-run. Organizer access is manually assigned, and
            Discord bot features plus automated game verification are outside this milestone.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Role Management</h2>
            <p className="muted">Search profiles and manage organizer/admin access.</p>
          </div>
          <span className="badge">{adminRoleCount} admin{adminRoleCount === 1 ? "" : "s"}</span>
        </div>

        <form className="search-row" onSubmit={handleSearch}>
          <label htmlFor="profile-search">Search profiles</label>
          <input
            id="profile-search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Display name, Discord username, Steam URL, or user ID"
          />
        </form>

        {notice ? <p className="notice">{notice}</p> : null}
        {error ? <p className="error">{error}</p> : null}

        <div className="role-management-list">
          {profileSummaries.map((summary) => {
            const organizerRole = summary.roles.find((roleRow) => roleRow.role === "organizer");
            const adminRole = summary.roles.find((roleRow) => roleRow.role === "admin");
            const cannotRevokeAdmin =
              summary.profile.id === user.id && Boolean(adminRole) && adminRoleCount <= 1;

            return (
              <article className="role-management-row" key={summary.profile.id}>
                <div>
                  <h3>{summary.profile.display_name}</h3>
                  <p className="muted">{summary.profile.discord_username ?? summary.profile.id}</p>
                  <div className="role-list" aria-label={`${summary.profile.display_name} roles`}>
                    <span className="badge">Player</span>
                    {organizerRole ? <span className="badge">Organizer</span> : null}
                    {adminRole ? <span className="badge">Admin</span> : null}
                  </div>
                  {summary.roles.length > 0 ? (
                    <p className="muted role-meta">
                      {summary.roles
                        .map((roleRow) => `${roleLabels[roleRow.role]} granted ${formatDate(roleRow.created_at)}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>

                <div className="role-actions">
                  {organizerRole ? (
                    <button
                      className="button secondary-button"
                      disabled={isSaving}
                      type="button"
                      onClick={() => revokeRole(summary.profile.id, "organizer")}
                    >
                      Revoke Organizer
                    </button>
                  ) : (
                    <button
                      className="button"
                      disabled={isSaving}
                      type="button"
                      onClick={() => grantRole(summary.profile.id, "organizer")}
                    >
                      Grant Organizer
                    </button>
                  )}

                  {adminRole ? (
                    <button
                      className="button danger-button"
                      disabled={isSaving || cannotRevokeAdmin}
                      title={cannotRevokeAdmin ? "At least one admin must remain." : undefined}
                      type="button"
                      onClick={() => revokeRole(summary.profile.id, "admin")}
                    >
                      Revoke Admin
                    </button>
                  ) : (
                    <button
                      className="button secondary-button"
                      disabled={isSaving}
                      type="button"
                      onClick={() => grantRole(summary.profile.id, "admin")}
                    >
                      Grant Admin
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {profileSummaries.length === 0 ? <p className="muted">No profiles match this search.</p> : null}
      </section>
    </>
  );
}
