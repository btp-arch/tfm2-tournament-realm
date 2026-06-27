import type { Database } from "@/types/database.generated";

export type BracketSize = 4 | 8 | 16 | 32 | 64;
export type MatchFormat = Database["public"]["Enums"]["match_format"];
export type MatchStatus = Database["public"]["Enums"]["match_status"];
export type SeedingMethod = Database["public"]["Enums"]["tournament_seeding_method"];

export type BracketPlayer = {
  userId: string;
  seed: number;
};

export type ManualSeedRegistration = {
  manualSeed: number | null;
  userId: string;
};

export type GeneratedMatch = {
  roundNumber: number;
  matchNumber: number;
  bracketPosition: number;
  playerOneId: string | null;
  playerTwoId: string | null;
  playerOneSeed: number | null;
  playerTwoSeed: number | null;
  playerOneSlot: number;
  playerTwoSlot: number;
  winnerId: string | null;
  status: MatchStatus;
  format: MatchFormat;
};

type BracketSlot = {
  player: BracketPlayer | null;
  slotNumber: number;
};

export const bracketSizes: BracketSize[] = [4, 8, 16, 32, 64];
export const seedingMethods: SeedingMethod[] = [
  "random",
  "registration_order",
  "check_in_order",
];

export const seedingMethodLabels: Record<SeedingMethod, string> = {
  check_in_order: "Check-in Order",
  group_finish: "Group Finish",
  random: "Random",
  registration_order: "Registration Order",
};

export function isBracketSize(value: number): value is BracketSize {
  return bracketSizes.includes(value as BracketSize);
}

export function getRoundCount(bracketSize: BracketSize) {
  return Math.log2(bracketSize);
}

export function getRoundName(bracketSize: BracketSize, roundNumber: number) {
  const remainingPlayers = bracketSize / 2 ** (roundNumber - 1);

  if (remainingPlayers === 2) {
    return "Final";
  }

  if (remainingPlayers === 4) {
    return "Semifinals";
  }

  if (remainingPlayers === 8) {
    return "Quarterfinals";
  }

  return `Round of ${remainingPlayers}`;
}

export function getDefaultRoundFormats(bracketSize: BracketSize): MatchFormat[] {
  return Array.from({ length: getRoundCount(bracketSize) }, (_, index) => {
    const roundName = getRoundName(bracketSize, index + 1);

    if (roundName === "Final") {
      return "bo5";
    }

    if (roundName === "Semifinals") {
      return "bo3";
    }

    return "bo1";
  });
}

export function getRoundFormatsFromDefaults(
  bracketSize: BracketSize,
  formats: {
    final: MatchFormat;
    preSemifinal: MatchFormat;
    semifinal: MatchFormat;
  },
): MatchFormat[] {
  return Array.from({ length: getRoundCount(bracketSize) }, (_, index) => {
    const roundName = getRoundName(bracketSize, index + 1);

    if (roundName === "Final") {
      return formats.final;
    }

    if (roundName === "Semifinals") {
      return formats.semifinal;
    }

    return formats.preSemifinal;
  });
}

export function getBracketSetupWarning(
  checkedInCount: number,
  bracketSize: BracketSize,
) {
  if (checkedInCount < 2) {
    return "At least 2 checked-in players are required to generate a bracket.";
  }

  if (checkedInCount > bracketSize) {
    return `There are ${checkedInCount} checked-in players, which is more than a ${bracketSize}-player bracket can hold.`;
  }

  if (checkedInCount < bracketSize) {
    return `${bracketSize - checkedInCount} bracket slot${
      bracketSize - checkedInCount === 1 ? "" : "s"
    } will be filled with byes.`;
  }

  return null;
}

export function validateManualSeed(seed: number | null, maxSeed = 8) {
  if (seed === null) {
    return null;
  }

  if (!Number.isInteger(seed) || seed < 1 || seed > 8) {
    return "Manual seeds must be empty or between 1 and 8.";
  }

  if (seed > maxSeed) {
    return `Seed ${seed} is not available for this ${maxSeed}-player bracket.`;
  }

  return null;
}

export function getSeededRegistrations<T extends ManualSeedRegistration>(registrations: T[]) {
  return registrations
    .filter((registration) => registration.manualSeed !== null)
    .sort((first, second) => (first.manualSeed ?? 0) - (second.manualSeed ?? 0));
}

export function getUnseededRegistrations<T extends ManualSeedRegistration>(registrations: T[]) {
  return registrations.filter((registration) => registration.manualSeed === null);
}

export function getSeedOrder(size: number): number[] {
  if (size === 2) {
    return [1, 2];
  }

  const previous = getSeedOrder(size / 2);

  // Preserve each existing seed's top/bottom slot while adding its mirrored opponent.
  return previous.flatMap((seed, index) => {
    const pairedSeed = size + 1 - seed;

    return index % 2 === 0 ? [seed, pairedSeed] : [pairedSeed, seed];
  });
}

export function buildSeededSingleEliminationSlots<T extends ManualSeedRegistration>(
  participants: T[],
  bracketSize: BracketSize,
  orderUnseededRegistrations: (registrations: T[]) => T[],
): BracketPlayer[] {
  const seededRegistrations = getSeededRegistrations(participants);
  const manualSeeds = new Set<number>();

  for (const participant of seededRegistrations) {
    const validationError = validateManualSeed(participant.manualSeed, Math.min(8, bracketSize));

    if (validationError) {
      throw new Error(validationError);
    }

    if (participant.manualSeed !== null) {
      if (manualSeeds.has(participant.manualSeed)) {
        throw new Error(`Seed ${participant.manualSeed} is already assigned in this tournament.`);
      }

      manualSeeds.add(participant.manualSeed);
    }
  }

  const openSeeds = Array.from({ length: bracketSize }, (_, index) => index + 1)
    .filter((seed) => !manualSeeds.has(seed));
  const orderedUnseededRegistrations = orderUnseededRegistrations(
    getUnseededRegistrations(participants),
  );

  return [
    ...seededRegistrations.map((participant) => ({
      userId: participant.userId,
      seed: participant.manualSeed as number,
    })),
    ...orderedUnseededRegistrations.map((participant, index) => ({
      userId: participant.userId,
      seed: openSeeds[index] ?? bracketSize,
    })),
  ];
}

export function generateSingleEliminationMatches(
  players: BracketPlayer[],
  bracketSize: BracketSize,
  roundFormats: MatchFormat[],
): GeneratedMatch[] {
  const playersBySeed = new Map(players.map((player) => [player.seed, player]));
  let slots: BracketSlot[] = getSeedOrder(bracketSize).map((seed, index) => ({
    player: playersBySeed.get(seed) ?? null,
    slotNumber: index + 1,
  }));
  const matches: GeneratedMatch[] = [];

  for (let roundNumber = 1; roundNumber <= getRoundCount(bracketSize); roundNumber += 1) {
    const nextSlots: BracketSlot[] = [];
    const format = roundFormats[roundNumber - 1] ?? "bo1";

    for (let index = 0; index < slots.length; index += 2) {
      const playerOneSlot = slots[index];
      const playerTwoSlot = slots[index + 1];
      const playerOne = playerOneSlot?.player ?? null;
      const playerTwo = playerTwoSlot?.player ?? null;
      const winner = playerOne && !playerTwo ? playerOne : !playerOne && playerTwo ? playerTwo : null;
      const status: MatchStatus =
        playerOne && playerTwo ? "assigned" : winner ? "bye" : "pending";

      matches.push({
        roundNumber,
        matchNumber: matches.length + 1,
        bracketPosition: Math.floor(index / 2) + 1,
        playerOneId: playerOne?.userId ?? null,
        playerTwoId: playerTwo?.userId ?? null,
        playerOneSeed: playerOne?.seed ?? null,
        playerTwoSeed: playerTwo?.seed ?? null,
        playerOneSlot: playerOneSlot.slotNumber,
        playerTwoSlot: playerTwoSlot.slotNumber,
        winnerId: winner?.userId ?? null,
        status,
        format,
      });

      nextSlots.push({
        player: winner,
        slotNumber: Math.floor(index / 2) + 1,
      });
    }

    slots = nextSlots;
  }

  return matches;
}
