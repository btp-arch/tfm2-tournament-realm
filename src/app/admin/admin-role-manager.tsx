"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui";
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
import {
  formatDateTime,
  tournamentStatusLabels,
  type TournamentRow,
} from "@/lib/tournaments";

const roleLabels: Record<PlatformRole, string> = {
  player: "Player",
  organizer: "Organizer",
  admin: "Admin",
};

type ProfileRoleSummary = {
  profile: Profile;
  roles: PlatformRoleRow[];
};

type PublicProfile = {
  id: string | null;
  display_name: string | null;
};

type RegistrationCountRow = {
  tournament_id: string | null;
  active_registration_count: number | null;
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
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [organizerNames, setOrganizerNames] = useState<Record<string, string>>({});
  const [registrationCounts, setRegistrationCounts] = useState<Record<string, number>>({});
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

  const loadTournamentManagementData = useCallback(async () => {
    const { data: tournamentRows, error: tournamentsError } = await supabase
      .from("tournaments")
      .select("*")
      .order("starts_at", { ascending: true, nullsFirst: false })
      .limit(250);

    if (tournamentsError) {
      throw tournamentsError;
    }

    const tournamentIds = tournamentRows.map((tournament) => tournament.id);
    const organizerIds = Array.from(
      new Set(tournamentRows.map((tournament) => tournament.created_by)),
    );

    let countsByTournament: Record<string, number> = {};
    let namesByOrganizer: Record<string, string> = {};

    if (tournamentIds.length > 0) {
      const { data: countRows, error: countsError } = await supabase
        .from("tournament_registration_counts")
        .select("tournament_id, active_registration_count")
        .in("tournament_id", tournamentIds);

      if (countsError) {
        throw countsError;
      }

      countsByTournament = (countRows as RegistrationCountRow[]).reduce<Record<string, number>>(
        (counts, row) => {
          if (row.tournament_id) {
            counts[row.tournament_id] = row.active_registration_count ?? 0;
          }

          return counts;
        },
        {},
      );
    }

    if (organizerIds.length > 0) {
      const { data: profileRows, error: profilesError } = await supabase
        .from("public_profiles")
        .select("id, display_name")
        .in("id", organizerIds);

      if (profilesError) {
        throw profilesError;
      }

      namesByOrganizer = (profileRows as PublicProfile[]).reduce<Record<string, string>>(
        (names, row) => {
          if (row.id) {
            names[row.id] = row.display_name ?? "Tournament staff";
          }

          return names;
        },
        {},
      );
    }

    setTournaments(tournamentRows);
    setRegistrationCounts(countsByTournament);
    setOrganizerNames(namesByOrganizer);
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
          await Promise.all([
            loadRoleManagementData(),
            loadTournamentManagementData(),
          ]);
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
  }, [loadRoleManagementData, loadTournamentManagementData, router, supabase]);

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

  async function updateCalendarVisibility(tournamentId: string, visible: boolean) {
    setIsSaving(true);
    setNotice(null);
    setError(null);

    const { error: visibilityError } = await supabase.rpc(
      "set_tournament_calendar_visibility",
      {
        target_tournament: tournamentId,
        visible,
      },
    );

    if (visibilityError) {
      logError("Calendar visibility update failed.", visibilityError);
      setError(formatError(visibilityError, "Unable to update calendar visibility."));
      setIsSaving(false);
      return;
    }

    await loadTournamentManagementData();
    setNotice(visible ? "Tournament added to the dashboard calendar." : "Tournament hidden from the dashboard calendar.");
    setIsSaving(false);
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
  }

  if (isLoading) {
    return <LoadingState message="Loading admin dashboard..." />;
  }

  if (error && !profile) {
    return <ErrorState message={error} />;
  }

  if (!user || !profile || !roles.isAdmin) {
    return <AccessDenied message="Admin tools are available only to platform admins." />;
  }

  return (
    <>
      <PageHeader
        eyebrow="Platform controls"
        title="Admin Dashboard"
        description={`Signed in as ${profile.display_name}.`}
      />

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

        <div className="card">
          <h2>Tournament Visibility</h2>
          <p className="muted">Admins can view and manage all tournaments from this dashboard.</p>
          <Link className="button button-link" href="/organizer">
            Organizer View
          </Link>
        </div>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Tournament Management</h2>
            <p className="muted">Review all tournaments, organizers, status, and registration counts.</p>
          </div>
          <span className="badge">{tournaments.length}</span>
        </div>

        {tournaments.length === 0 ? (
          <EmptyState
            message="Created tournaments will appear here for admin review and calendar visibility control."
            title="No tournaments created yet"
          />
        ) : (
          <div className="tournament-management-list">
            {tournaments.map((tournament) => {
              const count = registrationCounts[tournament.id] ?? 0;
              const capacity = tournament.max_players ? `/${tournament.max_players}` : "";

              return (
                <article className="management-row" key={tournament.id}>
                  <div>
                    <h3>{tournament.name}</h3>
                    <p className="muted">
                      {organizerNames[tournament.created_by] ?? "Tournament staff"} ·{" "}
                      {formatDateTime(tournament.starts_at)}
                    </p>
                    <div className="role-list">
                      <span className="badge">{tournamentStatusLabels[tournament.status]}</span>
                      <span className="badge">
                        {count}
                        {capacity} registered
                      </span>
                      <span className={tournament.show_on_calendar ? "badge status-badge status-badge-gold" : "badge status-badge status-badge-muted"}>
                        {tournament.show_on_calendar ? "Calendar Visible" : "Calendar Hidden"}
                      </span>
                    </div>
                  </div>
                  <div className="role-actions">
                    <button
                      className="button secondary-button"
                      disabled={isSaving}
                      type="button"
                      onClick={() =>
                        updateCalendarVisibility(tournament.id, !tournament.show_on_calendar)
                      }
                    >
                      {tournament.show_on_calendar ? "Hide From Calendar" : "Show On Calendar"}
                    </button>
                    <Link className="button secondary-button button-link" href={`/tournaments/${tournament.id}`}>
                      Manage
                    </Link>
                    <Link className="button button-link" href={`/tournaments/${tournament.id}/edit`}>
                      Edit
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
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
