"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  TournamentCard,
} from "@/components/ui";
import { redirectRecoveryToPasswordUpdateIfNeeded } from "@/lib/auth-redirects";
import { formatError, logError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/client";
import {
  formatDateTime,
  matchStatusLabels,
  publicTournamentStatuses,
  tournamentStatusLabels,
  type MatchRow,
  type TournamentRegistrationRow,
  type TournamentRow,
} from "@/lib/tournaments";

type RegistrationCountRow = {
  tournament_id: string | null;
  active_registration_count: number | null;
};

type PublicProfile = {
  id: string | null;
  display_name: string | null;
};

type DashboardMatch = MatchRow & {
  tournamentName: string;
};

type WinnerMatchRow = Pick<MatchRow, "tournament_id" | "winner_id" | "round_number">;

type WinnerSummary = {
  id: string;
  name: string;
};

function startOfLocalDay(date: Date) {
  const nextDate = new Date(date);
  nextDate.setHours(0, 0, 0, 0);
  return nextDate;
}

function addDays(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function getCalendarDays() {
  const today = startOfLocalDay(new Date());
  return Array.from({ length: 7 }, (_value, index) => addDays(today, index - 1));
}

function isSameLocalDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatDayTitle(day: Date) {
  if (isSameLocalDay(day, startOfLocalDay(new Date()))) {
    return "Today";
  }

  if (isSameLocalDay(day, addDays(startOfLocalDay(new Date()), -1))) {
    return "Yesterday";
  }

  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day);
}

function formatDayDate(day: Date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(day);
}

function getTournamentDayKey(tournament: TournamentRow) {
  return tournament.starts_at ? startOfLocalDay(new Date(tournament.starts_at)).toISOString() : "";
}

function getUniqueTournamentIds(tournaments: TournamentRow[]) {
  return Array.from(new Set(tournaments.map((tournament) => tournament.id)));
}

async function loadRegistrationCounts(
  supabase: ReturnType<typeof createClient>,
  tournamentIds: string[],
) {
  if (tournamentIds.length === 0) {
    return {};
  }

  const { data, error } = await supabase
    .from("tournament_registration_counts")
    .select("tournament_id, active_registration_count")
    .in("tournament_id", tournamentIds);

  if (error) {
    throw error;
  }

  return (data as RegistrationCountRow[]).reduce<Record<string, number>>((counts, row) => {
    if (row.tournament_id) {
      counts[row.tournament_id] = row.active_registration_count ?? 0;
    }

    return counts;
  }, {});
}

async function loadWinnerSummaries(
  supabase: ReturnType<typeof createClient>,
  tournaments: TournamentRow[],
) {
  const completedTournamentIds = tournaments
    .filter((tournament) => tournament.status === "completed")
    .map((tournament) => tournament.id);

  if (completedTournamentIds.length === 0) {
    return {};
  }

  const { data: matchRows, error: matchesError } = await supabase
    .from("matches")
    .select("tournament_id, winner_id, round_number")
    .in("tournament_id", completedTournamentIds)
    .not("winner_id", "is", null)
    .order("round_number", { ascending: false });

  if (matchesError) {
    throw matchesError;
  }

  const winnerByTournament = (matchRows as WinnerMatchRow[]).reduce<Record<string, string>>(
    (winners, match) => {
      if (match.winner_id && !winners[match.tournament_id]) {
        winners[match.tournament_id] = match.winner_id;
      }

      return winners;
    },
    {},
  );
  const winnerIds = Array.from(new Set(Object.values(winnerByTournament)));

  if (winnerIds.length === 0) {
    return {};
  }

  const { data: profiles, error: profilesError } = await supabase
    .from("public_profiles")
    .select("id, display_name")
    .in("id", winnerIds);

  if (profilesError) {
    throw profilesError;
  }

  const namesById = (profiles as PublicProfile[]).reduce<Record<string, string>>(
    (names, profile) => {
      if (profile.id) {
        names[profile.id] = profile.display_name ?? "Player";
      }

      return names;
    },
    {},
  );

  return Object.entries(winnerByTournament).reduce<Record<string, WinnerSummary>>(
    (winners, [tournamentId, winnerId]) => {
      winners[tournamentId] = {
        id: winnerId,
        name: namesById[winnerId] ?? "Player",
      };
      return winners;
    },
    {},
  );
}

export function DashboardHome() {
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [calendarTournaments, setCalendarTournaments] = useState<TournamentRow[]>([]);
  const [myTournaments, setMyTournaments] = useState<TournamentRow[]>([]);
  const [myMatches, setMyMatches] = useState<DashboardMatch[]>([]);
  const [recentWinners, setRecentWinners] = useState<TournamentRow[]>([]);
  const [registrationCounts, setRegistrationCounts] = useState<Record<string, number>>({});
  const [winnersByTournament, setWinnersByTournament] = useState<Record<string, WinnerSummary>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const calendarDays = useMemo(() => getCalendarDays(), []);

  const loadDashboard = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { data: authData } = await supabase.auth.getUser();
      const currentUser = authData.user;
      const rangeStart = calendarDays[0].toISOString();
      const rangeEnd = addDays(calendarDays[calendarDays.length - 1], 1).toISOString();

      const [calendarResult, winnersResult] = await Promise.all([
        supabase
          .from("tournaments")
          .select("*")
          .eq("show_on_calendar", true)
          .in("status", publicTournamentStatuses)
          .gte("starts_at", rangeStart)
          .lt("starts_at", rangeEnd)
          .order("starts_at", { ascending: true }),
        supabase
          .from("tournaments")
          .select("*")
          .eq("show_on_calendar", true)
          .eq("status", "completed")
          .order("starts_at", { ascending: false, nullsFirst: false })
          .limit(6),
      ]);

      if (calendarResult.error) throw calendarResult.error;
      if (winnersResult.error) throw winnersResult.error;

      const visibleCalendarTournaments = calendarResult.data as TournamentRow[];
      const winnerTournaments = winnersResult.data as TournamentRow[];
      let registeredTournaments: TournamentRow[] = [];
      let playerMatches: DashboardMatch[] = [];

      if (currentUser) {
        const { data: registrations, error: registrationsError } = await supabase
          .from("tournament_registrations")
          .select("*")
          .eq("user_id", currentUser.id)
          .neq("status", "withdrawn")
          .order("created_at", { ascending: false })
          .limit(30);

        if (registrationsError) {
          throw registrationsError;
        }

        const tournamentIds = ((registrations ?? []) as TournamentRegistrationRow[]).map(
          (registration) => registration.tournament_id,
        );

        if (tournamentIds.length > 0) {
          const { data: tournaments, error: tournamentsError } = await supabase
            .from("tournaments")
            .select("*")
            .in("id", tournamentIds)
            .in("status", publicTournamentStatuses)
            .neq("status", "completed")
            .order("starts_at", { ascending: true, nullsFirst: false });

          if (tournamentsError) {
            throw tournamentsError;
          }

          registeredTournaments = tournaments as TournamentRow[];
        }

        const { data: matches, error: matchesError } = await supabase
          .from("matches")
          .select("*")
          .or(`player_one_id.eq.${currentUser.id},player_two_id.eq.${currentUser.id}`)
          .in("status", [
            "assigned",
            "check_in_open",
            "awaiting_host_setup",
            "awaiting_guest_join",
            "in_game",
            "result_reported",
            "disputed",
            "needs_admin",
          ])
          .order("updated_at", { ascending: false })
          .limit(10);

        if (matchesError) {
          throw matchesError;
        }

        const matchRows = (matches ?? []) as MatchRow[];
        const matchTournamentIds = Array.from(
          new Set(matchRows.map((match) => match.tournament_id)),
        );
        let tournamentNamesById: Record<string, string> = {};

        if (matchTournamentIds.length > 0) {
          const { data: tournaments, error: tournamentsError } = await supabase
            .from("tournaments")
            .select("id, name")
            .in("id", matchTournamentIds);

          if (tournamentsError) {
            throw tournamentsError;
          }

          tournamentNamesById = (tournaments ?? []).reduce<Record<string, string>>(
            (names, tournament) => {
              names[tournament.id] = tournament.name;
              return names;
            },
            {},
          );
        }

        playerMatches = matchRows.map((match) => ({
          ...match,
          tournamentName: tournamentNamesById[match.tournament_id] ?? "Tournament",
        }));
      }

      const allCountIds = getUniqueTournamentIds([
        ...visibleCalendarTournaments,
        ...winnerTournaments,
        ...registeredTournaments,
      ]);
      const [counts, winners] = await Promise.all([
        loadRegistrationCounts(supabase, allCountIds),
        loadWinnerSummaries(supabase, [...visibleCalendarTournaments, ...winnerTournaments]),
      ]);

      setUser(currentUser);
      setCalendarTournaments(visibleCalendarTournaments);
      setRecentWinners(winnerTournaments);
      setMyTournaments(registeredTournaments);
      setMyMatches(playerMatches);
      setRegistrationCounts(counts);
      setWinnersByTournament(winners);
    } catch (caughtError) {
      logError("Dashboard load failed.", caughtError);
      setError(formatError(caughtError, "Unable to load the dashboard."));
    } finally {
      setIsLoading(false);
    }
  }, [calendarDays, supabase]);

  useEffect(() => {
    if (redirectRecoveryToPasswordUpdateIfNeeded()) {
      return;
    }

    window.addEventListener("hashchange", redirectRecoveryToPasswordUpdateIfNeeded);
    window.addEventListener("popstate", redirectRecoveryToPasswordUpdateIfNeeded);

    const timeoutId = window.setTimeout(() => {
      void loadDashboard();
    }, 0);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void loadDashboard();
    });

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("hashchange", redirectRecoveryToPasswordUpdateIfNeeded);
      window.removeEventListener("popstate", redirectRecoveryToPasswordUpdateIfNeeded);
      subscription.unsubscribe();
    };
  }, [loadDashboard, supabase]);

  const tournamentsByDay = calendarTournaments.reduce<Record<string, TournamentRow[]>>(
    (days, tournament) => {
      const key = getTournamentDayKey(tournament);
      days[key] = [...(days[key] ?? []), tournament];
      return days;
    },
    {},
  );

  return (
    <>
      <PageHeader
        title="TFM2 Tournament Realm"
        action={
          <Link className="button button-link" href="/tournaments">
            Browse Tournaments
          </Link>
        }
      />

      {isLoading ? <LoadingState message="Loading tournament dashboard..." /> : null}
      {error ? <ErrorState message={error} /> : null}

      <SectionCard
        className="dashboard-calendar-card"
        title="7-Day Tournament Calendar"
        action={
          <div className="calendar-status-key" aria-label="Calendar status color key">
            <span><span className="status-dot status-badge-action" aria-hidden="true" /> Registration</span>
            <span><span className="status-dot status-badge-muted" aria-hidden="true" /> Closed</span>
            <span><span className="status-dot status-badge-active" aria-hidden="true" /> Active</span>
            <span><span className="status-dot status-badge-gold" aria-hidden="true" /> Completed</span>
            <span><span className="status-dot status-badge-danger" aria-hidden="true" /> Cancelled</span>
            <span><span className="calendar-tier-symbol tier-official" aria-hidden="true">*</span> Official</span>
            <span><span className="calendar-tier-symbol tier-championship" aria-hidden="true">#</span> Championship</span>
          </div>
        }
      >
        <div className="calendar-grid" aria-label="Seven day tournament calendar">
          {calendarDays.map((day) => {
            const dayKey = day.toISOString();
            const tournaments = tournamentsByDay[dayKey] ?? [];
            const isToday = isSameLocalDay(day, new Date());

            return (
              <section className={isToday ? "calendar-day today" : "calendar-day"} key={dayKey}>
                <div className="calendar-day-heading">
                  <strong>{formatDayTitle(day)}</strong>
                  <span className="muted">{formatDayDate(day)}</span>
                </div>
                {tournaments.length > 0 ? (
                  <div className="calendar-tournament-list">
                    {tournaments.map((tournament) => (
                      <TournamentCard
                        calendarEntry
                        compact
                        key={tournament.id}
                        registrationCount={registrationCounts[tournament.id] ?? 0}
                        tournament={tournament}
                        winnerName={winnersByTournament[tournament.id]?.name ?? null}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="muted calendar-empty">No visible tournaments.</p>
                )}
              </section>
            );
          })}
        </div>
      </SectionCard>

      {user ? (
        <SectionCard
          title="My Events"
          description="Your registered tournaments and current match rooms."
        >
          {myMatches.length === 0 && myTournaments.length === 0 ? (
            <EmptyState
              message="Registered tournaments and active match rooms will appear here."
              title="No player events yet"
            />
          ) : (
            <div className="dashboard-two-column">
              <div className="action-card-list">
                <h3>Current Matches</h3>
                {myMatches.length === 0 ? (
                  <p className="muted">No active match rooms.</p>
                ) : (
                  myMatches.map((match) => (
                    <Link className="action-card" href={`/matches/${match.id}`} key={match.id}>
                      <span className="badge status-badge status-badge-action">
                        {matchStatusLabels[match.status]}
                      </span>
                      <strong>{match.tournamentName}</strong>
                      <span className="muted">Round {match.round_number}</span>
                    </Link>
                  ))
                )}
              </div>
              <div className="action-card-list">
                <h3>Registered Tournaments</h3>
                {myTournaments.length === 0 ? (
                  <p className="muted">No registered tournaments.</p>
                ) : (
                  myTournaments.map((tournament) => (
                    <TournamentCard
                      compact
                      key={tournament.id}
                      note={formatDateTime(tournament.starts_at)}
                      registrationCount={registrationCounts[tournament.id] ?? 0}
                      tournament={tournament}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </SectionCard>
      ) : (
        <SectionCard title="How It Works">
          <ol className="how-it-works-list">
            <li>Create an account.</li>
            <li>Register for a tournament.</li>
            <li>Check in when the event opens.</li>
            <li>Play your match.</li>
            <li>Report the winner and score.</li>
          </ol>
        </SectionCard>
      )}

      <SectionCard title="Recent Winners" description="Completed calendar-visible tournaments.">
        {recentWinners.length === 0 ? (
          <EmptyState
            message="Completed visible tournaments with finalized winners will appear here."
            title="No winners yet"
          />
        ) : (
          <div className="winner-list">
            {recentWinners.map((tournament) => {
              const winner = winnersByTournament[tournament.id];

              return (
                <article className="winner-row" key={tournament.id}>
                  <div>
                    <span className="time-label">{formatDateTime(tournament.starts_at)}</span>
                    <h3>
                      <Link href={`/tournaments/${tournament.id}`}>{tournament.name}</Link>
                    </h3>
                    <p className="muted">{tournamentStatusLabels[tournament.status]}</p>
                  </div>
                  <div className="winner-row-meta">
                    <span className="badge">
                      {registrationCounts[tournament.id] ?? 0}
                      {tournament.max_players ? `/${tournament.max_players}` : ""} players
                    </span>
                    {winner ? (
                      <Link className="winner-line" href={`/players/${winner.id}`}>
                        Winner: {winner.name}
                      </Link>
                    ) : (
                      <span className="muted">Winner pending</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>
    </>
  );
}
