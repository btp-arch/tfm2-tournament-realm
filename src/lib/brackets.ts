import type { Database } from "@/types/database.generated";

export type BracketSize = 4 | 8 | 16 | 32;
export type MatchFormat = Database["public"]["Enums"]["match_format"];
export type MatchStatus = Database["public"]["Enums"]["match_status"];
export type SeedingMethod = Database["public"]["Enums"]["tournament_seeding_method"];

export type BracketPlayer = {
  userId: string;
  seed: number;
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

export const bracketSizes: BracketSize[] = [4, 8, 16, 32];
export const seedingMethods: SeedingMethod[] = [
  "random",
  "registration_order",
  "check_in_order",
];

export const seedingMethodLabels: Record<SeedingMethod, string> = {
  check_in_order: "Check-in Order",
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

function getSeedOrder(size: number): number[] {
  if (size === 2) {
    return [1, 2];
  }

  const previous = getSeedOrder(size / 2);

  return previous.flatMap((seed) => [seed, size + 1 - seed]);
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
