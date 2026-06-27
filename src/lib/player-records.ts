import type { MatchRow, TournamentRow } from "@/lib/tournaments";

export type PlayerRecordResult = "win" | "loss";

export type RecordableTournament = Pick<
  TournamentRow,
  "exclude_from_stats" | "tournament_tier"
>;

export type RecordableMatch = Pick<
  MatchRow,
  | "final_loser_score"
  | "final_winner_score"
  | "player_one_id"
  | "player_two_id"
  | "result_type"
  | "status"
  | "winner_id"
>;

export type PlayerRecordSource = {
  match: RecordableMatch;
  tournament: RecordableTournament;
};

export type MatchRecordSummary = {
  losses: number;
  matchesPlayed: number;
  winRate: number;
  wins: number;
};

export type GameRecordSummary = {
  gameLosses: number;
  gameWins: number;
};

function hasFinalPlayerMatchResult(match: RecordableMatch) {
  return Boolean(
    match.status === "finalized" &&
      match.result_type === "played" &&
      match.player_one_id &&
      match.player_two_id &&
      match.player_one_id !== match.player_two_id &&
      match.winner_id &&
      (match.winner_id === match.player_one_id || match.winner_id === match.player_two_id) &&
      match.final_winner_score !== null &&
      match.final_loser_score !== null,
  );
}

export function countsTowardOfficialRecord(
  tournament: RecordableTournament,
  match?: RecordableMatch,
) {
  const tournamentCounts =
    !tournament.exclude_from_stats &&
    (tournament.tournament_tier === "official" ||
      tournament.tournament_tier === "championship");

  return tournamentCounts && (!match || hasFinalPlayerMatchResult(match));
}

export function countsTowardOverallRecord(
  tournament: RecordableTournament,
  match?: RecordableMatch,
) {
  const tournamentCounts =
    !tournament.exclude_from_stats &&
    (tournament.tournament_tier === "community" ||
      tournament.tournament_tier === "official" ||
      tournament.tournament_tier === "championship");

  return tournamentCounts && (!match || hasFinalPlayerMatchResult(match));
}

export function countsTowardPlayerRecord(
  tournament: RecordableTournament,
  match: RecordableMatch,
) {
  return countsTowardOverallRecord(tournament, match);
}

export function getOpponentForMatch(match: RecordableMatch, playerId: string) {
  if (match.player_one_id === playerId) {
    return match.player_two_id;
  }

  if (match.player_two_id === playerId) {
    return match.player_one_id;
  }

  return null;
}

export function getPlayerMatchResult(
  match: RecordableMatch,
  playerId: string,
): PlayerRecordResult | null {
  if (!hasFinalPlayerMatchResult(match) || !getOpponentForMatch(match, playerId)) {
    return null;
  }

  return match.winner_id === playerId ? "win" : "loss";
}

export function formatMatchScore(match: RecordableMatch, playerId?: string) {
  if (match.final_winner_score === null || match.final_loser_score === null) {
    return null;
  }

  if (!playerId || match.winner_id === playerId) {
    return `${match.final_winner_score}-${match.final_loser_score}`;
  }

  return `${match.final_loser_score}-${match.final_winner_score}`;
}

export function calculatePlayerRecord(
  sources: PlayerRecordSource[],
  playerId: string,
  countsToward: (tournament: RecordableTournament, match: RecordableMatch) => boolean,
): MatchRecordSummary {
  const summary = sources.reduce(
    (record, source) => {
      if (!countsToward(source.tournament, source.match)) {
        return record;
      }

      const result = getPlayerMatchResult(source.match, playerId);

      if (result === "win") {
        record.wins += 1;
        record.matchesPlayed += 1;
      } else if (result === "loss") {
        record.losses += 1;
        record.matchesPlayed += 1;
      }

      return record;
    },
    { losses: 0, matchesPlayed: 0, winRate: 0, wins: 0 },
  );

  return {
    ...summary,
    winRate: summary.matchesPlayed > 0 ? summary.wins / summary.matchesPlayed : 0,
  };
}

export function calculateGameRecord(
  sources: PlayerRecordSource[],
  playerId: string,
  countsToward: (tournament: RecordableTournament, match: RecordableMatch) => boolean,
): GameRecordSummary {
  return sources.reduce(
    (record, source) => {
      if (!countsToward(source.tournament, source.match)) {
        return record;
      }

      const result = getPlayerMatchResult(source.match, playerId);

      if (!result || source.match.final_winner_score === null || source.match.final_loser_score === null) {
        return record;
      }

      if (result === "win") {
        record.gameWins += source.match.final_winner_score;
        record.gameLosses += source.match.final_loser_score;
      } else {
        record.gameWins += source.match.final_loser_score;
        record.gameLosses += source.match.final_winner_score;
      }

      return record;
    },
    { gameLosses: 0, gameWins: 0 },
  );
}
