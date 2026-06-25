import type { Database } from "@/types/database.generated";

export type MatchFormat = Database["public"]["Enums"]["match_format"];
export type TournamentFormat = Database["public"]["Enums"]["tournament_format"];
export type TournamentStatus = Database["public"]["Enums"]["tournament_status"];
export type RegistrationStatus = Database["public"]["Enums"]["registration_status"];
export type TournamentRow = Database["public"]["Tables"]["tournaments"]["Row"];
export type TournamentInsert = Database["public"]["Tables"]["tournaments"]["Insert"];
export type TournamentRegistrationRow =
  Database["public"]["Tables"]["tournament_registrations"]["Row"];

export const publicTournamentStatuses: TournamentStatus[] = [
  "registration_open",
  "registration_closed",
  "check_in",
  "active",
  "completed",
];

export const editableTournamentStatuses: TournamentStatus[] = [
  "draft",
  "registration_open",
  "registration_closed",
  "check_in",
  "active",
  "completed",
  "cancelled",
];

export const matchFormats: MatchFormat[] = ["bo1", "bo3", "bo5"];
export const tournamentFormats: TournamentFormat[] = ["single_elimination"];

export const tournamentStatusLabels: Record<TournamentStatus, string> = {
  active: "Active",
  cancelled: "Cancelled",
  check_in: "Check-in",
  completed: "Completed",
  draft: "Draft",
  in_progress: "In Progress",
  published: "Published",
  registration_closed: "Registration Closed",
  registration_open: "Registration Open",
};

export const matchFormatLabels: Record<MatchFormat, string> = {
  bo1: "BO1",
  bo3: "BO3",
  bo5: "BO5",
};

export const tournamentFormatLabels: Record<TournamentFormat, string> = {
  single_elimination: "Single Elimination",
};

export function formatDateTime(value: string | null) {
  if (!value) {
    return "Not scheduled";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function normalizeOptionalText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function slugifyTournamentName(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "tournament";
}

export function buildTournamentSlug(name: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${slugifyTournamentName(name)}-${suffix}`;
}

export function toIsoFromLocalInput(value: string) {
  return value ? new Date(value).toISOString() : null;
}

export function isRegistrationOpen(tournament: Pick<TournamentRow, "status" | "registration_closes_at">) {
  if (tournament.status !== "registration_open") {
    return false;
  }

  return !tournament.registration_closes_at || new Date(tournament.registration_closes_at) > new Date();
}

export function isTournamentFull(
  tournament: Pick<TournamentRow, "max_players">,
  activeRegistrationCount: number,
) {
  return tournament.max_players !== null && activeRegistrationCount >= tournament.max_players;
}

export function canRegisterForTournament(
  tournament: Pick<TournamentRow, "status" | "registration_closes_at" | "max_players">,
  activeRegistrationCount: number,
  registration: TournamentRegistrationRow | null,
) {
  return (
    isRegistrationOpen(tournament) &&
    !isTournamentFull(tournament, activeRegistrationCount) &&
    registration === null
  );
}

export function canWithdrawFromTournament(
  tournament: Pick<TournamentRow, "status" | "registration_closes_at">,
  registration: TournamentRegistrationRow | null,
) {
  return Boolean(
    registration &&
      registration.status !== "withdrawn" &&
      isRegistrationOpen(tournament),
  );
}

export function getRegistrationBlockedReason(
  tournament: Pick<TournamentRow, "status" | "registration_closes_at" | "max_players">,
  activeRegistrationCount: number,
  registration: TournamentRegistrationRow | null,
  isSignedIn: boolean,
) {
  if (!isSignedIn) {
    return "Sign in to register for this tournament.";
  }

  if (registration?.status === "withdrawn") {
    return "You withdrew from this tournament.";
  }

  if (registration) {
    return "You are already registered.";
  }

  if (isTournamentFull(tournament, activeRegistrationCount)) {
    return "Registration is full.";
  }

  if (!isRegistrationOpen(tournament)) {
    return "Registration is closed.";
  }

  return null;
}
