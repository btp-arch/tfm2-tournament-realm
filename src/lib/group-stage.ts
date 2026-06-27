import { getSeedOrder, type BracketSize } from "@/lib/brackets";
import type {
  MatchRow,
  TournamentGroupMemberRow,
  TournamentGroupRow,
  TournamentRow,
} from "@/lib/tournaments";

export type GroupStanding = {
  drawSeed: number;
  forfeitLosses: number;
  forfeitWins: number;
  gameDiff: number;
  gameLosses: number;
  gameWins: number;
  isManualQualifier: boolean;
  matchLosses: number;
  matchWins: number;
  needsTiebreaker: boolean;
  qualifierSeed: number | null;
  rank: number;
  status: "qualified" | "tiebreaker" | "eliminated";
  userId: string;
};

export type GroupWithMembers = TournamentGroupRow & {
  members: TournamentGroupMemberRow[];
};

export type QualifiedPlayer = {
  drawSeed: number;
  forfeitLosses: number;
  gameDiff: number;
  gameWins: number;
  groupId: string;
  groupName: string;
  groupNumber: number;
  matchWins: number;
  placement: number;
  playoffSeed?: number;
  userId: string;
};

export type GroupStageFormatInput = {
  groupSize: number;
  groupsCount: number;
  maxPlayers?: number;
  qualifiersPerGroup: number;
};

export const supportedPlayoffBracketSizes = [4, 8, 16, 32, 64] as const;

export function getGroupLabel(groupNumber: number) {
  const alphabetIndex = groupNumber - 1;

  if (alphabetIndex >= 0 && alphabetIndex < 26) {
    return `Group ${String.fromCharCode(65 + alphabetIndex)}`;
  }

  return `Group ${groupNumber}`;
}

export function getSupportedPlayoffBracketSize(qualifierCount: number): BracketSize | null {
  return supportedPlayoffBracketSizes.find((size) => qualifierCount <= size) ?? null;
}

export function getPlayoffByeCount(qualifierCount: number) {
  const bracketSize = getSupportedPlayoffBracketSize(qualifierCount);

  return bracketSize ? bracketSize - qualifierCount : 0;
}

export function validateGroupStageFormat({
  groupSize,
  groupsCount,
  maxPlayers,
  qualifiersPerGroup,
}: GroupStageFormatInput) {
  const totalGroupSlots = groupSize * groupsCount;
  const totalQualifiers = groupsCount * qualifiersPerGroup;
  const bracketSize = getSupportedPlayoffBracketSize(totalQualifiers);

  if (![4, 8].includes(groupSize)) {
    return "Group stage tournaments support groups of 4 or 8 players.";
  }

  if (!Number.isInteger(groupsCount) || groupsCount < 1) {
    return "Number of groups must be at least 1.";
  }

  if (![1, 2, 3, 4].includes(qualifiersPerGroup)) {
    return "Qualifiers per group must be top 1, top 2, top 3, or top 4.";
  }

  if (qualifiersPerGroup > groupSize) {
    return "Qualifiers per group cannot exceed group size.";
  }

  if (!bracketSize || totalQualifiers < 2) {
    return "Total qualifiers must map to a 4, 8, 16, 32, or 64 player playoff bracket.";
  }

  if (maxPlayers !== undefined) {
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2) {
      return "Max participants must be at least 2.";
    }

    if (maxPlayers > totalGroupSlots) {
      return "Max participants cannot exceed group size multiplied by number of groups.";
    }
  }

  return null;
}

export function getGroupStageFormatSummary({
  groupsCount,
  qualifiersPerGroup,
}: Pick<GroupStageFormatInput, "groupsCount" | "qualifiersPerGroup">) {
  const totalQualifiers = groupsCount * qualifiersPerGroup;
  const bracketSize = getSupportedPlayoffBracketSize(totalQualifiers);
  const byeCount = getPlayoffByeCount(totalQualifiers);

  if (!bracketSize) {
    return `${groupsCount} groups × top ${qualifiersPerGroup} = ${totalQualifiers} qualifiers`;
  }

  return `${groupsCount} groups × top ${qualifiersPerGroup} = ${totalQualifiers} qualifiers → ${bracketSize}-player playoff${
    byeCount > 0 ? ` with ${byeCount} BYE${byeCount === 1 ? "" : "s"}` : ""
  }`;
}

export function isGroupBye(member: TournamentGroupMemberRow) {
  return member.is_bye || member.user_id === null;
}

export function isForfeitResult(match: MatchRow) {
  return match.result_type === "forfeit";
}

function getMatchPlayerScore(match: MatchRow, userId: string) {
  if (match.result_type !== "played" || match.final_winner_score === null || match.final_loser_score === null) {
    return { losses: 0, wins: 0 };
  }

  if (match.winner_id === userId) {
    return { losses: match.final_loser_score, wins: match.final_winner_score };
  }

  return { losses: match.final_winner_score, wins: match.final_loser_score };
}

function getHeadToHeadWinner(matches: MatchRow[], firstUserId: string, secondUserId: string) {
  const headToHeadMatch = matches.find(
    (match) =>
      match.status === "finalized" &&
      match.winner_id &&
      ((match.player_one_id === firstUserId && match.player_two_id === secondUserId) ||
        (match.player_one_id === secondUserId && match.player_two_id === firstUserId)),
  );

  return headToHeadMatch?.winner_id ?? null;
}

function hasSamePrimaryStanding(first: GroupStanding, second: GroupStanding) {
  return (
    first.matchWins === second.matchWins &&
    first.gameDiff === second.gameDiff &&
    first.gameWins === second.gameWins
  );
}

export function calculateGroupStandings(
  group: GroupWithMembers,
  matches: MatchRow[],
  qualifiersPerGroup: number,
): GroupStanding[] {
  const groupMatches = matches.filter((match) => match.group_id === group.id);
  const realMembers = group.members.filter((member) => !isGroupBye(member) && member.user_id);
  const standingsByUser = new Map<string, GroupStanding>(
    realMembers.map((member) => [
      member.user_id as string,
      {
        drawSeed: member.seed,
        forfeitLosses: 0,
        forfeitWins: 0,
        gameDiff: 0,
        gameLosses: 0,
        gameWins: 0,
        isManualQualifier: member.qualifier_seed !== null,
        matchLosses: 0,
        matchWins: 0,
        needsTiebreaker: false,
        qualifierSeed: member.qualifier_seed,
        rank: 0,
        status: "eliminated",
        userId: member.user_id as string,
      },
    ]),
  );

  for (const match of groupMatches) {
    if (match.status !== "finalized" || !match.player_one_id || !match.player_two_id) {
      continue;
    }

    const winnerId = match.winner_id;
    const winnerStanding = winnerId ? standingsByUser.get(winnerId) : null;
    const loserId =
      match.winner_id === match.player_one_id ? match.player_two_id : match.player_one_id;
    const loserStanding = match.winner_id ? standingsByUser.get(loserId) : null;

    if (match.result_type === "forfeit") {
      if (winnerStanding) {
        winnerStanding.matchWins += 1;
        winnerStanding.forfeitWins += 1;
      }

      if (loserStanding) {
        loserStanding.matchLosses += 1;
        loserStanding.forfeitLosses += 1;
      }

      continue;
    }

    if (match.result_type !== "played" || !winnerId || !winnerStanding || !loserStanding) {
      continue;
    }

    winnerStanding.matchWins += 1;
    loserStanding.matchLosses += 1;

    const winnerScore = getMatchPlayerScore(match, winnerId);
    const loserScore = getMatchPlayerScore(match, loserId);

    winnerStanding.gameWins += winnerScore.wins;
    winnerStanding.gameLosses += winnerScore.losses;
    loserStanding.gameWins += loserScore.wins;
    loserStanding.gameLosses += loserScore.losses;
  }

  const sortedStandings = Array.from(standingsByUser.values()).map((standing) => ({
    ...standing,
    gameDiff: standing.gameWins - standing.gameLosses,
  }));

  sortedStandings.sort((first, second) => {
    if (second.matchWins !== first.matchWins) {
      return second.matchWins - first.matchWins;
    }

    const headToHeadWinner = getHeadToHeadWinner(groupMatches, first.userId, second.userId);

    if (headToHeadWinner === first.userId) {
      return -1;
    }

    if (headToHeadWinner === second.userId) {
      return 1;
    }

    if (second.gameDiff !== first.gameDiff) {
      return second.gameDiff - first.gameDiff;
    }

    if (second.gameWins !== first.gameWins) {
      return second.gameWins - first.gameWins;
    }

    if (first.forfeitLosses !== second.forfeitLosses) {
      return first.forfeitLosses - second.forfeitLosses;
    }

    if (first.drawSeed !== second.drawSeed) {
      return first.drawSeed - second.drawSeed;
    }

    return first.userId.localeCompare(second.userId);
  });

  const manualQualifiers = new Set(
    realMembers
      .filter((member) => member.qualifier_seed !== null && member.user_id)
      .sort((first, second) => (first.qualifier_seed ?? 0) - (second.qualifier_seed ?? 0))
      .slice(0, qualifiersPerGroup)
      .map((member) => member.user_id as string),
  );

  const cutoffStanding = sortedStandings[qualifiersPerGroup - 1] ?? null;
  const nextStanding = sortedStandings[qualifiersPerGroup] ?? null;
  const cutoffTieNeedsReview = Boolean(
    cutoffStanding &&
      nextStanding &&
      hasSamePrimaryStanding(cutoffStanding, nextStanding) &&
      getHeadToHeadWinner(groupMatches, cutoffStanding.userId, nextStanding.userId) === null,
  );

  return sortedStandings.map((standing, index) => {
    const rank = index + 1;
    const isManualQualifier = manualQualifiers.has(standing.userId);
    const isInQualifierPosition = rank <= qualifiersPerGroup;
    const needsTiebreaker =
      cutoffTieNeedsReview &&
      cutoffStanding !== null &&
      hasSamePrimaryStanding(standing, cutoffStanding);

    return {
      ...standing,
      isManualQualifier,
      needsTiebreaker,
      rank,
      status: isManualQualifier || (isInQualifierPosition && !needsTiebreaker)
        ? "qualified"
        : needsTiebreaker
          ? "tiebreaker"
          : "eliminated",
    };
  });
}

export function areGroupMatchesComplete(groups: GroupWithMembers[], matches: MatchRow[]) {
  const groupIds = new Set(groups.map((group) => group.id));
  const groupMatches = matches.filter((match) => match.group_id && groupIds.has(match.group_id));

  return groupMatches.length > 0 && groupMatches.every((match) => match.status === "finalized");
}

export function calculateQualifierSeedOrder(
  groups: GroupWithMembers[],
  matches: MatchRow[],
  tournament: Pick<TournamentRow, "qualifiers_per_group">,
) {
  const qualifiersPerGroup = tournament.qualifiers_per_group ?? 0;

  return groups
    .flatMap((group) => {
      const standings = calculateGroupStandings(group, matches, qualifiersPerGroup);
      const manualQualifiers = standings
        .filter((standing) => standing.isManualQualifier)
        .sort((first, second) => (first.qualifierSeed ?? 0) - (second.qualifierSeed ?? 0));

      const sourceStandings =
        manualQualifiers.length >= qualifiersPerGroup
          ? manualQualifiers.slice(0, qualifiersPerGroup)
          : standings.slice(0, qualifiersPerGroup);

      return sourceStandings.map<QualifiedPlayer>((standing, index) => ({
        drawSeed: standing.drawSeed,
        forfeitLosses: standing.forfeitLosses,
        gameDiff: standing.gameDiff,
        gameWins: standing.gameWins,
        groupId: group.id,
        groupName: group.name,
        groupNumber: group.group_number,
        matchWins: standing.matchWins,
        placement: standing.qualifierSeed ?? index + 1,
        userId: standing.userId,
      }));
    })
    .sort(
      (first, second) =>
        first.placement - second.placement ||
        second.matchWins - first.matchWins ||
        second.gameDiff - first.gameDiff ||
        second.gameWins - first.gameWins ||
        first.forfeitLosses - second.forfeitLosses ||
        first.drawSeed - second.drawSeed ||
        first.groupNumber - second.groupNumber ||
        first.userId.localeCompare(second.userId),
    );
}

function countSameGroupFirstRoundMatches(placement: QualifiedPlayer[], bracketSize: BracketSize) {
  const bySeed = new Map(placement.map((qualifier) => [qualifier.playoffSeed, qualifier]));
  const seedOrder = getSeedOrder(bracketSize);
  let conflicts = 0;

  for (let index = 0; index < seedOrder.length; index += 2) {
    const first = bySeed.get(seedOrder[index]);
    const second = bySeed.get(seedOrder[index + 1]);

    if (first && second && first.groupId === second.groupId) {
      conflicts += 1;
    }
  }

  return conflicts;
}

export function avoidSameGroupFirstRoundMatches(
  placement: QualifiedPlayer[],
  bracketSize: BracketSize,
) {
  let nextPlacement = placement.map((qualifier, index) => ({
    ...qualifier,
    playoffSeed: qualifier.playoffSeed ?? index + 1,
  }));
  let bestConflictCount = countSameGroupFirstRoundMatches(nextPlacement, bracketSize);

  for (let leftIndex = 0; leftIndex < nextPlacement.length && bestConflictCount > 0; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nextPlacement.length; rightIndex += 1) {
      const left = nextPlacement[leftIndex];
      const right = nextPlacement[rightIndex];

      if (!left || !right || left.placement !== right.placement) {
        continue;
      }

      const candidate = nextPlacement.slice();
      candidate[leftIndex] = { ...right, playoffSeed: left.playoffSeed };
      candidate[rightIndex] = { ...left, playoffSeed: right.playoffSeed };

      const candidateConflictCount = countSameGroupFirstRoundMatches(candidate, bracketSize);

      if (candidateConflictCount < bestConflictCount) {
        nextPlacement = candidate;
        bestConflictCount = candidateConflictCount;
        break;
      }
    }
  }

  return nextPlacement;
}

export function calculatePlayoffPlacement(
  qualifiers: QualifiedPlayer[],
  bracketSize: BracketSize,
) {
  const seededQualifiers = qualifiers.map((qualifier, index) => ({
    ...qualifier,
    playoffSeed: index + 1,
  }));

  return avoidSameGroupFirstRoundMatches(seededQualifiers, bracketSize);
}

export function getQualifiedPlayers(
  groups: GroupWithMembers[],
  matches: MatchRow[],
  tournament: Pick<TournamentRow, "qualifiers_per_group">,
) {
  return calculateQualifierSeedOrder(groups, matches, tournament);
}

export function getQualifierBlockedReason(
  groups: GroupWithMembers[],
  matches: MatchRow[],
  tournament: Pick<TournamentRow, "qualifiers_per_group">,
) {
  const qualifiersPerGroup = tournament.qualifiers_per_group ?? 0;

  if (!areGroupMatchesComplete(groups, matches)) {
    return "All group matches must be finalized before generating the playoff bracket.";
  }

  for (const group of groups) {
    const standings = calculateGroupStandings(group, matches, qualifiersPerGroup);
    const manualQualifierCount = group.members.filter(
      (member) => !isGroupBye(member) && member.qualifier_seed !== null,
    ).length;

    if (manualQualifierCount >= Math.min(qualifiersPerGroup, standings.length)) {
      continue;
    }

    if (standings.some((standing) => standing.status === "tiebreaker")) {
      return `${group.name} has an unresolved cutoff tie. Set manual qualifiers before generating playoffs.`;
    }
  }

  return null;
}
