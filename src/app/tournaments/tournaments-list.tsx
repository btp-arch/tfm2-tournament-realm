"use client";

import { useEffect, useState } from "react";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  TournamentCard,
} from "@/components/ui";
import { formatError, logError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/client";
import {
  publicTournamentStatuses,
  type TournamentRow,
} from "@/lib/tournaments";

type RegistrationCountRow = {
  tournament_id: string | null;
  active_registration_count: number | null;
};

export function TournamentsList() {
  const [supabase] = useState(() => createClient());
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [registrationCounts, setRegistrationCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadTournaments() {
      setIsLoading(true);
      setError(null);

      try {
        const { data, error: tournamentsError } = await supabase
          .from("tournaments")
          .select("*")
          .in("status", publicTournamentStatuses)
          .order("starts_at", { ascending: true, nullsFirst: false })
          .limit(50);

        if (tournamentsError) {
          throw tournamentsError;
        }

        const tournamentIds = data.map((tournament) => tournament.id);
        let countsByTournament: Record<string, number> = {};

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

        const now = Date.now();
        const upcoming = data.filter((tournament) => {
          if (!tournament.starts_at) {
            return true;
          }

          return new Date(tournament.starts_at).getTime() >= now;
        });

        if (isMounted) {
          setTournaments(upcoming);
          setRegistrationCounts(countsByTournament);
        }
      } catch (caughtError) {
        if (isMounted) {
          logError("Tournament list load failed.", caughtError);
          setError(formatError(caughtError, "Unable to load tournaments."));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadTournaments();

    return () => {
      isMounted = false;
    };
  }, [supabase]);

  if (isLoading) {
    return <LoadingState message="Loading tournaments..." />;
  }

  if (error) {
    return <ErrorState message={error} />;
  }

  return (
    <>
      <PageHeader
        title="Tournaments"
        description="Upcoming Teamfight Manager 2 community tournaments."
      />

      {tournaments.length === 0 ? (
        <section className="card">
          <EmptyState
            message="Registration-open tournaments will appear here after organizers publish them."
            title="No upcoming tournaments"
          />
        </section>
      ) : (
        <section className="tournament-list" aria-label="Upcoming tournaments">
          {tournaments.map((tournament) => {
            const registrationCount = registrationCounts[tournament.id] ?? 0;

            return (
              <TournamentCard
                key={tournament.id}
                note={tournament.description ?? undefined}
                registrationCount={registrationCount}
                tournament={tournament}
              />
            );
          })}
        </section>
      )}
    </>
  );
}
