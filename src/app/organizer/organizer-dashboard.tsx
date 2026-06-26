"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/ui";
import { formatError, logError } from "@/lib/errors";
import { ensureProfile, type Profile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  editableTournamentStatuses,
  formatDateTime,
  tournamentStatusLabels,
  type MatchRow,
  type TournamentRow,
  type TournamentStatus,
} from "@/lib/tournaments";

type RegistrationCountRow = {
  tournament_id: string | null;
  active_registration_count: number | null;
};

export function OrganizerDashboard() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [registrationCounts, setRegistrationCounts] = useState<Record<string, number>>({});
  const [reviewCounts, setReviewCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tournamentsByStatus = useMemo(() => {
    return editableTournamentStatuses
      .map((status) => ({
        status,
        tournaments: tournaments.filter((tournament) => tournament.status === status),
      }))
      .filter((group) => group.tournaments.length > 0);
  }, [tournaments]);

  const loadManagedTournaments = useCallback(async (currentUser: User, loadedRoles: RoleState) => {
    if (loadedRoles.isAdmin) {
      const { data, error: tournamentsError } = await supabase
        .from("tournaments")
        .select("*")
        .order("starts_at", { ascending: true, nullsFirst: false });

      if (tournamentsError) {
        throw tournamentsError;
      }

      return data;
    }

    const { data: organizerRows, error: organizerError } = await supabase
      .from("tournament_organizers")
      .select("tournament_id")
      .eq("user_id", currentUser.id);

    if (organizerError) {
      throw organizerError;
    }

    const tournamentIds = organizerRows.map((row) => row.tournament_id);

    if (tournamentIds.length === 0) {
      return [];
    }

    const { data, error: tournamentsError } = await supabase
      .from("tournaments")
      .select("*")
      .in("id", tournamentIds)
      .order("starts_at", { ascending: true, nullsFirst: false });

    if (tournamentsError) {
      throw tournamentsError;
    }

    return data;
  }, [supabase]);

  const loadRegistrationCounts = useCallback(async (managedTournaments: TournamentRow[]) => {
    const tournamentIds = managedTournaments.map((tournament) => tournament.id);

    if (tournamentIds.length === 0) {
      return {};
    }

    const { data, error: countsError } = await supabase
      .from("tournament_registration_counts")
      .select("tournament_id, active_registration_count")
      .in("tournament_id", tournamentIds);

    if (countsError) {
      throw countsError;
    }

    return (data as RegistrationCountRow[]).reduce<Record<string, number>>((counts, row) => {
      if (row.tournament_id) {
        counts[row.tournament_id] = row.active_registration_count ?? 0;
      }

      return counts;
    }, {});
  }, [supabase]);

  const loadReviewCounts = useCallback(async (managedTournaments: TournamentRow[]) => {
    const tournamentIds = managedTournaments.map((tournament) => tournament.id);

    if (tournamentIds.length === 0) {
      return {};
    }

    const { data, error: matchesError } = await supabase
      .from("matches")
      .select("tournament_id, status")
      .in("tournament_id", tournamentIds)
      .in("status", ["disputed", "needs_admin", "result_reported"]);

    if (matchesError) {
      throw matchesError;
    }

    return (data as Pick<MatchRow, "tournament_id" | "status">[]).reduce<Record<string, number>>(
      (counts, match) => {
        counts[match.tournament_id] = (counts[match.tournament_id] ?? 0) + 1;

        return counts;
      },
      {},
    );
  }, [supabase]);

  useEffect(() => {
    let isMounted = true;

    async function loadDashboard() {
      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        router.replace("/auth?redirectTo=/organizer");
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

        if (loadedRoles.isOrganizer) {
          const managedTournaments = await loadManagedTournaments(data.user, loadedRoles);
          const [countsByTournament, reviewsByTournament] = await Promise.all([
            loadRegistrationCounts(managedTournaments),
            loadReviewCounts(managedTournaments),
          ]);

          if (!isMounted) {
            return;
          }

          setTournaments(managedTournaments);
          setRegistrationCounts(countsByTournament);
          setReviewCounts(reviewsByTournament);
          setLastUpdatedAt(new Date());
        }
      } catch (caughtError) {
        if (isMounted) {
          logError("Organizer dashboard load failed.", caughtError);
          setError(formatError(caughtError, "Unable to load organizer access."));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadDashboard();

    const intervalId = window.setInterval(() => {
      void loadDashboard();
    }, 15_000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [loadManagedTournaments, loadRegistrationCounts, loadReviewCounts, router, supabase]);

  if (isLoading) {
    return <LoadingState message="Loading organizer dashboard..." />;
  }

  if (error) {
    return <ErrorState message={error} />;
  }

  if (!user || !profile || !roles.isOrganizer) {
    return (
      <AccessDenied message="Organizer tools are available only to accounts with organizer or admin access." />
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Organizer tools"
        title="Organizer Dashboard"
        description={`Signed in as ${profile.display_name}${
          lastUpdatedAt ? `. Last updated ${lastUpdatedAt.toLocaleTimeString()}` : ""
        }.`}
        action={
          <Link className="button button-link" href="/tournaments/create">
            Create Tournament
          </Link>
        }
      />

      <section className="grid">
        <div className="card">
          <h2>Organizer Status</h2>
          <div className="role-list" aria-label="Current access">
            <span className="badge">Player</span>
            <span className="badge">Organizer</span>
            {roles.isAdmin ? <span className="badge">Admin</span> : null}
          </div>
        </div>

        <div className="card">
            <h2>Create Tournament</h2>
            <p className="muted">Set up a free-entry tournament and open registration.</p>
          </div>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>{roles.isAdmin ? "All Tournaments" : "Your Tournaments"}</h2>
            <p className="muted">Manage tournament setup and registration status.</p>
          </div>
          <span className="badge">{tournaments.length}</span>
        </div>

        {tournaments.length === 0 ? (
          <EmptyState
            message="Created or assigned tournaments will appear here."
            title="No tournaments created yet"
          />
        ) : (
          <div className="tournament-management-list">
            {tournamentsByStatus.map((group: { status: TournamentStatus; tournaments: TournamentRow[] }) => (
              <section className="status-group" key={group.status}>
                <div className="section-heading">
                  <h3>{tournamentStatusLabels[group.status]}</h3>
                  <StatusBadge status={group.status} />
                </div>
                {group.tournaments.map((tournament) => {
                  const count = registrationCounts[tournament.id] ?? 0;
                  const reviewCount = reviewCounts[tournament.id] ?? 0;
                  const capacity = tournament.max_players ? `/${tournament.max_players}` : "";

                  return (
                    <article className="management-row" key={tournament.id}>
                      <div>
                        <h3>{tournament.name}</h3>
                        <p className="muted">{formatDateTime(tournament.starts_at)}</p>
                        <p className="muted">
                          {count}
                          {capacity} registered participant{count === 1 ? "" : "s"}
                        </p>
                        {reviewCount > 0 ? (
                          <p className="error">
                            {reviewCount} match{reviewCount === 1 ? "" : "es"} need result review.
                          </p>
                        ) : null}
                      </div>
                      <div className="role-actions">
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
              </section>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
