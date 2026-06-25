"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatError, logError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/client";
import {
  formatDateTime,
  matchFormatLabels,
  publicTournamentStatuses,
  tournamentFormatLabels,
  tournamentStatusLabels,
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
    return <p className="muted">Loading tournaments...</p>;
  }

  if (error) {
    return <p className="error">{error}</p>;
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Tournaments</h1>
          <p className="muted">Upcoming free-entry Teamfight Manager 2 community tournaments.</p>
        </div>
      </div>

      {tournaments.length === 0 ? (
        <section className="card">
          <h2>No Upcoming Tournaments</h2>
          <p className="muted">Registration-open tournaments will appear here after organizers publish them.</p>
        </section>
      ) : (
        <section className="tournament-list" aria-label="Upcoming tournaments">
          {tournaments.map((tournament) => {
            const registrationCount = registrationCounts[tournament.id] ?? 0;
            const capacity = tournament.max_players
              ? `${registrationCount}/${tournament.max_players}`
              : `${registrationCount}`;

            return (
              <article className="card tournament-card" key={tournament.id}>
                <div className="section-heading">
                  <div>
                    <h2>
                      <Link href={`/tournaments/${tournament.id}`}>{tournament.name}</Link>
                    </h2>
                    <p className="muted">{formatDateTime(tournament.starts_at)}</p>
                  </div>
                  <span className="badge">{tournamentStatusLabels[tournament.status]}</span>
                </div>

                {tournament.status === "cancelled" ? (
                  <p className="error">This tournament has been cancelled.</p>
                ) : null}
                {tournament.description ? <p>{tournament.description}</p> : null}

                <dl className="meta-grid">
                  <div>
                    <dt>Format</dt>
                    <dd>{tournamentFormatLabels[tournament.tournament_format]}</dd>
                  </div>
                  <div>
                    <dt>Matches</dt>
                    <dd>{matchFormatLabels[tournament.format]}</dd>
                  </div>
                  <div>
                    <dt>Players</dt>
                    <dd>{capacity}</dd>
                  </div>
                  <div>
                    <dt>Registration Closes</dt>
                    <dd>{formatDateTime(tournament.registration_closes_at)}</dd>
                  </div>
                </dl>

                <Link className="button button-link" href={`/tournaments/${tournament.id}`}>
                  View Tournament
                </Link>
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}
