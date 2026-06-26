import {
  formatDateTime,
  matchSideLabels,
  type MatchCheckInRow,
  type MatchEventRow,
  type MatchReportRow,
  type MatchRow,
} from "@/lib/tournaments";
import type { Json } from "@/types/database.generated";

export type PublicProfile = {
  id: string;
  display_name: string | null;
};

export function getProfileName(
  profiles: Record<string, PublicProfile>,
  userId: string | null,
) {
  if (!userId) {
    return null;
  }

  return profiles[userId]?.display_name ?? "Player";
}

export function getMatchLabel(match: MatchRow) {
  return `Match ${match.match_number ?? match.bracket_position ?? match.id.slice(0, 8)}`;
}

export function isMatchBye(match: MatchRow) {
  return match.status === "bye";
}

export function isMatchWaiting(match: MatchRow) {
  return match.status === "pending" || !match.player_one_id || !match.player_two_id;
}

export function isPlayableMatch(match: MatchRow) {
  return Boolean(
    match.player_one_id &&
      match.player_two_id &&
      match.status !== "bye" &&
      match.status !== "pending",
  );
}

export function getMatchSlotFallback(match: MatchRow, slot: "one" | "two"): "BYE" | "TBD" {
  const slotPlayerId = slot === "one" ? match.player_one_id : match.player_two_id;

  if (slotPlayerId) {
    return "TBD";
  }

  if (match.status === "bye" || match.winner_id) {
    return "BYE";
  }

  return "TBD";
}

export function getNonPlayableMatchMessage(
  match: MatchRow,
  profiles: Record<string, PublicProfile>,
) {
  if (isPlayableMatch(match)) {
    return null;
  }

  if (!match.player_one_id && !match.player_two_id) {
    return match.status === "bye"
      ? "No match required."
      : "Waiting for previous round winners.";
  }

  const advancingPlayer =
    getProfileName(profiles, match.winner_id) ??
    getProfileName(profiles, match.player_one_id) ??
    getProfileName(profiles, match.player_two_id);

  if (advancingPlayer) {
    return `${advancingPlayer} advances by BYE.`;
  }

  return "No match required.";
}

export function getOpponentId(match: MatchRow, userId: string | null) {
  if (!userId) {
    return null;
  }

  if (match.player_one_id === userId) {
    return match.player_two_id;
  }

  if (match.player_two_id === userId) {
    return match.player_one_id;
  }

  return null;
}

export function getGuestId(match: MatchRow) {
  if (!match.host_user_id) {
    return null;
  }

  if (match.host_user_id === match.player_one_id) {
    return match.player_two_id;
  }

  if (match.host_user_id === match.player_two_id) {
    return match.player_one_id;
  }

  return null;
}

export function getReportedWinnerName(
  report: MatchReportRow | null,
  profiles: Record<string, PublicProfile>,
) {
  return report ? getProfileName(profiles, report.reported_winner_id) : null;
}

export function getReportConfirmationLabel(report: MatchReportRow | null) {
  if (!report) {
    return "No report";
  }

  return report.confirmation_state === "confirmed_current" ? "Confirmed" : "Not confirmed";
}

export function getCurrentStepLabel({
  match,
  userId,
  isParticipant,
  ownCheckIn,
  opponentCheckIn,
  ownReport,
  bothReportsSubmitted,
  reportsMismatch,
  reviewOpen,
}: {
  match: MatchRow;
  userId: string | null;
  isParticipant: boolean;
  ownCheckIn: MatchCheckInRow | null;
  opponentCheckIn: MatchCheckInRow | null;
  ownReport: MatchReportRow | null;
  bothReportsSubmitted: boolean;
  reportsMismatch: boolean;
  reviewOpen: boolean;
}) {
  if (match.status === "finalized" || match.status === "confirmed") {
    return "Result confirmed";
  }

  if (reviewOpen || match.status === "disputed" || match.status === "needs_admin") {
    return "Organizer review required";
  }

  if (reportsMismatch) {
    return "Reports do not match";
  }

  if (ownReport && !bothReportsSubmitted) {
    return "Waiting for opponent report";
  }

  if (match.status === "in_game") {
    return isParticipant && !ownReport ? "Report who won" : "Match in progress";
  }

  if (match.status === "result_reported") {
    return isParticipant && !ownReport ? "Report who won" : "Waiting for opponent report";
  }

  if (match.status === "replay_required") {
    return "Organizer review required";
  }

  if (isMatchBye(match) || isMatchWaiting(match)) {
    return "Waiting for player check-in";
  }

  if (isParticipant && !ownCheckIn) {
    return "Waiting for player check-in";
  }

  if (isParticipant && ownCheckIn && !opponentCheckIn && !match.host_user_id) {
    return "Waiting for opponent check-in";
  }

  if (match.host_user_id && !match.game_created_at) {
    return userId === match.host_user_id ? "You are host: create lobby" : "Waiting for host to create lobby";
  }

  return "Waiting for player check-in";
}

function getMetadataValue(metadata: Json, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const value = metadata[key];

  return typeof value === "string" ? value : null;
}

export function describeEvent(
  event: MatchEventRow,
  profiles: Record<string, PublicProfile>,
) {
  const actor = getProfileName(profiles, event.actor_id) ?? "System";

  if (event.event_type === "check_in") {
    return `${actor} checked in.`;
  }

  if (event.event_type === "host_assigned") {
    const hostName = getProfileName(profiles, getMetadataValue(event.metadata, "host_user_id"));
    const assignment = getMetadataValue(event.metadata, "assignment");

    return `${hostName ?? "Host"} assigned${assignment ? ` by ${assignment}` : ""}.`;
  }

  if (event.event_type === "host_setup") {
    return `${actor} marked the match created.`;
  }

  if (event.event_type === "guest_joined") {
    return `${actor} marked the guest joined.`;
  }

  if (event.event_type === "game_started") {
    return "Match moved to in game.";
  }

  if (event.event_type === "result_reported") {
    const winnerName = getProfileName(profiles, getMetadataValue(event.metadata, "winner_id"));

    return `${actor} reported ${winnerName ?? "a player"} as winner.`;
  }

  if (event.event_type === "confirmed") {
    const winnerName = getProfileName(profiles, getMetadataValue(event.metadata, "winner_id"));

    return `Result confirmed${winnerName ? `: ${winnerName} won` : ""}.`;
  }

  if (event.event_type === "disputed") {
    return "Result reports were disputed.";
  }

  if (event.event_type === "resolved") {
    const resolutionAction = getMetadataValue(event.metadata, "resolution_action");

    return resolutionAction
      ? `${actor} resolved review: ${resolutionAction.replaceAll("_", " ")}.`
      : `${actor} resolved review.`;
  }

  if (event.event_type === "status_changed") {
    const status = getMetadataValue(event.metadata, "status");

    return status ? `Status changed to ${status.replaceAll("_", " ")}.` : "Status changed.";
  }

  if (event.event_type === "note") {
    const action = getMetadataValue(event.metadata, "action");
    const side = getMetadataValue(event.metadata, "host_side");

    if (action === "host_side_chosen" && (side === "red" || side === "blue")) {
      return `${actor} set host side to ${matchSideLabels[side]}.`;
    }
  }

  return `${actor}: ${event.event_type.replaceAll("_", " ")}.`;
}

export function getActionMessage(
  match: MatchRow,
  userId: string | null,
  isParticipant: boolean,
  canManageMatch: boolean,
  ownCheckIn: MatchCheckInRow | null,
  opponentCheckIn: MatchCheckInRow | null,
) {
  if (isMatchBye(match)) {
    return "This match is a BYE. No match-room check-in is required.";
  }

  if (isMatchWaiting(match)) {
    return "This match is waiting for a prior round winner.";
  }

  if (!userId) {
    return "Sign in to perform match-room actions.";
  }

  if (!isParticipant && !canManageMatch) {
    return "You are not in this match.";
  }

  if (isParticipant && ownCheckIn && !opponentCheckIn && !match.host_user_id) {
    return "Waiting for opponent check-in.";
  }

  if (match.host_user_id && !match.game_created_at) {
    return "Waiting for host to create the public friendly game.";
  }

  if (match.status === "in_game") {
    return "Match is in game. Both players should report the winner after the game ends.";
  }

  if (match.status === "result_reported") {
    return "Waiting for player agreement or mismatch confirmation.";
  }

  if (match.status === "disputed" || match.status === "needs_admin") {
    return "Organizer review is required before the bracket can continue.";
  }

  if (match.status === "replay_required") {
    return "Tournament staff required a replay for this match.";
  }

  if (match.status === "finalized" || match.status === "confirmed") {
    return "Result confirmed. Winner advancement has been processed.";
  }

  return "Players should check in, then the host creates the public friendly game.";
}

export function describeCheckInStatus(
  playerId: string | null,
  checkIn: MatchCheckInRow | null,
  match: MatchRow,
  userId: string | null,
  canManageMatch: boolean,
) {
  if (!playerId) {
    return "Not assigned";
  }

  if (checkIn) {
    return formatDateTime(checkIn.checked_in_at);
  }

  if (canManageMatch || userId === playerId) {
    return "Missing";
  }

  if (match.host_user_id) {
    return "Checked in";
  }

  return "Waiting or hidden";
}
