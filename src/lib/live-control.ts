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
import { formatMatchFinalScore, type DisputeRow, type MatchEvidenceRow, type MatchReportRow, type MatchRow, type TournamentRow } from "@/lib/tournaments";

export type LiveControlParticipant = {
  checkIn: unknown | null;
  displayName: string;
  manualSeed: number | null;
  registrationStatus: string;
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

function isEligibleParticipant(participant: LiveControlParticipant) {
  return participant.registrationStatus !== "withdrawn" && participant.registrationStatus !== "rejected";
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
    (participant) => isEligibleParticipant(participant) && participant.manualSeed !== null,
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
