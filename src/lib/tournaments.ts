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
  "cancelled",
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

export const tournamentStatusDescriptions: Partial<Record<TournamentStatus, string>> = {
  active: "Tournament has started.",
  cancelled: "Tournament was called off.",
  check_in: "Registered players check in.",
  completed: "Tournament finished.",
  draft: "Setup only, no registration.",
  registration_closed: "Registration locked.",
  registration_open: "Players may register.",
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

export function toLocalDateTimeInput(value: string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return localDate.toISOString().slice(0, 16);
}

export function isRegistrationOpen(tournament: Pick<TournamentRow, "status" | "registration_closes_at">) {
  if (tournament.status !== "registration_open") {
    return false;
  }

  return !tournament.registration_closes_at || new Date(tournament.registration_closes_at) > new Date();
}

export function isRegistrationCloseTimeFuture(
  tournament: Pick<TournamentRow, "registration_closes_at">,
) {
  return Boolean(
    tournament.registration_closes_at &&
      new Date(tournament.registration_closes_at) > new Date(),
  );
}

export function getRegistrationReopenBlockedReason(
  tournament: Pick<TournamentRow, "registration_closes_at">,
) {
  if (!isRegistrationCloseTimeFuture(tournament)) {
    return "Update the registration close time to a future time before reopening registration.";
  }

  return null;
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

  if (tournament.status === "draft") {
    return "Registration is not open because this tournament is still a draft.";
  }

  if (tournament.status === "cancelled") {
    return "Registration is unavailable because this tournament was cancelled.";
  }

  if (tournament.status === "registration_closed") {
    return "Registration is closed.";
  }

  if (tournament.status === "check_in") {
    return "Registration is locked while check-in is in progress.";
  }

  if (tournament.status === "active" || tournament.status === "in_progress") {
    return "Registration is unavailable because this tournament is active.";
  }

  if (tournament.status === "completed") {
    return "Registration is unavailable because this tournament is completed.";
  }

  if (
    tournament.status === "registration_open" &&
    tournament.registration_closes_at &&
    new Date(tournament.registration_closes_at) <= new Date()
  ) {
    return "Registration close time has passed.";
  }

  if (isTournamentFull(tournament, activeRegistrationCount)) {
    return "Tournament is full.";
  }

  if (tournament.status === "published") {
    return "Registration is not open yet.";
  }

  if (tournament.status !== "registration_open") {
    return "Registration is closed.";
  }

  return null;
}

export function getTournamentDeleteBlockedReason(
  tournament: Pick<TournamentRow, "status" | "created_by">,
  activeRegistrationCount: number,
  userId: string | null,
  isAdmin: boolean,
) {
  if (!userId) {
    return "Sign in with organizer or admin access to delete tournaments.";
  }

  if (isAdmin) {
    return null;
  }

  if (tournament.status !== "draft") {
    return "Only draft tournaments can be deleted.";
  }

  if (activeRegistrationCount > 0) {
    return "Tournaments with registrations cannot be deleted. Cancel the tournament instead.";
  }

  if (tournament.created_by === userId) {
    return null;
  }

  return "Only the tournament creator or an admin can delete this draft tournament.";
}
