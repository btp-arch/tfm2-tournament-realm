"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  formatMatchScore,
  getOpponentForMatch,
  getPlayerMatchResult,
  type PlayerRecordSource,
  type MatchRecordSummary,
  type GameRecordSummary,
} from "@/lib/player-records";
import { createClient } from "@/lib/supabase/client";
import {
  formatDateTime,
  matchFormatLabels,
  type MatchRow,
  type TournamentRoundRow,
  type TournamentRow,
} from "@/lib/tournaments";

type PublicProfile = {
  discord_username: string | null;
  display_name: string | null;
  id: string | null;
  steam_profile_url: string | null;
};

type BasicPublicProfile = {
  display_name: string | null;
  id: string | null;
};

type MatchWithContext = MatchRow & {
  opponentId: string | null;
  opponentName: string;
  result: "win" | "loss";
  roundName: string;
  score: string;
  tournament: TournamentRow;
};

type TournamentResult = {
  id: string;
  name: string;
  result: string;
  startsAt: string | null;
  tournament: TournamentRow;
};

function formatWinRate(record: MatchRecordSummary) {
  return record.matchesPlayed > 0 ? `${Math.round(record.winRate * 100)}%` : "0%";
}

function formatRecord(record: MatchRecordSummary) {
  return `${record.wins}-${record.losses}`;
}

function formatGameRecord(record: GameRecordSummary) {
  return `${record.gameWins}-${record.gameLosses}`;
}

function getTournamentDate(tournament: TournamentRow) {
  return tournament.starts_at ?? tournament.updated_at ?? tournament.created_at;
}

function isMissingPublicProfileField(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "42703",
  );
}

function normalizePublicProfile(profile: BasicPublicProfile): PublicProfile {
  const extendedProfile = profile as BasicPublicProfile & Partial<PublicProfile>;

  return {
    discord_username: extendedProfile.discord_username ?? null,
    display_name: profile.display_name,
    id: profile.id,
    steam_profile_url: extendedProfile.steam_profile_url ?? null,
  };
}

async function loadPublicProfileById(
  supabase: ReturnType<typeof createClient>,
  playerId: string,
) {
  const extended = await supabase
    .from("public_profiles")
    .select("id, display_name, discord_username, steam_profile_url")
    .eq("id", playerId)
    .maybeSingle();

  if (!extended.error) {
    return extended.data ? normalizePublicProfile(extended.data) : null;
  }

  if (!isMissingPublicProfileField(extended.error)) {
    throw extended.error;
  }

  const fallback = await supabase
    .from("public_profiles")
    .select("id, display_name")
    .eq("id", playerId)
    .maybeSingle();

  if (fallback.error) {
    throw fallback.error;
  }

  return fallback.data ? normalizePublicProfile(fallback.data) : null;
}

async function loadPublicProfilesById(
  supabase: ReturnType<typeof createClient>,
  profileIds: string[],
) {
  if (profileIds.length === 0) {
    return [];
  }

  const extended = await supabase
    .from("public_profiles")
    .select("id, display_name, discord_username, steam_profile_url")
    .in("id", profileIds);

  if (!extended.error) {
    return ((extended.data ?? []) as BasicPublicProfile[]).map(normalizePublicProfile);
  }

  if (!isMissingPublicProfileField(extended.error)) {
    throw extended.error;
  }

  const fallback = await supabase
    .from("public_profiles")
    .select("id, display_name")
    .in("id", profileIds);

  if (fallback.error) {
    throw fallback.error;
  }

  return ((fallback.data ?? []) as BasicPublicProfile[]).map(normalizePublicProfile);
}

function RecordSummaryCard({
  gameRecord,
  matchRecord,
  title,
  tournamentWins,
  finalsAppearances,
  primary = false,
}: {
  finalsAppearances: number;
  gameRecord: GameRecordSummary;
  matchRecord: MatchRecordSummary;
  primary?: boolean;
  title: string;
  tournamentWins: number;
}) {
  return (
    <section className={["card", "record-summary-card", primary ? "primary" : ""].filter(Boolean).join(" ")}>
      <div className="section-heading compact-heading">
        <div>
          <span className="badge">{primary ? "Primary" : "Summary"}</span>
          <h2>{title}</h2>
        </div>
      </div>
      <dl className="record-stat-grid">
        <div>
          <dt>Match W-L</dt>
          <dd>{formatRecord(matchRecord)}</dd>
        </div>
        <div>
          <dt>Game W-L</dt>
          <dd>{formatGameRecord(gameRecord)}</dd>
        </div>
        <div>
          <dt>Win Rate</dt>
          <dd>{formatWinRate(matchRecord)}</dd>
        </div>
        <div>
          <dt>Tournament Wins</dt>
          <dd>{tournamentWins}</dd>
        </div>
        <div>
          <dt>Finals</dt>
          <dd>{finalsAppearances}</dd>
        </div>
      </dl>
    </section>
  );
}

function getTournamentResultLabel(
  tournament: TournamentRow,
  playerId: string,
  playerMatches: MatchRow[],
  tournamentMatches: MatchRow[],
) {
  const finalizedTournamentMatches = tournamentMatches.filter(
    (match) =>
      match.tournament_id === tournament.id &&
      match.status === "finalized" &&
      match.winner_id,
  );
  const maxRound = Math.max(0, ...finalizedTournamentMatches.map((match) => match.round_number));
  const playerFinalizedMatches = playerMatches.filter(
    (match) =>
      match.tournament_id === tournament.id &&
      match.status === "finalized" &&
      (match.player_one_id === playerId || match.player_two_id === playerId),
  );
  const playerMaxRound = Math.max(0, ...playerFinalizedMatches.map((match) => match.round_number));
  const finalPlayerMatch = playerFinalizedMatches.find((match) => match.round_number === playerMaxRound);

  if (!finalPlayerMatch || maxRound === 0) {
    return "Participant";
  }

  if (playerMaxRound === maxRound && finalPlayerMatch.winner_id === playerId) {
    return "Champion";
  }

  if (playerMaxRound === maxRound) {
    return "Finalist";
  }

  if (playerMaxRound === maxRound - 1) {
    return "Semifinalist";
  }

  return `Round ${playerMaxRound}`;
}

export function PlayerProfile({ playerId }: { playerId: string }) {
  const [supabase] = useState(() => createClient());
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [tournamentMatches, setTournamentMatches] = useState<MatchRow[]>([]);
  const [tournaments, setTournaments] = useState<Record<string, TournamentRow>>({});
  const [rounds, setRounds] = useState<Record<string, TournamentRoundRow>>({});
  const [profiles, setProfiles] = useState<Record<string, PublicProfile>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPlayerProfile = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const profileRow = await loadPublicProfileById(supabase, playerId);

      if (!profileRow) {
        setProfile(null);
        setMatches([]);
        return;
      }

      const { data: matchRows, error: matchesError } = await supabase
        .from("matches")
        .select("*")
        .or(`player_one_id.eq.${playerId},player_two_id.eq.${playerId}`)
        .order("updated_at", { ascending: false })
        .limit(100);

      if (matchesError) {
        throw matchesError;
      }

      const loadedMatches = (matchRows ?? []) as MatchRow[];
      const tournamentIds = Array.from(new Set(loadedMatches.map((match) => match.tournament_id)));
      const roundIds = Array.from(
        new Set(loadedMatches.map((match) => match.round_id).filter(Boolean) as string[]),
      );
      const opponentIds = Array.from(
        new Set(
          loadedMatches
            .map((match) => getOpponentForMatch(match, playerId))
            .filter(Boolean) as string[],
        ),
      );

      const [tournamentResult, roundResult, opponentProfiles, tournamentMatchResult] = await Promise.all([
        tournamentIds.length > 0
          ? supabase.from("tournaments").select("*").in("id", tournamentIds)
          : Promise.resolve({ data: [], error: null }),
        roundIds.length > 0
          ? supabase.from("tournament_rounds").select("*").in("id", roundIds)
          : Promise.resolve({ data: [], error: null }),
        loadPublicProfilesById(supabase, opponentIds),
        tournamentIds.length > 0
          ? supabase
              .from("matches")
              .select("*")
              .in("tournament_id", tournamentIds)
              .eq("status", "finalized")
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (tournamentResult.error) throw tournamentResult.error;
      if (roundResult.error) throw roundResult.error;
      if (tournamentMatchResult.error) throw tournamentMatchResult.error;

      setProfile(profileRow);
      setMatches(loadedMatches);
      setTournamentMatches((tournamentMatchResult.data ?? []) as MatchRow[]);
      setTournaments(
        ((tournamentResult.data ?? []) as TournamentRow[]).reduce<Record<string, TournamentRow>>(
          (byId, tournament) => {
            byId[tournament.id] = tournament;
            return byId;
          },
          {},
        ),
      );
      setRounds(
        ((roundResult.data ?? []) as TournamentRoundRow[]).reduce<Record<string, TournamentRoundRow>>(
          (byId, round) => {
            byId[round.id] = round;
            return byId;
          },
          {},
        ),
      );
      setProfiles(
        opponentProfiles.reduce<Record<string, PublicProfile>>(
          (byId, loadedProfile) => {
            if (loadedProfile.id) {
              byId[loadedProfile.id] = loadedProfile;
            }

            return byId;
          },
          {},
        ),
      );
    } catch (caughtError) {
      logError("Player profile load failed.", caughtError);
      setError(formatError(caughtError, "Unable to load player profile."));
    } finally {
      setIsLoading(false);
    }
  }, [playerId, supabase]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadPlayerProfile();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadPlayerProfile]);

  const recordSources = useMemo<PlayerRecordSource[]>(() => {
    return matches.flatMap((match) => {
      const tournament = tournaments[match.tournament_id];

      return tournament ? [{ match, tournament }] : [];
    });
  }, [matches, tournaments]);

  const officialMatchRecord = useMemo(
    () => calculatePlayerRecord(recordSources, playerId, countsTowardOfficialRecord),
    [playerId, recordSources],
  );
  const officialGameRecord = useMemo(
    () => calculateGameRecord(recordSources, playerId, countsTowardOfficialRecord),
    [playerId, recordSources],
  );
  const overallMatchRecord = useMemo(
    () => calculatePlayerRecord(recordSources, playerId, countsTowardOverallRecord),
    [playerId, recordSources],
  );
  const overallGameRecord = useMemo(
    () => calculateGameRecord(recordSources, playerId, countsTowardOverallRecord),
    [playerId, recordSources],
  );

  const recentMatches = useMemo<MatchWithContext[]>(() => {
    return matches
      .flatMap((match) => {
        const tournament = tournaments[match.tournament_id];
        const result = getPlayerMatchResult(match, playerId);
        const score = formatMatchScore(match, playerId);
        const opponentId = getOpponentForMatch(match, playerId);

        if (!tournament || !countsTowardOverallRecord(tournament, match) || !result || !score) {
          return [];
        }

        return [
          {
            ...match,
            opponentId,
            opponentName: opponentId ? profiles[opponentId]?.display_name ?? "Player" : "Player",
            result,
            roundName: match.round_id ? rounds[match.round_id]?.name ?? `Round ${match.round_number}` : `Round ${match.round_number}`,
            score,
            tournament,
          },
        ];
      })
      .sort((first, second) => getTournamentDate(second.tournament).localeCompare(getTournamentDate(first.tournament)))
      .slice(0, 12);
  }, [matches, playerId, profiles, rounds, tournaments]);

  const missingScoreMatches = useMemo<MatchWithContext[]>(() => {
    return matches
      .flatMap((match) => {
        const tournament = tournaments[match.tournament_id];
        const opponentId = getOpponentForMatch(match, playerId);

        if (
          !tournament ||
          !countsTowardOverallRecord(tournament) ||
          match.status !== "finalized" ||
          match.result_type !== "played" ||
          !match.winner_id ||
          !opponentId ||
          match.final_winner_score !== null ||
          match.final_loser_score !== null
        ) {
          return [];
        }

        return [
          {
            ...match,
            opponentId,
            opponentName: profiles[opponentId]?.display_name ?? "Player",
            result: match.winner_id === playerId ? "win" as const : "loss" as const,
            roundName: match.round_id ? rounds[match.round_id]?.name ?? `Round ${match.round_number}` : `Round ${match.round_number}`,
            score: "Score missing",
            tournament,
          },
        ];
      })
      .sort((first, second) => getTournamentDate(second.tournament).localeCompare(getTournamentDate(first.tournament)));
  }, [matches, playerId, profiles, rounds, tournaments]);

  const tournamentResults = useMemo<TournamentResult[]>(() => {
    return Object.values(tournaments)
      .filter((tournament) => countsTowardOverallRecord(tournament))
      .map((tournament) => ({
        id: tournament.id,
        name: tournament.name,
        result: getTournamentResultLabel(tournament, playerId, matches, tournamentMatches),
        startsAt: tournament.starts_at,
        tournament,
      }))
      .sort((first, second) => getTournamentDate(second.tournament).localeCompare(getTournamentDate(first.tournament)))
      .slice(0, 10);
  }, [matches, playerId, tournamentMatches, tournaments]);

  const officialTournamentWins = tournamentResults.filter(
    (result) => result.result === "Champion" && countsTowardOfficialRecord(result.tournament),
  ).length;
  const officialFinals = tournamentResults.filter(
    (result) =>
      (result.result === "Champion" || result.result === "Finalist") &&
      countsTowardOfficialRecord(result.tournament),
  ).length;
  const overallTournamentWins = tournamentResults.filter((result) => result.result === "Champion").length;
  const overallFinals = tournamentResults.filter(
    (result) => result.result === "Champion" || result.result === "Finalist",
  ).length;

  if (isLoading) {
    return <LoadingState message="Loading player profile..." />;
  }

  if (error) {
    return <ErrorState message={error} />;
  }

  if (!profile) {
    return (
      <section className="card">
        <h1>Player Not Found</h1>
        <p className="muted">This public player profile is unavailable.</p>
      </section>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Player profile"
        title={profile.display_name ?? "Player"}
        description="Computed match history and records from finalized free-entry tournament results."
      />

      <section className="card player-profile-overview">
        <div>
          <h2>Public Details</h2>
          <div className="role-list">
            <span className="badge">BYEs excluded</span>
            <span className="badge">Finalized matches only</span>
            <span className="badge">No manual W-L overrides</span>
          </div>
        </div>
        <dl className="meta-grid">
          <div>
            <dt>Discord</dt>
            <dd>{profile.discord_username ?? "Not shared"}</dd>
          </div>
          <div>
            <dt>Steam</dt>
            <dd>
              {profile.steam_profile_url ? (
                <a href={profile.steam_profile_url} rel="noreferrer" target="_blank">
                  Steam profile
                </a>
              ) : (
                "Not shared"
              )}
            </dd>
          </div>
        </dl>
      </section>

      <div className="record-summary-layout">
        <RecordSummaryCard
          primary
          finalsAppearances={officialFinals}
          gameRecord={officialGameRecord}
          matchRecord={officialMatchRecord}
          title="Official Record"
          tournamentWins={officialTournamentWins}
        />
        <RecordSummaryCard
          finalsAppearances={overallFinals}
          gameRecord={overallGameRecord}
          matchRecord={overallMatchRecord}
          title="Overall Record"
          tournamentWins={overallTournamentWins}
        />
      </div>

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Recent Match History</h2>
            <p className="muted">
              Shows finalized real player-vs-player matches with final scores. Test, excluded, BYE, replay-required, no-contest, disputed, and unfinalized matches are omitted.
            </p>
          </div>
        </div>

        {recentMatches.length === 0 ? (
          <EmptyState
            message="Finalized eligible matches will appear here after tournament results are confirmed."
            title="No eligible matches yet"
          />
        ) : (
          <div className="match-history-list">
            {recentMatches.map((match) => (
              <article className="match-history-row" key={match.id}>
                <div>
                  <div className="role-list">
                    <TournamentTierBadge tier={match.tournament.tournament_tier} />
                    <MatchStatusBadge tone={match.result === "win" ? "gold" : "muted"}>
                      {match.result === "win" ? "W" : "L"}
                    </MatchStatusBadge>
                    <span className="badge">{matchFormatLabels[match.format]}</span>
                  </div>
                  <h3>
                    <Link href={`/tournaments/${match.tournament_id}`}>{match.tournament.name}</Link>
                  </h3>
                  <p className="muted">
                    {match.roundName} vs{" "}
                    {match.opponentId ? (
                      <Link href={`/players/${match.opponentId}`}>{match.opponentName}</Link>
                    ) : (
                      match.opponentName
                    )}
                  </p>
                </div>
                <div className="match-history-meta">
                  <strong>{match.score}</strong>
                  <span className="muted">{formatDateTime(match.finalized_at ?? match.updated_at)}</span>
                  <Link className="button secondary-button button-link" href={`/matches/${match.id}`}>
                    Match Room
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}

        {missingScoreMatches.length > 0 ? (
          <div className="record-source-note">
            <strong>Final score needed</strong>
            <p className="muted">
              These finalized player-vs-player matches are not counted in W-L or recent match history until source data includes a final score.
            </p>
            <div className="role-list">
              {missingScoreMatches.slice(0, 4).map((match) => (
                <Link className="badge" href={`/matches/${match.id}`} key={match.id}>
                  {match.tournament.name}: {match.roundName} vs {match.opponentName}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Tournament Results</h2>
            <p className="muted">Single-elimination placement labels are derived from finalized bracket rounds.</p>
          </div>
        </div>

        {tournamentResults.length === 0 ? (
          <p className="muted">No eligible tournament results yet.</p>
        ) : (
          <div className="tournament-result-list">
            {tournamentResults.map((result) => (
              <article className="tournament-result-row" key={result.id}>
                <div>
                  <h3>
                    <Link href={`/tournaments/${result.id}`}>{result.name}</Link>
                  </h3>
                  <p className="muted">{formatDateTime(result.startsAt)}</p>
                </div>
                <div className="role-list">
                  <TournamentTierBadge tier={result.tournament.tournament_tier} />
                  <span className="badge">{result.result}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
