"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { formatError, logError } from "@/lib/errors";
import { ensureProfile, type Profile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  formatDateTime,
  tournamentStatusLabels,
  type TournamentRow,
} from "@/lib/tournaments";

export function OrganizerDashboard() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

          if (!isMounted) {
            return;
          }

          setTournaments(managedTournaments);
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

    return () => {
      isMounted = false;
    };
  }, [loadManagedTournaments, router, supabase]);

  if (isLoading) {
    return <p className="muted">Loading organizer dashboard...</p>;
  }

  if (error) {
    return <p className="error">{error}</p>;
  }

  if (!user || !profile || !roles.isOrganizer) {
    return (
      <AccessDenied message="Organizer tools are available only to accounts with organizer or admin access." />
    );
  }

  return (
    <>
      <h1>Organizer Dashboard</h1>
      <p className="muted">Signed in as {profile.display_name}.</p>

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
          <Link className="button button-link" href="/tournaments/create">
            Create Tournament
          </Link>
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
          <p className="muted">No tournaments created yet.</p>
        ) : (
          <div className="tournament-management-list">
            {tournaments.map((tournament) => (
              <article className="management-row" key={tournament.id}>
                <div>
                  <h3>{tournament.name}</h3>
                  <p className="muted">{formatDateTime(tournament.starts_at)}</p>
                  <span className="badge">{tournamentStatusLabels[tournament.status]}</span>
                </div>
                <Link className="button secondary-button button-link" href={`/tournaments/${tournament.id}`}>
                  Manage
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
