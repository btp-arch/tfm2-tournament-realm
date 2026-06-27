import type { RoleState } from "@/lib/roles";
import {
  matchFormatLabels,
  type MatchFormat,
  type TournamentRow,
  type TournamentStatus,
} from "@/lib/tournaments";

export const minTournamentTimerMinutes = 1;
export const maxTournamentTimerMinutes = 240;

export type TournamentTimingSettings = {
  autoApplyTimerOutcomes: boolean;
  autoOpenReadyMatches: boolean;
  bracketBo1RoundMinutes: number;
  bracketBo3RoundMinutes: number;
  bracketBo5RoundMinutes: number;
  checkInWindowMinutes: number;
  groupBo1RoundMinutes: number;
  groupBo3RoundMinutes: number;
  independentGroupProgression: boolean;
  replacementWindowEnabled: boolean;
  replacementWindowMinutes: number;
};

export type TournamentTimingWindow =
  | "check_in"
  | "replacement"
  | "group_round"
  | "bracket_round";

export type TournamentTimingControlPatch = Partial<
  Pick<
    TournamentRow,
    | "current_bracket_round_deadline"
    | "current_check_in_deadline"
    | "current_group_round_deadline"
    | "current_replacement_deadline"
    | "timers_paused_at"
    | "timing_note"
    | "timing_state"
    | "total_paused_seconds"
  >
>;

export type TournamentTimingState = {
  activeWindow: TournamentTimingWindow | null;
  deadline: Date | null;
  isExpired: boolean;
  isPaused: boolean;
  label: string;
  nextAction: string;
};

export function getDefaultTournamentTimingSettings(): TournamentTimingSettings {
  return {
    autoApplyTimerOutcomes: false,
    autoOpenReadyMatches: true,
    bracketBo1RoundMinutes: 20,
    bracketBo3RoundMinutes: 45,
    bracketBo5RoundMinutes: 70,
    checkInWindowMinutes: 10,
    groupBo1RoundMinutes: 20,
    groupBo3RoundMinutes: 45,
    independentGroupProgression: true,
    replacementWindowEnabled: true,
    replacementWindowMinutes: 5,
  };
}

function normalizeTimerMinutes(value: number | null | undefined, fallback: number) {
  if (!Number.isFinite(value) || value === null || value === undefined) {
    return fallback;
  }

  return Math.min(
    maxTournamentTimerMinutes,
    Math.max(minTournamentTimerMinutes, Math.trunc(value)),
  );
}

export function normalizeTournamentTimingSettings(
  tournament: Partial<TournamentRow> | TournamentTimingSettings,
): TournamentTimingSettings {
  const defaults = getDefaultTournamentTimingSettings();

  return {
    autoApplyTimerOutcomes:
      "autoApplyTimerOutcomes" in tournament
        ? tournament.autoApplyTimerOutcomes
        : tournament.auto_apply_timer_outcomes ?? defaults.autoApplyTimerOutcomes,
    autoOpenReadyMatches:
      "autoOpenReadyMatches" in tournament
        ? tournament.autoOpenReadyMatches
        : tournament.auto_open_ready_matches ?? defaults.autoOpenReadyMatches,
    bracketBo1RoundMinutes: normalizeTimerMinutes(
      "bracketBo1RoundMinutes" in tournament
        ? tournament.bracketBo1RoundMinutes
        : tournament.bracket_bo1_round_minutes,
      defaults.bracketBo1RoundMinutes,
    ),
    bracketBo3RoundMinutes: normalizeTimerMinutes(
      "bracketBo3RoundMinutes" in tournament
        ? tournament.bracketBo3RoundMinutes
        : tournament.bracket_bo3_round_minutes,
      defaults.bracketBo3RoundMinutes,
    ),
    bracketBo5RoundMinutes: normalizeTimerMinutes(
      "bracketBo5RoundMinutes" in tournament
        ? tournament.bracketBo5RoundMinutes
        : tournament.bracket_bo5_round_minutes,
      defaults.bracketBo5RoundMinutes,
    ),
    checkInWindowMinutes: normalizeTimerMinutes(
      "checkInWindowMinutes" in tournament
        ? tournament.checkInWindowMinutes
        : tournament.check_in_window_minutes,
      defaults.checkInWindowMinutes,
    ),
    groupBo1RoundMinutes: normalizeTimerMinutes(
      "groupBo1RoundMinutes" in tournament
        ? tournament.groupBo1RoundMinutes
        : tournament.group_bo1_round_minutes,
      defaults.groupBo1RoundMinutes,
    ),
    groupBo3RoundMinutes: normalizeTimerMinutes(
      "groupBo3RoundMinutes" in tournament
        ? tournament.groupBo3RoundMinutes
        : tournament.group_bo3_round_minutes,
      defaults.groupBo3RoundMinutes,
    ),
    independentGroupProgression:
      "independentGroupProgression" in tournament
        ? tournament.independentGroupProgression
        : tournament.independent_group_progression ?? defaults.independentGroupProgression,
    replacementWindowEnabled:
      "replacementWindowEnabled" in tournament
        ? tournament.replacementWindowEnabled
        : tournament.replacement_window_enabled ?? defaults.replacementWindowEnabled,
    replacementWindowMinutes: normalizeTimerMinutes(
      "replacementWindowMinutes" in tournament
        ? tournament.replacementWindowMinutes
        : tournament.replacement_window_minutes,
      defaults.replacementWindowMinutes,
    ),
  };
}

export function validateTournamentTimingSettings(settings: TournamentTimingSettings) {
  type TimerMinuteField =
    | "bracketBo1RoundMinutes"
    | "bracketBo3RoundMinutes"
    | "bracketBo5RoundMinutes"
    | "checkInWindowMinutes"
    | "groupBo1RoundMinutes"
    | "groupBo3RoundMinutes"
    | "replacementWindowMinutes";
  const fields: [TimerMinuteField, string][] = [
    ["checkInWindowMinutes", "Check-in window"],
    ["replacementWindowMinutes", "Replacement window"],
    ["groupBo1RoundMinutes", "Group BO1 round timer"],
    ["groupBo3RoundMinutes", "Group BO3 round timer"],
    ["bracketBo1RoundMinutes", "Bracket BO1 round timer"],
    ["bracketBo3RoundMinutes", "Bracket BO3 round timer"],
    ["bracketBo5RoundMinutes", "Bracket BO5 round timer"],
  ];

  for (const [field, label] of fields) {
    const value = settings[field];

    if (!Number.isInteger(value) || value < minTournamentTimerMinutes) {
      return `${label} must be a positive whole number.`;
    }

    if (value > maxTournamentTimerMinutes) {
      return `${label} must be ${maxTournamentTimerMinutes} minutes or less.`;
    }
  }

  return null;
}

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

export function isTournamentPaused(tournament: Pick<TournamentRow, "timers_paused_at">) {
  return Boolean(tournament.timers_paused_at);
}

export function calculatePausedAdjustedDeadline(
  deadline: string | null,
  tournament: Pick<TournamentRow, "timers_paused_at" | "total_paused_seconds">,
) {
  if (!deadline) {
    return null;
  }

  const pausedSeconds = tournament.timers_paused_at
    ? Math.max(0, Math.floor((Date.now() - new Date(tournament.timers_paused_at).getTime()) / 1000))
    : 0;

  return new Date(new Date(deadline).getTime() + pausedSeconds * 1000);
}

export function getCheckInDeadline(tournament: TournamentRow) {
  const settings = normalizeTournamentTimingSettings(tournament);

  if (tournament.current_check_in_deadline) {
    return calculatePausedAdjustedDeadline(tournament.current_check_in_deadline, tournament);
  }

  if (!tournament.starts_at) {
    return null;
  }

  return calculatePausedAdjustedDeadline(
    addMinutes(new Date(tournament.starts_at), settings.checkInWindowMinutes).toISOString(),
    tournament,
  );
}

export function getReplacementDeadline(tournament: TournamentRow) {
  const settings = normalizeTournamentTimingSettings(tournament);

  if (!settings.replacementWindowEnabled) {
    return null;
  }

  if (tournament.current_replacement_deadline) {
    return calculatePausedAdjustedDeadline(tournament.current_replacement_deadline, tournament);
  }

  const checkInDeadline = getCheckInDeadline(tournament);

  return checkInDeadline
    ? addMinutes(checkInDeadline, settings.replacementWindowMinutes)
    : null;
}

export function getRoundDurationForFormat(
  format: MatchFormat,
  phase: "group" | "bracket",
  tournament: TournamentRow | TournamentTimingSettings,
) {
  const settings = normalizeTournamentTimingSettings(tournament);

  if (phase === "group") {
    return format === "bo3" ? settings.groupBo3RoundMinutes : settings.groupBo1RoundMinutes;
  }

  if (format === "bo5") {
    return settings.bracketBo5RoundMinutes;
  }

  return format === "bo3" ? settings.bracketBo3RoundMinutes : settings.bracketBo1RoundMinutes;
}

function getWindowLabel(window: TournamentTimingWindow) {
  if (window === "check_in") return "Check-in";
  if (window === "replacement") return "Replacement";
  if (window === "group_round") return "Group round";
  return "Bracket round";
}

export function getCountdownLabel(deadline: Date | null, paused: boolean, now = new Date()) {
  if (!deadline) {
    return "No active deadline";
  }

  if (paused) {
    return "Paused";
  }

  const remainingSeconds = Math.floor((deadline.getTime() - now.getTime()) / 1000);

  if (remainingSeconds <= 0) {
    return "Expired";
  }

  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m remaining`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s remaining`;
  }

  return `${seconds}s remaining`;
}

export function getCurrentTournamentTimingState(
  tournament: TournamentRow,
  hasGroupStage: boolean,
  now = new Date(),
): TournamentTimingState {
  const paused = isTournamentPaused(tournament);
  let activeWindow: TournamentTimingWindow | null = null;
  let deadline: Date | null = null;

  if (tournament.status === "check_in") {
    const checkInDeadline = getCheckInDeadline(tournament);
    const replacementDeadline = getReplacementDeadline(tournament);

    if (checkInDeadline && now <= checkInDeadline) {
      activeWindow = "check_in";
      deadline = checkInDeadline;
    } else if (replacementDeadline && now <= replacementDeadline) {
      activeWindow = "replacement";
      deadline = replacementDeadline;
    } else {
      activeWindow = "check_in";
      deadline = checkInDeadline ?? replacementDeadline;
    }
  } else if (tournament.status === "active") {
    if (hasGroupStage && tournament.current_group_round_deadline) {
      activeWindow = "group_round";
      deadline = calculatePausedAdjustedDeadline(tournament.current_group_round_deadline, tournament);
    } else if (tournament.current_bracket_round_deadline) {
      activeWindow = "bracket_round";
      deadline = calculatePausedAdjustedDeadline(tournament.current_bracket_round_deadline, tournament);
    }
  }

  const isExpired = Boolean(deadline && !paused && deadline.getTime() <= now.getTime());
  const label = activeWindow ? getWindowLabel(activeWindow) : "No active timer";
  const countdown = getCountdownLabel(deadline, paused, now);

  return {
    activeWindow,
    deadline,
    isExpired,
    isPaused: paused,
    label,
    nextAction: paused
      ? "Timers are paused. Resume when staff is ready."
      : isExpired
        ? "Window expired - organizer action needed."
        : activeWindow
          ? `${label}: ${countdown}.`
          : "No timer action is currently required.",
  };
}

export function buildTimingInsertPayload(settings: TournamentTimingSettings) {
  return {
    auto_apply_timer_outcomes: settings.autoApplyTimerOutcomes,
    auto_open_ready_matches: settings.autoOpenReadyMatches,
    bracket_bo1_round_minutes: settings.bracketBo1RoundMinutes,
    bracket_bo3_round_minutes: settings.bracketBo3RoundMinutes,
    bracket_bo5_round_minutes: settings.bracketBo5RoundMinutes,
    check_in_window_minutes: settings.checkInWindowMinutes,
    group_bo1_round_minutes: settings.groupBo1RoundMinutes,
    group_bo3_round_minutes: settings.groupBo3RoundMinutes,
    independent_group_progression: settings.independentGroupProgression,
    replacement_window_enabled: settings.replacementWindowEnabled,
    replacement_window_minutes: settings.replacementWindowMinutes,
  };
}

export function createDeadlinePatch(
  tournament: TournamentRow,
  window: TournamentTimingWindow,
  minutes: number,
): TournamentTimingControlPatch {
  const now = new Date();
  const deadline = addMinutes(now, minutes).toISOString();

  if (window === "check_in") {
    return { current_check_in_deadline: deadline, timing_state: "check_in" };
  }

  if (window === "replacement") {
    return { current_replacement_deadline: deadline, timing_state: "replacement" };
  }

  if (window === "group_round") {
    const format = tournament.group_stage_format ?? "bo1";
    return {
      current_group_round_deadline: addMinutes(
        now,
        getRoundDurationForFormat(format, "group", tournament),
      ).toISOString(),
      timing_state: "group_round",
    };
  }

  return {
    current_bracket_round_deadline: deadline,
    timing_state: "bracket_round",
  };
}

export function extendTournamentWindow(
  tournament: TournamentRow,
  window: TournamentTimingWindow,
  minutes: number,
): TournamentTimingControlPatch {
  const now = Date.now();
  const fieldByWindow = {
    bracket_round: "current_bracket_round_deadline",
    check_in: "current_check_in_deadline",
    group_round: "current_group_round_deadline",
    replacement: "current_replacement_deadline",
  } as const;
  const field = fieldByWindow[window];
  const currentDeadline = tournament[field] ? new Date(tournament[field]).getTime() : now;
  const nextDeadline = new Date(Math.max(currentDeadline, now) + minutes * 60_000).toISOString();

  return {
    [field]: nextDeadline,
    timing_note: `Extended ${getWindowLabel(window).toLowerCase()} by ${minutes} minutes.`,
    timing_state: window,
  };
}

export function pauseTournamentTimers(): TournamentTimingControlPatch {
  return {
    timers_paused_at: new Date().toISOString(),
    timing_note: "Timers paused by tournament staff.",
    timing_state: "paused",
  };
}

export function resumeTournamentTimers(tournament: TournamentRow): TournamentTimingControlPatch {
  const pausedAt = tournament.timers_paused_at ? new Date(tournament.timers_paused_at).getTime() : null;
  const pausedSeconds = pausedAt ? Math.max(0, Math.floor((Date.now() - pausedAt) / 1000)) : 0;
  const shiftDeadline = (deadline: string | null) =>
    deadline ? new Date(new Date(deadline).getTime() + pausedSeconds * 1000).toISOString() : null;

  return {
    current_bracket_round_deadline: shiftDeadline(tournament.current_bracket_round_deadline),
    current_check_in_deadline: shiftDeadline(tournament.current_check_in_deadline),
    current_group_round_deadline: shiftDeadline(tournament.current_group_round_deadline),
    current_replacement_deadline: shiftDeadline(tournament.current_replacement_deadline),
    timers_paused_at: null,
    timing_note: "Timers resumed by tournament staff.",
    timing_state: "active",
    total_paused_seconds: (tournament.total_paused_seconds ?? 0) + pausedSeconds,
  };
}

export function forceCloseTournamentWindow(
  window: TournamentTimingWindow,
): TournamentTimingControlPatch {
  const now = new Date().toISOString();

  if (window === "check_in") {
    return { current_check_in_deadline: now, timing_note: "Check-in window force closed." };
  }

  if (window === "replacement") {
    return { current_replacement_deadline: now, timing_note: "Replacement window force closed." };
  }

  if (window === "group_round") {
    return { current_group_round_deadline: now, timing_note: "Group round timer force closed." };
  }

  return { current_bracket_round_deadline: now, timing_note: "Bracket round timer force closed." };
}

export function generateTournamentTimingRulesText(
  tournament: Pick<
    TournamentRow,
    | "auto_apply_timer_outcomes"
    | "auto_open_ready_matches"
    | "bracket_bo1_round_minutes"
    | "bracket_bo3_round_minutes"
    | "bracket_bo5_round_minutes"
    | "check_in_window_minutes"
    | "final_match_format"
    | "group_bo1_round_minutes"
    | "group_bo3_round_minutes"
    | "group_stage_format"
    | "independent_group_progression"
    | "pre_semifinal_match_format"
    | "replacement_window_enabled"
    | "replacement_window_minutes"
    | "semifinal_match_format"
    | "tournament_format"
  >,
) {
  const settings = normalizeTournamentTimingSettings(tournament);
  const bracketFormats = Array.from(
    new Set([
      tournament.pre_semifinal_match_format,
      tournament.semifinal_match_format,
      tournament.final_match_format,
    ]),
  );
  const bracketTimerText = bracketFormats
    .map((format) => {
      const duration =
        format === "bo5"
          ? settings.bracketBo5RoundMinutes
          : format === "bo3"
            ? settings.bracketBo3RoundMinutes
            : settings.bracketBo1RoundMinutes;

      return `Bracket ${matchFormatLabels[format]} rounds have a ${duration}-minute timer.`;
    })
    .join(" ");
  const replacementText = settings.replacementWindowEnabled
    ? `After check-in closes, a ${settings.replacementWindowMinutes}-minute replacement window may open if open spots are available. Replacement players are unseeded and can only fill open spots.`
    : "Replacement players are not enabled for this tournament.";
  const groupText =
    tournament.tournament_format === "group_stage_playoff"
      ? `Group-stage BO1 rounds have a ${settings.groupBo1RoundMinutes}-minute timer. Group-stage BO3 rounds have a ${settings.groupBo3RoundMinutes}-minute timer. ${
          settings.independentGroupProgression
            ? "Groups may progress independently when their real matches are resolved."
            : "Groups progress together when staff advances the stage."
        }`
      : null;

  return [
    `Check-in opens at tournament start and lasts ${settings.checkInWindowMinutes} minutes. Players who do not check in before the window closes may be excluded from the active field.`,
    replacementText,
    groupText,
    bracketTimerText,
    settings.autoOpenReadyMatches
      ? "Ready matches may open when both players are known, subject to staff control."
      : "Ready matches open when staff advances tournament operations.",
    settings.autoApplyTimerOutcomes
      ? "Timer outcomes are configured for automatic handling when staff enables automation."
      : "Expired timers do not automatically decide matches in this milestone; tournament staff reviews overdue matches and timing windows.",
    "Tournament staff may pause, resume, extend, or force close timing windows when needed. While paused, timers do not expire.",
    "If a match is unresolved when a timer expires, tournament staff may resolve it by forfeit, no contest, or staff review according to the event rules.",
    "Forfeits count for group standings but do not count toward public player records. BYEs and no-contests do not count toward public player records.",
    "Replacement players are unseeded.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function canEditTimingSettings(
  tournament: Pick<TournamentRow, "created_by" | "status">,
  roles: RoleState,
  userId: string | null,
  isManagedByUser: boolean,
) {
  return Boolean(
    userId &&
      (roles.isAdmin || tournament.created_by === userId || isManagedByUser) &&
      ["draft", "registration_open", "registration_closed"].includes(tournament.status),
  );
}

export function canPauseTournamentTimers(
  tournament: Pick<TournamentRow, "created_by" | "status">,
  roles: RoleState,
  userId: string | null,
  isManagedByUser: boolean,
) {
  return Boolean(
    userId &&
      (roles.isAdmin || tournament.created_by === userId || isManagedByUser) &&
      ["check_in", "active"].includes(tournament.status),
  );
}

export function canExtendTournamentWindow(
  tournament: Pick<TournamentRow, "created_by" | "status">,
  roles: RoleState,
  userId: string | null,
  isManagedByUser: boolean,
) {
  return canPauseTournamentTimers(tournament, roles, userId, isManagedByUser);
}

export function getStatusTimingPatch(tournament: TournamentRow, nextStatus: TournamentStatus) {
  if (nextStatus === "check_in") {
    return createDeadlinePatch(
      tournament,
      "check_in",
      normalizeTournamentTimingSettings(tournament).checkInWindowMinutes,
    );
  }

  if (nextStatus === "active") {
    const firstBracketFormat = tournament.pre_semifinal_match_format ?? tournament.format;

    return createDeadlinePatch(
      tournament,
      "bracket_round",
      getRoundDurationForFormat(firstBracketFormat, "bracket", tournament),
    );
  }

  return {};
}

export function getTimingWindowLabel(window: TournamentTimingWindow) {
  return getWindowLabel(window);
}
