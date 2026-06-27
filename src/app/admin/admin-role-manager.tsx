"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MatchStatusBadge,
  PageHeader,
  TournamentTierBadge,
} from "@/components/ui";
import { formatError, logError } from "@/lib/errors";
import {
  calculateGameRecord,
  calculatePlayerRecord,
  countsTowardOfficialRecord,
  countsTowardOverallRecord,
  type PlayerRecordSource,
} from "@/lib/player-records";
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
  formatMatchFinalScore,
  matchStatusLabels,
  tournamentTierDescriptions,
  tournamentTierLabels,
  tournamentTiers,
  tournamentStatusLabels,
  type DisputeRow,
  type MatchRow,
  type TournamentRow,
  type TournamentTier,
} from "@/lib/tournaments";

const roleLabels: Record<PlatformRole, string> = {
  player: "Player",
  organizer: "Organizer",
  admin: "Admin",
};

type AdminTab = "overview" | "users" | "tournaments" | "disputes" | "records";

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

const adminTabs: { id: AdminTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "tournaments", label: "Tournaments" },
  { id: "disputes", label: "Disputes" },
  { id: "records", label: "Records" },
];

const activeTournamentStatuses = new Set<TournamentRow["status"]>([
  "registration_open",
  "registration_closed",
  "check_in",
  "active",
]);

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
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [roleRows, setRoleRows] = useState<PlatformRoleRow[]>([]);
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [recordMatches, setRecordMatches] = useState<MatchRow[]>([]);
  const [reviewMatches, setReviewMatches] = useState<MatchRow[]>([]);
  const [openDisputes, setOpenDisputes] = useState<DisputeRow[]>([]);
  const [organizerNames, setOrganizerNames] = useState<Record<string, string>>({});
  const [registrationCounts, setRegistrationCounts] = useState<Record<string, number>>({});
  const [searchTerm, setSearchTerm] = useState("");
  const [recordSearchTerm, setRecordSearchTerm] = useState("");
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

  const recordProfiles = useMemo(() => {
    return profiles
      .filter((loadedProfile) => profileMatchesSearch(loadedProfile, recordSearchTerm))
      .slice(0, 12);
  }, [profiles, recordSearchTerm]);

  const profileNames = useMemo(() => {
    return profiles.reduce<Record<string, string>>((names, loadedProfile) => {
      names[loadedProfile.id] = loadedProfile.display_name ?? "Player";

      return names;
    }, {});
  }, [profiles]);

  const tournamentsById = useMemo(() => {
    return tournaments.reduce<Record<string, TournamentRow>>((byId, tournament) => {
      byId[tournament.id] = tournament;

      return byId;
    }, {});
  }, [tournaments]);

  const activeTournamentCount = useMemo(
    () => tournaments.filter((tournament) => activeTournamentStatuses.has(tournament.status)).length,
    [tournaments],
  );

  const calendarVisibleCount = useMemo(
    () => tournaments.filter((tournament) => tournament.show_on_calendar).length,
    [tournaments],
  );

  const statsExcludedCount = useMemo(
    () => tournaments.filter((tournament) => tournament.exclude_from_stats).length,
    [tournaments],
  );

  const loadRoleManagementData = useCallback(async () => {
    const [profilesResult, rolesResult, recordMatchesResult] = await Promise.all([
      supabase.from("profiles").select(profileSelect).order("display_name").limit(250),
      supabase.from("platform_roles").select("user_id, role, granted_by, created_at"),
      supabase
        .from("matches")
        .select("*")
        .eq("status", "finalized")
        .order("updated_at", { ascending: false })
        .limit(1000),
    ]);

    if (profilesResult.error) {
      throw profilesResult.error;
    }

    if (rolesResult.error) {
      throw rolesResult.error;
    }

    if (recordMatchesResult.error) {
      throw recordMatchesResult.error;
    }

    setProfiles(profilesResult.data);
    setRoleRows(rolesResult.data);
    setRecordMatches((recordMatchesResult.data ?? []) as MatchRow[]);
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

  const loadDisputeReviewData = useCallback(async () => {
    const { data: matchRows, error: matchesError } = await supabase
      .from("matches")
      .select("*")
      .in("status", ["disputed", "needs_admin"])
      .order("updated_at", { ascending: false })
      .limit(50);

    if (matchesError) {
      throw matchesError;
    }

    const loadedMatches = matchRows as MatchRow[];
    const matchIds = loadedMatches.map((match) => match.id);
    let loadedDisputes: DisputeRow[] = [];

    if (matchIds.length > 0) {
      const { data: disputeRows, error: disputesError } = await supabase
        .from("disputes")
        .select("*")
        .in("match_id", matchIds)
        .in("status", ["open", "under_review"])
        .order("updated_at", { ascending: false });

      if (disputesError) {
        throw disputesError;
      }

      loadedDisputes = disputeRows as DisputeRow[];
    }

    setReviewMatches(loadedMatches);
    setOpenDisputes(loadedDisputes);
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
            loadDisputeReviewData(),
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
  }, [loadDisputeReviewData, loadRoleManagementData, loadTournamentManagementData, router, supabase]);

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

  async function updateTournamentClassification(
    tournamentId: string,
    tier: TournamentTier,
    excluded: boolean,
  ) {
    setIsSaving(true);
    setNotice(null);
    setError(null);

    const { error: classificationError } = await supabase.rpc(
      "set_tournament_classification",
      {
        target_tournament: tournamentId,
        tier,
        excluded,
      },
    );

    if (classificationError) {
      logError("Tournament classification update failed.", classificationError);
      setError(formatError(classificationError, "Unable to update tournament classification."));
      setIsSaving(false);
      return;
    }

    await loadTournamentManagementData();
    setNotice("Tournament classification updated.");
    setIsSaving(false);
  }

  function getPlayerName(userId: string | null) {
    if (!userId) {
      return "TBD";
    }

    return profileNames[userId] ?? "Player";
  }

  function getRecordSourcesForPlayer(playerId: string): PlayerRecordSource[] {
    return recordMatches.flatMap((match) => {
      if (match.player_one_id !== playerId && match.player_two_id !== playerId) {
        return [];
      }

      const tournament = tournamentsById[match.tournament_id];

      return tournament ? [{ match, tournament }] : [];
    });
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

      <nav className="admin-tabs" aria-label="Admin sections">
        {adminTabs.map((tab) => (
          <button
            className={activeTab === tab.id ? "active" : ""}
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "overview" ? (
        <>
          <section className="grid">
            <div className="card">
              <h2>Admin Identity</h2>
              <p>{profile.display_name}</p>
              <p className="muted">{user.email ?? user.id}</p>
            </div>

            <div className="card">
              <h2>Platform Health</h2>
              <dl className="admin-stat-list">
                <div>
                  <dt>Active tournaments</dt>
                  <dd>{activeTournamentCount}</dd>
                </div>
                <div>
                  <dt>Needs review</dt>
                  <dd>{reviewMatches.length}</dd>
                </div>
                <div>
                  <dt>Calendar visible</dt>
                  <dd>{calendarVisibleCount}</dd>
                </div>
              </dl>
            </div>

            <div className="card">
              <h2>Platform Safety</h2>
              <p className="muted">
                Keep events free-entry and community-run. Organizer access is manually assigned,
                and automated game verification remains outside this milestone.
              </p>
            </div>
          </section>

          <section className="card">
            <div className="section-heading">
              <div>
                <h2>Quick Actions</h2>
                <p className="muted">Jump to the admin work area that needs attention.</p>
              </div>
            </div>
            <div className="admin-quick-actions">
              <button className="button secondary-button" type="button" onClick={() => setActiveTab("users")}>
                Manage Users
              </button>
              <button className="button secondary-button" type="button" onClick={() => setActiveTab("tournaments")}>
                Manage Tournaments
              </button>
              <button className="button secondary-button" type="button" onClick={() => setActiveTab("disputes")}>
                Review Disputes
              </button>
              <Link className="button button-link" href="/organizer">
                Organizer View
              </Link>
            </div>
          </section>
        </>
      ) : null}

      {activeTab === "users" ? (
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>User Role Management</h2>
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
      ) : null}

      {activeTab === "tournaments" ? (
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Tournament Management</h2>
              <p className="muted">
                Review all tournaments, calendar visibility, and record classification.
              </p>
            </div>
            <div className="role-list">
              <span className="badge">{tournaments.length} total</span>
              <span className="badge">{statsExcludedCount} stats excluded</span>
            </div>
          </div>

          {notice ? <p className="notice">{notice}</p> : null}
          {error ? <p className="error">{error}</p> : null}

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
                        <TournamentTierBadge tier={tournament.tournament_tier} />
                        {tournament.exclude_from_stats ? (
                          <span className="badge status-badge status-badge-danger">Stats Excluded</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="role-actions">
                      <label className="compact-control" htmlFor={`classification-${tournament.id}`}>
                        Tier
                        <select
                          disabled={isSaving}
                          id={`classification-${tournament.id}`}
                          value={tournament.tournament_tier}
                          title={tournamentTierDescriptions[tournament.tournament_tier]}
                          onChange={(event) =>
                            updateTournamentClassification(
                              tournament.id,
                              event.target.value as TournamentTier,
                              tournament.exclude_from_stats,
                            )
                          }
                        >
                          {tournamentTiers.map((tier) => (
                            <option key={tier} value={tier}>
                              {tournamentTierLabels[tier]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="checkbox-control">
                        <input
                          checked={tournament.exclude_from_stats}
                          disabled={isSaving}
                          type="checkbox"
                          onChange={(event) =>
                            updateTournamentClassification(
                              tournament.id,
                              tournament.tournament_tier,
                              event.target.checked,
                            )
                          }
                        />
                        Exclude Stats
                      </label>
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
      ) : null}

      {activeTab === "disputes" ? (
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Disputes</h2>
              <p className="muted">Open match reviews that need organizer or admin resolution.</p>
            </div>
            <span className="badge">{reviewMatches.length} needs review</span>
          </div>

          {reviewMatches.length === 0 ? (
            <EmptyState
              message="Matches with disputed results or admin-review states will appear here."
              title="No open disputes"
            />
          ) : (
            <div className="tournament-management-list">
              {reviewMatches.map((match) => {
                const tournament = tournamentsById[match.tournament_id];
                const dispute = openDisputes.find((row) => row.match_id === match.id);
                const score = formatMatchFinalScore(match);

                return (
                  <article className="management-row" key={match.id}>
                    <div>
                      <h3>{tournament?.name ?? "Tournament match"}</h3>
                      <p className="muted">
                        Match {match.match_number ?? match.bracket_position ?? match.id.slice(0, 8)} · Round{" "}
                        {match.round_number}
                      </p>
                      <div className="role-list">
                        <MatchStatusBadge tone="danger">{matchStatusLabels[match.status]}</MatchStatusBadge>
                        {dispute ? <span className="badge">Dispute {dispute.status.replaceAll("_", " ")}</span> : null}
                        {score ? <span className="badge">{score}</span> : null}
                      </div>
                      <p className="muted">
                        {getPlayerName(match.player_one_id)} vs {getPlayerName(match.player_two_id)}
                      </p>
                      {dispute?.reason ? <p className="muted">Reason: {dispute.reason}</p> : null}
                    </div>
                    <div className="role-actions">
                      <Link className="button button-link" href={`/matches/${match.id}`}>
                        Open Match Room
                      </Link>
                      <Link className="button secondary-button button-link" href={`/tournaments/${match.tournament_id}`}>
                        Tournament
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "records" ? (
        <>
          <section className="card">
            <div className="section-heading">
              <div>
                <h2>Records Review Foundation</h2>
                <p className="muted">
                  Player records are computed from finalized match and tournament source data.
                </p>
              </div>
              <span className="badge">No manual W-L overrides</span>
            </div>

            <div className="record-rules-grid">
              <div>
                <h3>Official Record</h3>
                <p className="muted">
                  Counts finalized player-vs-player matches from `official` and `championship`
                  tournaments when `exclude_from_stats` is false.
                </p>
              </div>
              <div>
                <h3>Overall Record</h3>
                <p className="muted">
                  Counts finalized player-vs-player matches from `community`, `official`, and
                  `championship` tournaments when `exclude_from_stats` is false.
                </p>
              </div>
              <div>
                <h3>Correction Path</h3>
                <p className="muted">
                  Admin corrections should update source data: tier, stat exclusion, match winner,
                  match score, dispute resolution, replay, or no-contest state.
                </p>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="section-heading">
              <div>
                <h2>Record Sources</h2>
                <p className="muted">
                  Search players to review computed records. Correct source matches or tournament classification instead of editing W-L totals.
                </p>
              </div>
            </div>

            <form className="search-row" onSubmit={handleSearch}>
              <label htmlFor="record-profile-search">Search players</label>
              <input
                id="record-profile-search"
                value={recordSearchTerm}
                onChange={(event) => setRecordSearchTerm(event.target.value)}
                placeholder="Display name, Discord username, Steam URL, or user ID"
              />
            </form>

            <div className="role-management-list">
              {recordProfiles.map((recordProfile) => {
                const recordSources = getRecordSourcesForPlayer(recordProfile.id);
                const officialMatchRecord = calculatePlayerRecord(
                  recordSources,
                  recordProfile.id,
                  countsTowardOfficialRecord,
                );
                const officialGameRecord = calculateGameRecord(
                  recordSources,
                  recordProfile.id,
                  countsTowardOfficialRecord,
                );
                const overallMatchRecord = calculatePlayerRecord(
                  recordSources,
                  recordProfile.id,
                  countsTowardOverallRecord,
                );
                const overallGameRecord = calculateGameRecord(
                  recordSources,
                  recordProfile.id,
                  countsTowardOverallRecord,
                );

                return (
                  <article className="role-management-row" key={recordProfile.id}>
                    <div>
                      <h3>
                        <Link href={`/players/${recordProfile.id}`}>{recordProfile.display_name}</Link>
                      </h3>
                      <p className="muted">{recordProfile.discord_username ?? recordProfile.id}</p>
                      <div className="role-list">
                        <span className="badge">Computed</span>
                        <span className="badge">Finalized matches only</span>
                        <span className="badge">BYEs excluded</span>
                      </div>
                    </div>
                    <div className="admin-record-summary">
                      <p>
                        <strong>Official:</strong> {officialMatchRecord.wins}-{officialMatchRecord.losses} matches,{" "}
                        {officialGameRecord.gameWins}-{officialGameRecord.gameLosses} games
                      </p>
                      <p>
                        <strong>Overall:</strong> {overallMatchRecord.wins}-{overallMatchRecord.losses} matches,{" "}
                        {overallGameRecord.gameWins}-{overallGameRecord.gameLosses} games
                      </p>
                      <Link className="button secondary-button button-link" href={`/players/${recordProfile.id}`}>
                        Public Profile
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>

            {recordProfiles.length === 0 ? <p className="muted">No profiles match this search.</p> : null}
          </section>
        </>
      ) : null}
    </>
  );
}
