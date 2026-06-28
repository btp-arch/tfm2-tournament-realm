import { getBracketSetupWarning, type BracketSize } from "@/lib/brackets";
import {
  areGroupMatchesComplete,
  calculateGroupStandings,
  getPlayoffByeCount,
  getQualifierBlockedReason,
  getSupportedPlayoffBracketSize,
  isGroupBye,
  type GroupWithMembers,
} from "@/lib/group-stage";
import {
  calculatePausedAdjustedDeadline,
  getCheckInDeadline,
  getReplacementDeadline,
} from "@/lib/tournament-timing";
import {
  formatMatchFinalScore,
  type DisputeRow,
  type MatchCheckInRow,
  type MatchEvidenceRow,
  type MatchReportRow,
  type MatchRow,
  type TournamentRegistrationRow,
  type TournamentRoundRow,
  type TournamentRow,
} from "@/lib/tournaments";

export type LiveControlParticipant = {
  checkIn: unknown | null;
  displayName: string;
  isReplacement?: boolean;
  manualSeed: number | null;
  registrationStatus: TournamentRegistrationRow["status"];
  userId: string;
};

export type LiveControlStage = {
  bracket_size: number | null;
  bracket_type: string;
  id: string;
  stage_number: number;
};

export type LiveControlProfile = {
  display_name: string | null;
  id: string;
};

export type MatchAttentionBucketKey =
  | "needsReview"
  | "resultNeeded"
  | "hostSetup"
  | "inGame"
  | "completed"
  | "nonPlayable"
  | "blocked";

export type MatchAttentionItem = {
  bucket: MatchAttentionBucketKey;
  groupName: string | null;
  hostName: string | null;
  id: string;
  label: string;
  players: string;
  score: string | null;
  status: MatchRow["status"];
};

export type MatchAttentionBuckets = Record<MatchAttentionBucketKey, MatchAttentionItem[]>;

export type GroupProgressItem = {
  byeCount: number;
  completedMatches: number;
  forfeitCount: number;
  id: string;
  name: string;
  qualifiedPlayers: string[];
  totalRealMatches: number;
  unresolvedTieCount: number;
};

export type LiveControlSummary = {
  activeMatchCount: number;
  bracketPlayoffStatus: string;
  checkedInCount: number;
  completedMatchCount: number;
  disputeCount: number;
  format: string;
  groupCapacity: number | null;
  groupDrawStatus: string;
  manualSeedCount: number;
  registrationCount: number;
  resultMismatchCount: number;
  status: string;
  tier: string;
  totalCapacity: number | null;
};

export type LiveControlReadiness = {
  allowed: boolean;
  blocker: string | null;
  detail: string;
};

export type LiveControlAction = {
  detail: string;
  label: string;
  target?: "players" | "groups" | "bracket" | "admin";
  tone: "normal" | "attention" | "blocked" | "ready";
};

export type TimerActionKind =
  | "apply_check_in_expiry"
  | "apply_replacement_expiry"
  | "generate_group_draw"
  | "generate_bracket"
  | "apply_group_round_expiry"
  | "apply_bracket_round_expiry";

export type ExpiredTimingAction = {
  blocker: string | null;
  detail: string;
  enabled: boolean;
  kind: TimerActionKind;
  label: string;
};

export type TimingCellState =
  | "waiting"
  | "open"
  | "active"
  | "expired"
  | "complete"
  | "blocked"
  | "empty";

export type GroupTimingCell = {
  deadline: Date | null;
  detail: string;
  groupId: string;
  groupName: string;
  matchCount: number;
  resolvedCount: number;
  roundNumber: number;
  state: TimingCellState;
};

export type GroupTimingWave = {
  blockedGroups: string[];
  complete: boolean;
  deadline: Date | null;
  expired: boolean;
  roundNumber: number;
  started: boolean;
  waitingOnGroups: string[];
};

export type GroupTimingMatrix = {
  cells: GroupTimingCell[];
  groups: GroupWithMembers[];
  roundNumbers: number[];
  waves: GroupTimingWave[];
};

export type BracketTimingRow = {
  deadline: Date | null;
  detail: string;
  matchCount: number;
  resolvedCount: number;
  roundName: string;
  roundNumber: number;
  state: TimingCellState;
};

export type MatchTimeoutOutcomeKind =
  | "already_resolved"
  | "forfeit"
  | "no_contest"
  | "staff_review"
  | "needs_review";

export type MatchTimeoutOutcomeCandidate = {
  checkedInUserIds: string[];
  detail: string;
  kind: MatchTimeoutOutcomeKind;
  matchId: string;
  reportCount: number;
  winnerId: string | null;
};

const inactiveRegistrationStatuses = new Set<TournamentRegistrationRow["status"]>([
  "withdrawn",
  "rejected",
  "missed_check_in",
  "excluded",
]);

const actionableMatchStatuses = new Set<MatchRow["status"]>([
  "assigned",
  "awaiting_guest_join",
  "awaiting_host_setup",
  "check_in_open",
  "in_game",
  "ready_to_setup",
  "result_reported",
  "replay_required",
]);

function isResolvedForTiming(match: MatchRow) {
  return (
    match.status === "finalized" ||
    match.status === "confirmed" ||
    match.status === "forfeit" ||
    match.status === "bye"
  );
}

function isBlockedForTiming(match: MatchRow) {
  return match.status === "disputed" || match.status === "needs_admin";
}

function isEligibleParticipant(participant: LiveControlParticipant) {
  return !inactiveRegistrationStatuses.has(participant.registrationStatus);
}

function isActiveFieldParticipant(participant: LiveControlParticipant) {
  return (
    participant.registrationStatus === "active" ||
    participant.registrationStatus === "replaced" ||
    participant.registrationStatus === "checked_in" ||
    Boolean(participant.checkIn)
  );
}

function getProfileName(
  profiles: Record<string, LiveControlProfile>,
  userId: string | null,
  fallback = "Player",
) {
  if (!userId) {
    return null;
  }

  return profiles[userId]?.display_name ?? fallback;
}

function getMatchPlayers(match: MatchRow, profiles: Record<string, LiveControlProfile>) {
  const playerOne = getProfileName(profiles, match.player_one_id, "TBD") ?? "TBD";
  const playerTwo = getProfileName(profiles, match.player_two_id, "TBD") ?? "TBD";

  return `${playerOne} vs ${playerTwo}`;
}

function getMatchLabel(match: MatchRow, groupsById: Map<string, GroupWithMembers>) {
  const baseLabel = match.match_number
    ? `Match ${match.match_number}`
    : `Round ${match.round_number}, slot ${match.bracket_position ?? "TBD"}`;
  const groupName = match.group_id ? groupsById.get(match.group_id)?.name ?? null : null;

  return groupName ? `${groupName} ${baseLabel}` : `${baseLabel} · Round ${match.round_number}`;
}

export function doLiveMatchReportsMismatch(
  firstReport: MatchReportRow | null | undefined,
  secondReport: MatchReportRow | null | undefined,
) {
  return Boolean(
    firstReport &&
      secondReport &&
      (firstReport.reported_winner_id !== secondReport.reported_winner_id ||
        firstReport.reported_winner_score !== secondReport.reported_winner_score ||
        firstReport.reported_loser_score !== secondReport.reported_loser_score),
  );
}

export function getResultMismatchMatchIds(reports: MatchReportRow[]) {
  const reportsByMatch = reports.reduce<Map<string, MatchReportRow[]>>((byMatch, report) => {
    byMatch.set(report.match_id, [...(byMatch.get(report.match_id) ?? []), report]);
    return byMatch;
  }, new Map());

  return new Set(
    Array.from(reportsByMatch.entries())
      .filter(([, matchReports]) => {
        if (matchReports.length < 2) {
          return false;
        }

        const [firstReport, secondReport] = matchReports;

        return doLiveMatchReportsMismatch(firstReport, secondReport);
      })
      .map(([matchId]) => matchId),
  );
}

export function formatLiveControlBlockerReason(reason: string | null | undefined) {
  return reason ?? "No blockers detected.";
}

export function getManualSeedSummary(participants: LiveControlParticipant[]) {
  const seededParticipants = participants.filter(
    (participant) =>
      isEligibleParticipant(participant) &&
      !participant.isReplacement &&
      participant.manualSeed !== null,
  );
  const seedsByNumber = seededParticipants.reduce<Map<number, LiveControlParticipant[]>>(
    (bySeed, participant) => {
      const seed = participant.manualSeed;

      if (seed !== null) {
        bySeed.set(seed, [...(bySeed.get(seed) ?? []), participant]);
      }

      return bySeed;
    },
    new Map(),
  );
  const duplicateSeeds = Array.from(seedsByNumber.entries())
    .filter(([, seedParticipants]) => seedParticipants.length > 1)
    .map(([seed]) => seed)
    .sort((first, second) => first - second);

  return {
    count: seededParticipants.length,
    duplicateSeeds,
    hasWarnings: duplicateSeeds.length > 0,
  };
}

export function getCheckInExpirySummary(
  tournament: TournamentRow,
  participants: LiveControlParticipant[],
  now = new Date(),
) {
  const deadline = getCheckInDeadline(tournament);
  const eligibleParticipants = participants.filter(
    (participant) =>
      participant.registrationStatus === "pending" ||
      participant.registrationStatus === "accepted" ||
      participant.registrationStatus === "checked_in" ||
      participant.registrationStatus === "active" ||
      participant.registrationStatus === "replaced",
  );
  const checkedInParticipants = eligibleParticipants.filter((participant) => Boolean(participant.checkIn));
  const missedParticipants = eligibleParticipants.filter((participant) => !participant.checkIn);
  const expired = Boolean(
    tournament.status === "check_in" &&
      deadline &&
      !tournament.timers_paused_at &&
      deadline.getTime() <= now.getTime(),
  );

  return {
    checkedInCount: checkedInParticipants.length,
    checkedInParticipants,
    deadline,
    expired,
    missedCount: missedParticipants.length,
    missedParticipants,
    summary: expired
      ? `Check-in expired: ${checkedInParticipants.length} checked in, ${missedParticipants.length} missed check-in.`
      : `Check-in: ${checkedInParticipants.length}/${eligibleParticipants.length} players checked in.`,
  };
}

export function getReplacementWindowSummary(
  tournament: TournamentRow,
  participants: LiveControlParticipant[],
  now = new Date(),
) {
  const deadline = getReplacementDeadline(tournament);
  const checkInDeadline = getCheckInDeadline(tournament);
  const activeParticipants = participants.filter(isActiveFieldParticipant);
  const replacementParticipants = activeParticipants.filter((participant) => participant.isReplacement);
  const capacity =
    tournament.tournament_format === "group_stage_playoff" && tournament.group_size && tournament.groups_count
      ? tournament.group_size * tournament.groups_count
      : tournament.max_players;
  const openSpots = capacity === null ? 0 : Math.max(capacity - activeParticipants.length, 0);
  const checkInExpired = Boolean(checkInDeadline && checkInDeadline.getTime() <= now.getTime());
  const active = Boolean(
    tournament.status === "check_in" &&
      tournament.replacement_window_enabled &&
      !tournament.timers_paused_at &&
      checkInExpired &&
      deadline &&
      deadline.getTime() > now.getTime() &&
      openSpots > 0,
  );
  const expired = Boolean(
    tournament.status === "check_in" &&
      tournament.replacement_window_enabled &&
      !tournament.timers_paused_at &&
      deadline &&
      deadline.getTime() <= now.getTime(),
  );

  return {
    active,
    activeCount: activeParticipants.length,
    capacity,
    deadline,
    expired,
    openSpots,
    replacementCount: replacementParticipants.length,
    summary: active
      ? `Replacement window active: ${openSpots} open spot${openSpots === 1 ? "" : "s"}.`
      : expired
        ? `Replacement expired: ${openSpots} open spot${openSpots === 1 ? "" : "s"} remain.`
        : "Replacement window is not active.",
  };
}

export function getRegistrationCheckInSummary(
  tournament: TournamentRow,
  participants: LiveControlParticipant[],
  selectedBracketSize: BracketSize,
) {
  const registeredParticipants = participants.filter(isEligibleParticipant);
  const checkedInParticipants = registeredParticipants.filter((participant) => Boolean(participant.checkIn));
  const notCheckedInParticipants = registeredParticipants.filter((participant) => !participant.checkIn);
  const groupCapacity =
    tournament.group_size && tournament.groups_count
      ? tournament.group_size * tournament.groups_count
      : null;
  const singleElimByeCount =
    tournament.tournament_format === "single_elimination"
      ? Math.max(selectedBracketSize - checkedInParticipants.length, 0)
      : 0;
  const groupByeCount =
    tournament.tournament_format === "group_stage_playoff" && groupCapacity !== null
      ? Math.max(groupCapacity - checkedInParticipants.length, 0)
      : 0;

  return {
    checkedInCount: checkedInParticipants.length,
    checkedInParticipants,
    groupByeCount,
    groupCapacity,
    notCheckedInParticipants,
    registeredCount: registeredParticipants.length,
    registeredParticipants,
    singleElimByeCount,
  };
}

export function getMatchTimeoutOutcomeCandidate(
  match: MatchRow,
  checkIns: MatchCheckInRow[],
  reports: MatchReportRow[],
): MatchTimeoutOutcomeCandidate {
  const checkedInUserIds = checkIns
    .filter(
      (checkIn) =>
        checkIn.match_id === match.id &&
        (checkIn.user_id === match.player_one_id || checkIn.user_id === match.player_two_id),
    )
    .map((checkIn) => checkIn.user_id);
  const matchReports = reports.filter((report) => report.match_id === match.id);
  const reportCount = matchReports.length;

  if (
    match.status === "finalized" ||
    match.status === "confirmed" ||
    match.status === "disputed" ||
    match.status === "forfeit" ||
    match.status === "bye" ||
    match.result_type === "no_contest"
  ) {
    return {
      checkedInUserIds,
      detail: "Already resolved; no timer action will be applied.",
      kind: "already_resolved",
      matchId: match.id,
      reportCount,
      winnerId: match.winner_id,
    };
  }

  if (reportCount > 0) {
    return {
      checkedInUserIds,
      detail:
        reportCount === 1
          ? "One player submitted a result; staff review is required before awarding a result."
          : "Player reports exist; existing confirmation or dispute handling should resolve this match.",
      kind: "needs_review",
      matchId: match.id,
      reportCount,
      winnerId: null,
    };
  }

  if (checkedInUserIds.length === 1) {
    return {
      checkedInUserIds,
      detail: "One player checked into the room and one did not; forfeit candidate.",
      kind: "forfeit",
      matchId: match.id,
      reportCount,
      winnerId: checkedInUserIds[0] ?? null,
    };
  }

  if (checkedInUserIds.length === 0) {
    return {
      checkedInUserIds,
      detail: "Neither player checked into the room; no-contest candidate.",
      kind: "no_contest",
      matchId: match.id,
      reportCount,
      winnerId: null,
    };
  }

  return {
    checkedInUserIds,
    detail: "Both players checked in but no result was submitted; staff review is required.",
    kind: "staff_review",
    matchId: match.id,
    reportCount,
    winnerId: null,
  };
}

export function formatTimerOutcomeSummary(candidate: MatchTimeoutOutcomeCandidate) {
  if (candidate.kind === "forfeit") {
    return "FF candidate";
  }

  if (candidate.kind === "no_contest") {
    return "No contest candidate";
  }

  if (candidate.kind === "needs_review" || candidate.kind === "staff_review") {
    return "Needs organizer review";
  }

  return "No action";
}

export function shouldCountTimedOutcomeForRecords(
  match: Pick<MatchRow, "result_type" | "status">,
) {
  return match.status === "finalized" && match.result_type === "played";
}

export function getRoundExpirySummary({
  checkIns,
  groups,
  matches,
  phase,
  reports,
  tournament,
}: {
  checkIns: MatchCheckInRow[];
  groups: GroupWithMembers[];
  matches: MatchRow[];
  phase: "group" | "bracket";
  reports: MatchReportRow[];
  tournament: TournamentRow;
}) {
  const deadline =
    phase === "group"
      ? calculatePausedAdjustedDeadline(tournament.current_group_round_deadline, tournament)
      : calculatePausedAdjustedDeadline(tournament.current_bracket_round_deadline, tournament);
  const expired = Boolean(deadline && !tournament.timers_paused_at && deadline.getTime() <= Date.now());
  const scopedMatches = matches.filter((match) =>
    phase === "group" ? Boolean(match.group_id) : !match.group_id,
  );
  const unresolvedScopedMatches = scopedMatches.filter(
    (match) =>
      match.player_one_id &&
      match.player_two_id &&
      match.status !== "finalized" &&
      match.status !== "confirmed" &&
      match.status !== "disputed" &&
      match.status !== "forfeit" &&
      match.status !== "bye",
  );
  const currentRoundNumber = unresolvedScopedMatches.reduce<number | null>(
    (currentRound, match) =>
      currentRound === null ? match.round_number : Math.min(currentRound, match.round_number),
    null,
  );
  const unresolvedMatches = currentRoundNumber === null
    ? []
    : unresolvedScopedMatches.filter((match) => match.round_number === currentRoundNumber);
  const candidates = unresolvedMatches.map((match) =>
    getMatchTimeoutOutcomeCandidate(match, checkIns, reports),
  );
  const groupedCandidates = groups.map((group) => {
    const groupCandidates = candidates.filter((candidate) =>
      scopedMatches.some((match) => match.id === candidate.matchId && match.group_id === group.id),
    );

    return {
      candidates: groupCandidates,
      groupId: group.id,
      groupName: group.name,
      unresolvedCount: groupCandidates.length,
    };
  });

  return {
    candidates,
    deadline,
    expired,
    forfeitCount: candidates.filter((candidate) => candidate.kind === "forfeit").length,
    groupedCandidates,
    needsReviewCount: candidates.filter(
      (candidate) => candidate.kind === "needs_review" || candidate.kind === "staff_review",
    ).length,
    noContestCount: candidates.filter((candidate) => candidate.kind === "no_contest").length,
    phase,
    unresolvedCount: unresolvedMatches.length,
  };
}

export function getReadyGroupRoundMatches(matches: MatchRow[]) {
  return matches.filter(
    (match) =>
      match.group_id &&
      match.player_one_id &&
      match.player_two_id &&
      (match.status === "assigned" || match.status === "check_in_open" || match.status === "ready_to_setup"),
  );
}

export function getReadyBracketMatches(matches: MatchRow[]) {
  return matches.filter(
    (match) =>
      !match.group_id &&
      match.player_one_id &&
      match.player_two_id &&
      (match.status === "assigned" || match.status === "check_in_open" || match.status === "ready_to_setup"),
  );
}

export function applyReadyMatchOpenings(matches: MatchRow[]) {
  return matches.filter(
    (match) =>
      match.player_one_id &&
      match.player_two_id &&
      (match.status === "pending" || match.status === "blocked"),
  );
}

export function getGroupTimingMatrix({
  groups,
  matches,
  rounds,
  tournament,
}: {
  groups: GroupWithMembers[];
  matches: MatchRow[];
  rounds: TournamentRoundRow[];
  tournament: TournamentRow;
}): GroupTimingMatrix {
  const groupMatches = matches.filter((match) => match.group_id);
  const roundNumbers = Array.from(
    new Set([
      ...rounds
        .filter((round) => groupMatches.some((match) => match.round_id === round.id))
        .map((round) => round.round_number),
      ...groupMatches.map((match) => match.round_number),
    ]),
  ).sort((first, second) => first - second);
  const roundByNumber = new Map(
    rounds
      .filter((round) => roundNumbers.includes(round.round_number))
      .map((round) => [round.round_number, round]),
  );
  const cells = groups.flatMap((group) =>
    roundNumbers.map<GroupTimingCell>((roundNumber) => {
      const matchesInCell = groupMatches.filter(
        (match) => match.group_id === group.id && match.round_number === roundNumber,
      );
      const realMatches = matchesInCell.filter((match) => match.player_one_id && match.player_two_id);
      const resolvedCount = realMatches.filter(isResolvedForTiming).length;
      const blocked = realMatches.some(isBlockedForTiming);
      const complete = realMatches.length > 0 && resolvedCount === realMatches.length;
      const open = realMatches.some(
        (match) =>
          match.status === "assigned" ||
          match.status === "check_in_open" ||
          match.status === "awaiting_host_setup" ||
          match.status === "awaiting_guest_join" ||
          match.status === "ready_to_setup" ||
          match.status === "in_game" ||
          match.status === "result_reported" ||
          match.status === "replay_required",
      );
      const round = roundByNumber.get(roundNumber);
      const deadline = round?.deadline_at
        ? calculatePausedAdjustedDeadline(round.deadline_at, tournament)
        : null;
      const expired = Boolean(deadline && !tournament.timers_paused_at && deadline.getTime() <= Date.now());
      const state: TimingCellState =
        realMatches.length === 0
          ? "empty"
          : complete
            ? "complete"
            : blocked
              ? "blocked"
              : expired && open
                ? "expired"
                : deadline && open
                  ? "active"
                  : open
                    ? "open"
                    : "waiting";

      return {
        deadline,
        detail:
          state === "waiting"
            ? "Waiting for this group's prior round."
            : `${resolvedCount}/${realMatches.length} real matches resolved.`,
        groupId: group.id,
        groupName: group.name,
        matchCount: realMatches.length,
        resolvedCount,
        roundNumber,
        state,
      };
    }),
  );
  const waves = roundNumbers.map<GroupTimingWave>((roundNumber) => {
    const round = roundByNumber.get(roundNumber);
    const deadline = round?.deadline_at
      ? calculatePausedAdjustedDeadline(round.deadline_at, tournament)
      : null;
    const waitingOnGroups = groups
      .filter((group) => {
        if (roundNumber === 1) {
          return false;
        }

        const previousMatches = groupMatches.filter(
          (match) => match.group_id === group.id && match.round_number === roundNumber - 1,
        );

        return previousMatches.some((match) => !isResolvedForTiming(match));
      })
      .map((group) => group.name);
    const blockedGroups = groups
      .filter((group) =>
        groupMatches.some(
          (match) =>
            match.group_id === group.id &&
            match.round_number === roundNumber &&
            isBlockedForTiming(match),
        ),
      )
      .map((group) => group.name);

    return {
      blockedGroups,
      complete: cells
        .filter((cell) => cell.roundNumber === roundNumber && cell.matchCount > 0)
        .every((cell) => cell.state === "complete"),
      deadline,
      expired: Boolean(deadline && !tournament.timers_paused_at && deadline.getTime() <= Date.now()),
      roundNumber,
      started: Boolean(round?.timer_started_at),
      waitingOnGroups,
    };
  });

  return {
    cells,
    groups,
    roundNumbers,
    waves,
  };
}

export function getBracketTimingRows({
  matches,
  rounds,
  tournament,
}: {
  matches: MatchRow[];
  rounds: TournamentRoundRow[];
  tournament: TournamentRow;
}): BracketTimingRow[] {
  const bracketMatches = matches.filter((match) => !match.group_id);
  const roundNumbers = Array.from(
    new Set([
      ...rounds
        .filter((round) => bracketMatches.some((match) => match.round_id === round.id))
        .map((round) => round.round_number),
      ...bracketMatches.map((match) => match.round_number),
    ]),
  ).sort((first, second) => first - second);
  const roundByNumber = new Map(rounds.map((round) => [round.round_number, round]));

  return roundNumbers.map<BracketTimingRow>((roundNumber) => {
    const roundMatches = bracketMatches.filter((match) => match.round_number === roundNumber);
    const realMatches = roundMatches.filter((match) => match.player_one_id && match.player_two_id);
    const resolvedCount = realMatches.filter(isResolvedForTiming).length;
    const blocked = realMatches.some(isBlockedForTiming);
    const complete = realMatches.length > 0 && resolvedCount === realMatches.length;
    const open = realMatches.some((match) => match.status !== "pending" && match.status !== "blocked");
    const round = roundByNumber.get(roundNumber);
    const deadline = round?.deadline_at
      ? calculatePausedAdjustedDeadline(round.deadline_at, tournament)
      : null;
    const expired = Boolean(deadline && !tournament.timers_paused_at && deadline.getTime() <= Date.now());
    const state: TimingCellState =
      realMatches.length === 0
        ? "empty"
        : complete
          ? "complete"
          : blocked
            ? "blocked"
            : expired && open
              ? "expired"
              : deadline && open
                ? "active"
                : open
                  ? "open"
                  : "waiting";

    return {
      deadline,
      detail: `${resolvedCount}/${realMatches.length} real matches resolved.`,
      matchCount: realMatches.length,
      resolvedCount,
      roundName: round?.name ?? `Round ${roundNumber}`,
      roundNumber,
      state,
    };
  });
}

export function getTimerActionBlockerReason({
  canManageTournament,
  isPaused,
  isExpired,
}: {
  canManageTournament: boolean;
  isExpired: boolean;
  isPaused: boolean;
}) {
  if (!canManageTournament) {
    return "Only tournament staff can apply expired timing actions.";
  }

  if (isPaused) {
    return "Timers are paused. Resume before applying expired timing actions.";
  }

  if (!isExpired) {
    return "The timer has not expired yet.";
  }

  return null;
}

export function getExpiredTimingActions({
  bracketReadiness,
  canManageTournament,
  checkInSummary,
  groupDrawReadiness,
  hasGeneratedBracket,
  replacementSummary,
  roundSummary,
  tournament,
}: {
  bracketReadiness: LiveControlReadiness | null;
  canManageTournament: boolean;
  checkInSummary: ReturnType<typeof getCheckInExpirySummary> | null;
  groupDrawReadiness: LiveControlReadiness | null;
  hasGeneratedBracket: boolean;
  replacementSummary: ReturnType<typeof getReplacementWindowSummary> | null;
  roundSummary: ReturnType<typeof getRoundExpirySummary> | null;
  tournament: TournamentRow;
}): ExpiredTimingAction[] {
  const actions: ExpiredTimingAction[] = [];
  const paused = Boolean(tournament.timers_paused_at);

  if (checkInSummary?.expired) {
    const blocker = getTimerActionBlockerReason({
      canManageTournament,
      isExpired: checkInSummary.expired,
      isPaused: paused,
    });

    actions.push({
      blocker,
      detail: `${checkInSummary.checkedInCount} checked in; ${checkInSummary.missedCount} will be marked missed check-in and excluded from draw generation.`,
      enabled: blocker === null,
      kind: "apply_check_in_expiry",
      label: "Apply check-in close",
    });
  }

  if (replacementSummary?.expired && !hasGeneratedBracket) {
    const blocker = getTimerActionBlockerReason({
      canManageTournament,
      isExpired: replacementSummary.expired,
      isPaused: paused,
    });

    actions.push({
      blocker,
      detail: `${replacementSummary.activeCount} active players; ${replacementSummary.openSpots} open spot${replacementSummary.openSpots === 1 ? "" : "s"} remain.`,
      enabled: blocker === null,
      kind: "apply_replacement_expiry",
      label: "Apply replacement close",
    });

    if (tournament.tournament_format === "group_stage_playoff") {
      actions.push({
        blocker: groupDrawReadiness?.blocker ?? null,
        detail: groupDrawReadiness?.detail ?? "Generate group draw from active checked-in and replacement players.",
        enabled: Boolean(canManageTournament && groupDrawReadiness?.allowed),
        kind: "generate_group_draw",
        label: "Generate group draw",
      });
    } else {
      actions.push({
        blocker: bracketReadiness?.blocker ?? null,
        detail: bracketReadiness?.detail ?? "Generate bracket from active checked-in and replacement players.",
        enabled: Boolean(canManageTournament && bracketReadiness?.allowed),
        kind: "generate_bracket",
        label: "Generate bracket",
      });
    }
  }

  if (tournament.status === "active" && roundSummary?.expired) {
    const blocker = getTimerActionBlockerReason({
      canManageTournament,
      isExpired: roundSummary.expired,
      isPaused: paused,
    });

    actions.push({
      blocker,
      detail: `${roundSummary.unresolvedCount} unresolved match${roundSummary.unresolvedCount === 1 ? "" : "es"}: ${roundSummary.forfeitCount} FF, ${roundSummary.noContestCount} no contest, ${roundSummary.needsReviewCount} review.`,
      enabled: blocker === null,
      kind: roundSummary.phase === "group" ? "apply_group_round_expiry" : "apply_bracket_round_expiry",
      label: roundSummary.phase === "group" ? "Apply expired group outcomes" : "Apply expired bracket outcomes",
    });
  }

  return actions;
}

export function getGroupDrawReadiness(
  tournament: TournamentRow,
  checkedInCount: number,
  hasGroupDraw: boolean,
) {
  const groupCapacity =
    tournament.group_size && tournament.groups_count
      ? tournament.group_size * tournament.groups_count
      : 0;
  let blocker: string | null = null;

  if (tournament.tournament_format !== "group_stage_playoff") {
    blocker = "This tournament does not use a group draw.";
  } else if (hasGroupDraw) {
    blocker = "Group draw has already been generated.";
  } else if (tournament.status !== "check_in") {
    blocker = "Open check-in before generating the group draw.";
  } else if (!tournament.group_size || !tournament.groups_count || !tournament.group_stage_format) {
    blocker = "Group-stage settings are incomplete.";
  } else if (checkedInCount < 2) {
    blocker = "At least 2 checked-in players are required to start.";
  } else if (checkedInCount > groupCapacity) {
    blocker = `Group draw can hold ${groupCapacity} checked-in players.`;
  }

  return {
    allowed: blocker === null,
    blocker,
    detail:
      groupCapacity > 0
        ? `${checkedInCount} checked in for ${groupCapacity} group slots; ${Math.max(
            groupCapacity - checkedInCount,
            0,
          )} BYE/off-slot${Math.max(groupCapacity - checkedInCount, 0) === 1 ? "" : "s"}.`
        : "Group capacity is not configured.",
  };
}

export function getBracketReadiness(
  tournament: TournamentRow,
  checkedInCount: number,
  selectedBracketSize: BracketSize,
  hasGeneratedBracket: boolean,
) {
  let blocker: string | null = null;

  if (tournament.tournament_format !== "single_elimination") {
    blocker = "This tournament uses a group draw before playoffs.";
  } else if (hasGeneratedBracket) {
    blocker = "Bracket has already been generated.";
  } else if (tournament.status !== "check_in") {
    blocker = "Open check-in before generating the bracket.";
  } else {
    blocker = getBracketSetupWarning(checkedInCount, selectedBracketSize);
    if (checkedInCount >= 2 && checkedInCount <= selectedBracketSize) {
      blocker = null;
    }
  }

  return {
    allowed: blocker === null,
    blocker,
    detail: `${checkedInCount} checked in for a ${selectedBracketSize}-player bracket; ${Math.max(
      selectedBracketSize - checkedInCount,
      0,
    )} BYE${Math.max(selectedBracketSize - checkedInCount, 0) === 1 ? "" : "s"}.`,
  };
}

export function getGroupStageProgress(
  groups: GroupWithMembers[],
  matches: MatchRow[],
  tournament: Pick<TournamentRow, "qualifiers_per_group">,
  profiles: Record<string, LiveControlProfile>,
) {
  const qualifiersPerGroup = tournament.qualifiers_per_group ?? 0;

  return groups.map<GroupProgressItem>((group) => {
    const groupMatches = matches.filter((match) => match.group_id === group.id);
    const realMatches = groupMatches.filter((match) => match.player_one_id && match.player_two_id);
    const standings = calculateGroupStandings(group, matches, qualifiersPerGroup);
    const qualifiedPlayers = standings
      .filter((standing) => standing.status === "qualified")
      .slice(0, qualifiersPerGroup)
      .map((standing) => getProfileName(profiles, standing.userId) ?? "Player");

    return {
      byeCount: group.members.filter(isGroupBye).length,
      completedMatches: realMatches.filter((match) => match.status === "finalized").length,
      forfeitCount: realMatches.filter((match) => match.result_type === "forfeit").length,
      id: group.id,
      name: group.name,
      qualifiedPlayers,
      totalRealMatches: realMatches.length,
      unresolvedTieCount: standings.filter((standing) => standing.needsTiebreaker).length,
    };
  });
}

export function getMatchAttentionBuckets(
  matches: MatchRow[],
  groups: GroupWithMembers[],
  profiles: Record<string, LiveControlProfile>,
  mismatchMatchIds: Set<string>,
) {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const buckets: MatchAttentionBuckets = {
    blocked: [],
    completed: [],
    hostSetup: [],
    inGame: [],
    needsReview: [],
    nonPlayable: [],
    resultNeeded: [],
  };

  for (const match of matches) {
    const bucket: MatchAttentionBucketKey =
      match.status === "disputed" || match.status === "needs_admin" || mismatchMatchIds.has(match.id)
        ? "needsReview"
        : match.status === "awaiting_host_setup" || match.status === "ready_to_setup"
          ? "hostSetup"
          : match.status === "in_game" || match.status === "result_reported"
            ? "inGame"
            : match.status === "assigned" || match.status === "check_in_open" || match.status === "replay_required"
              ? "resultNeeded"
              : match.status === "finalized" || match.status === "confirmed"
                ? "completed"
                : match.status === "bye" || match.status === "forfeit" || (!match.player_one_id || !match.player_two_id)
                  ? "nonPlayable"
                  : "blocked";

    buckets[bucket].push({
      bucket,
      groupName: match.group_id ? groupsById.get(match.group_id)?.name ?? null : null,
      hostName: getProfileName(profiles, match.host_user_id),
      id: match.id,
      label: getMatchLabel(match, groupsById),
      players: getMatchPlayers(match, profiles),
      score: formatMatchFinalScore(match),
      status: match.status,
    });
  }

  return buckets;
}

export function getDisputeSummary(
  disputes: DisputeRow[],
  reports: MatchReportRow[],
  evidence: MatchEvidenceRow[],
) {
  const openDisputes = disputes.filter(
    (dispute) => dispute.status === "open" || dispute.status === "under_review",
  );
  const mismatchMatchIds = getResultMismatchMatchIds(reports);

  return {
    evidenceCount: evidence.length,
    mismatchMatchIds,
    openDisputes,
    openDisputeCount: openDisputes.length,
    resultMismatchCount: mismatchMatchIds.size,
  };
}

export function getTournamentCompletionReadiness(
  tournament: TournamentRow,
  matches: MatchRow[],
  playoffMatches: MatchRow[],
  profiles: Record<string, LiveControlProfile>,
) {
  const completionMatches = playoffMatches.length > 0 ? playoffMatches : matches;
  const finalMatch = completionMatches
    .slice()
    .sort((first, second) => second.round_number - first.round_number)
    .find((match) => match.player_one_id || match.player_two_id) ?? null;
  const incompleteMatches = completionMatches.filter(
    (match) =>
      match.player_one_id &&
      match.player_two_id &&
      match.status !== "finalized" &&
      match.status !== "confirmed",
  );
  const championName = finalMatch?.winner_id
    ? getProfileName(profiles, finalMatch.winner_id)
    : null;
  const blockers: string[] = [];

  if (!finalMatch) {
    blockers.push("No final match exists yet.");
  } else if (!finalMatch.winner_id) {
    blockers.push("Final match does not have a winner yet.");
  }

  if (incompleteMatches.length > 0) {
    blockers.push(`${incompleteMatches.length} real match${incompleteMatches.length === 1 ? "" : "es"} still need final results.`);
  }

  if (tournament.status === "completed") {
    blockers.length = 0;
  }

  return {
    blockers,
    championName,
    finalMatch,
    ready: blockers.length === 0 && tournament.status !== "completed",
  };
}

export function getTournamentLiveSummary({
  disputes,
  hasGroupDraw,
  hasPlayoffBracket,
  matches,
  participants,
  reports,
  selectedBracketSize,
  tournament,
}: {
  disputes: DisputeRow[];
  hasGroupDraw: boolean;
  hasPlayoffBracket: boolean;
  matches: MatchRow[];
  participants: LiveControlParticipant[];
  reports: MatchReportRow[];
  selectedBracketSize: BracketSize;
  tournament: TournamentRow;
}): LiveControlSummary {
  const registrationSummary = getRegistrationCheckInSummary(
    tournament,
    participants,
    selectedBracketSize,
  );
  const disputeSummary = getDisputeSummary(disputes, reports, []);
  const manualSeedSummary = getManualSeedSummary(participants);

  return {
    activeMatchCount: matches.filter((match) => actionableMatchStatuses.has(match.status)).length,
    bracketPlayoffStatus:
      tournament.tournament_format === "group_stage_playoff"
        ? hasPlayoffBracket
          ? "Playoff generated"
          : "Playoff pending"
        : matches.length > 0
          ? "Bracket generated"
          : "Bracket pending",
    checkedInCount: registrationSummary.checkedInCount,
    completedMatchCount: matches.filter((match) => match.status === "finalized" || match.status === "confirmed").length,
    disputeCount: disputeSummary.openDisputeCount,
    format: tournament.tournament_format,
    groupCapacity: registrationSummary.groupCapacity,
    groupDrawStatus:
      tournament.tournament_format === "group_stage_playoff"
        ? hasGroupDraw
          ? "Generated"
          : "Not generated"
        : "Not used",
    manualSeedCount: manualSeedSummary.count,
    registrationCount: registrationSummary.registeredCount,
    resultMismatchCount: disputeSummary.resultMismatchCount,
    status: tournament.status,
    tier: tournament.tournament_tier,
    totalCapacity:
      tournament.tournament_format === "group_stage_playoff"
        ? registrationSummary.groupCapacity
        : tournament.max_players ?? selectedBracketSize,
  };
}

export function getTournamentNextAction({
  bracketReadiness,
  completionReadiness,
  disputeSummary,
  groupDrawReadiness,
  groupStageMatches,
  groups,
  hasGeneratedBracket,
  hasGroupDraw,
  hasPlayoffBracket,
  matches,
  playoffBlockedReason,
  playoffMatches,
  registrationSummary,
  tournament,
}: {
  bracketReadiness: LiveControlReadiness;
  completionReadiness: ReturnType<typeof getTournamentCompletionReadiness>;
  disputeSummary: ReturnType<typeof getDisputeSummary>;
  groupDrawReadiness: LiveControlReadiness;
  groupStageMatches: MatchRow[];
  groups: GroupWithMembers[];
  hasGeneratedBracket: boolean;
  hasGroupDraw: boolean;
  hasPlayoffBracket: boolean;
  matches: MatchRow[];
  playoffBlockedReason: string | null;
  playoffMatches: MatchRow[];
  registrationSummary: ReturnType<typeof getRegistrationCheckInSummary>;
  tournament: TournamentRow;
}): LiveControlAction {
  if (disputeSummary.openDisputeCount > 0) {
    return {
      detail: `${disputeSummary.openDisputeCount} dispute${disputeSummary.openDisputeCount === 1 ? "" : "s"} need organizer review.`,
      label: "Dispute needs organizer review.",
      target: "admin",
      tone: "attention",
    };
  }

  if (disputeSummary.resultMismatchCount > 0) {
    return {
      detail: `${disputeSummary.resultMismatchCount} match${disputeSummary.resultMismatchCount === 1 ? "" : "es"} have mismatched player reports.`,
      label: "Result mismatch needs player confirmation or staff review.",
      target: "admin",
      tone: "attention",
    };
  }

  if (tournament.status === "registration_open") {
    return {
      detail: `${registrationSummary.registeredCount} registered so far.`,
      label: "Registration is open. No action required.",
      target: "players",
      tone: "normal",
    };
  }

  if (tournament.status === "registration_closed") {
    return {
      detail: "Players cannot check in until staff opens check-in.",
      label: "Registration is closed. Open check-in when ready.",
      target: "admin",
      tone: "ready",
    };
  }

  if (tournament.status === "check_in") {
    if (tournament.tournament_format === "group_stage_playoff" && groupDrawReadiness.allowed) {
      return {
        detail: groupDrawReadiness.detail,
        label: "Ready to generate group draw.",
        target: "admin",
        tone: "ready",
      };
    }

    if (tournament.tournament_format === "single_elimination" && bracketReadiness.allowed) {
      return {
        detail: bracketReadiness.detail,
        label: "Ready to generate bracket.",
        target: "admin",
        tone: "ready",
      };
    }

    return {
      detail: `${registrationSummary.checkedInCount}/${registrationSummary.registeredCount} players checked in.`,
      label: `Check-in is open. ${registrationSummary.checkedInCount}/${registrationSummary.registeredCount} players checked in.`,
      target: "players",
      tone: "normal",
    };
  }

  if (tournament.status === "active") {
    if (tournament.tournament_format === "group_stage_playoff" && hasGroupDraw && !hasPlayoffBracket) {
      const incompleteGroupMatches = groupStageMatches.filter((match) => match.status !== "finalized");

      if (!playoffBlockedReason && areGroupMatchesComplete(groups, matches)) {
        return {
          detail: "Qualifiers are resolved. The playoff bracket should generate automatically; refresh if it has not appeared.",
          label: "All group matches completed. Generate playoff bracket.",
          target: "groups",
          tone: "ready",
        };
      }

      return {
        detail: playoffBlockedReason ?? `${incompleteGroupMatches.length} group matches need results.`,
        label: `Group stage in progress. ${incompleteGroupMatches.length} matches need results.`,
        target: "groups",
        tone: "normal",
      };
    }

    const activeBracketMatches = (playoffMatches.length > 0 ? playoffMatches : matches).filter(
      (match) => match.player_one_id && match.player_two_id && match.status !== "finalized" && match.status !== "confirmed",
    );

    if (completionReadiness.ready) {
      return {
        detail: completionReadiness.championName
          ? `${completionReadiness.championName} is the final winner.`
          : "Final match is complete.",
        label: "Final completed. Mark tournament complete.",
        target: "admin",
        tone: "ready",
      };
    }

    return {
      detail: formatLiveControlBlockerReason(completionReadiness.blockers[0]),
      label: `Playoff bracket in progress. ${activeBracketMatches.length} matches need results.`,
      target: "bracket",
      tone: "normal",
    };
  }

  if (tournament.status === "completed") {
    return {
      detail: "No live-event action is recommended.",
      label: "Tournament is complete.",
      tone: "normal",
    };
  }

  return {
    detail: hasGeneratedBracket ? "Review active matches and reports." : "Move the tournament into the normal event flow.",
    label: "No urgent action.",
    target: hasGeneratedBracket ? "bracket" : "admin",
    tone: "normal",
  };
}

export function getPlayoffReadiness(
  groups: GroupWithMembers[],
  matches: MatchRow[],
  tournament: TournamentRow,
  hasPlayoffBracket: boolean,
) {
  const totalQualifiers = (tournament.groups_count ?? 0) * (tournament.qualifiers_per_group ?? 0);
  const bracketSize = getSupportedPlayoffBracketSize(totalQualifiers);
  const blocker = hasPlayoffBracket
    ? null
    : getQualifierBlockedReason(groups, matches, tournament);

  return {
    bracketSize,
    byeCount: getPlayoffByeCount(totalQualifiers),
    ready: !hasPlayoffBracket && blocker === null && groups.length > 0,
    blocker,
    totalQualifiers,
  };
}
