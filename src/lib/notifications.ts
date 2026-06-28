import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import {
  calculatePausedAdjustedDeadline,
  getCheckInDeadline,
  getReplacementDeadline,
} from "@/lib/tournament-timing";
import type {
  MatchCheckInRow,
  MatchReportRow,
  MatchRow,
  TournamentCheckInRow,
  TournamentRegistrationRow,
  TournamentRoundRow,
  TournamentRow,
} from "@/lib/tournaments";
import type { RoleState } from "@/lib/roles";
import { doMatchReportsMismatch } from "@/lib/match-rooms";

export type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];
export type AppSupabaseClient = SupabaseClient<Database>;

export const liveRefreshIntervalMs = 12_000;

export function getUnreadCount(notifications: Pick<NotificationRow, "read_at">[]) {
  return notifications.filter((notification) => !notification.read_at).length;
}

export type ActiveAction = {
  body: string;
  deadlineAt: string | null;
  href: string;
  priority: number;
  timerLabel: string | null;
  title: string;
};

function buildMatchAction(
  match: MatchRow,
  checkIns: MatchCheckInRow[],
  reports: MatchReportRow[],
  userId: string,
  tournament: TournamentRow | null,
  round: TournamentRoundRow | null,
): ActiveAction | null {
  const ownCheckIn = checkIns.some(
    (checkIn) => checkIn.match_id === match.id && checkIn.user_id === userId,
  );
  const ownReport = reports.find(
    (report) => report.match_id === match.id && report.reporter_id === userId,
  );
  const matchReports = reports.filter((report) => report.match_id === match.id);
  const reportsMismatch =
    matchReports.length >= 2 &&
    doMatchReportsMismatch(matchReports[0] ?? null, matchReports[1] ?? null);
  const roundDeadline = round?.deadline_at
    ? calculatePausedAdjustedDeadline(round.deadline_at, tournament ?? { timers_paused_at: null, total_paused_seconds: 0 })
    : null;
  const fallbackDeadline =
    tournament && match.group_id
      ? calculatePausedAdjustedDeadline(tournament.current_group_round_deadline, tournament)
      : tournament
        ? calculatePausedAdjustedDeadline(tournament.current_bracket_round_deadline, tournament)
        : null;
  const deadlineAt = (roundDeadline ?? fallbackDeadline)?.toISOString() ?? null;
  const timerLabel = match.group_id ? "Group round deadline" : "Bracket round deadline";

  if (
    reportsMismatch &&
    ownReport &&
    ownReport.confirmation_state !== "confirmed_current"
  ) {
    return {
      priority: 100,
      title: "Confirm or update your report",
      body: "Reports do not match. Review your winner and score answer.",
      deadlineAt,
      href: `/matches/${match.id}`,
      timerLabel,
    };
  }

  if (match.status === "in_game" && !ownReport) {
    return {
      priority: 90,
      title: "Report your match result",
      body: "Your match is in progress. Report the winner and score after the game ends.",
      deadlineAt,
      href: `/matches/${match.id}`,
      timerLabel,
    };
  }

  if (
    match.status === "awaiting_host_setup" &&
    match.host_user_id === userId &&
    !match.game_created_at
  ) {
    return {
      priority: 80,
      title: "Create the match lobby",
      body: "You are host. Create the lobby, then mark Match Created.",
      deadlineAt: match.setup_deadline_at ?? deadlineAt,
      href: `/matches/${match.id}`,
      timerLabel: match.setup_deadline_at ? "Setup deadline" : timerLabel,
    };
  }

  if (
    ["assigned", "check_in_open"].includes(match.status) &&
    !ownCheckIn &&
    match.player_one_id &&
    match.player_two_id
  ) {
    return {
      priority: 70,
      title: "Check in for your match",
      body: "Your match room is ready for player check-in.",
      deadlineAt,
      href: `/matches/${match.id}`,
      timerLabel: "Match check-in before round deadline",
    };
  }

  return null;
}

export async function loadActiveAction(
  supabase: AppSupabaseClient,
  userId: string,
  roles: RoleState,
) {
  const actions: ActiveAction[] = [];

  const { data: registrations, error: registrationsError } = await supabase
    .from("tournament_registrations")
    .select("*")
    .eq("user_id", userId)
    .neq("status", "withdrawn");

  if (registrationsError) {
    throw registrationsError;
  }

  const tournamentIds = ((registrations ?? []) as TournamentRegistrationRow[]).map(
    (registration) => registration.tournament_id,
  );

  if (tournamentIds.length > 0) {
    const [tournamentsResult, checkInsResult] = await Promise.all([
      supabase.from("tournaments").select("*").in("id", tournamentIds),
      supabase
        .from("tournament_check_ins")
        .select("*")
        .eq("user_id", userId)
        .in("tournament_id", tournamentIds),
    ]);

    if (tournamentsResult.error) throw tournamentsResult.error;
    if (checkInsResult.error) throw checkInsResult.error;

    const ownTournamentCheckIns = (checkInsResult.data ?? []) as TournamentCheckInRow[];
    for (const tournament of (tournamentsResult.data ?? []) as TournamentRow[]) {
      const hasCheckedIn = ownTournamentCheckIns.some(
        (checkIn) => checkIn.tournament_id === tournament.id,
      );

      if (tournament.status === "check_in" && !hasCheckedIn) {
        const checkInDeadline = getCheckInDeadline(tournament);
        const replacementDeadline = getReplacementDeadline(tournament);
        const registration = ((registrations ?? []) as TournamentRegistrationRow[]).find(
          (row) => row.tournament_id === tournament.id,
        );
        const registrationStatus = registration?.status;
        const canUseTournamentCheckIn = Boolean(
          registrationStatus &&
            !["rejected", "excluded", "missed_check_in", "withdrawn"].includes(registrationStatus),
        );
        const replacementActive = Boolean(
          replacementDeadline &&
            checkInDeadline &&
            checkInDeadline.getTime() <= Date.now() &&
            replacementDeadline.getTime() > Date.now() &&
            registrationStatus &&
            !["active", "accepted", "checked_in", "pending", "rejected", "excluded", "replaced", "withdrawn"].includes(
              registrationStatus,
            ),
        );

        if (!canUseTournamentCheckIn && !replacementActive) {
          continue;
        }

        actions.push({
          body: replacementActive
            ? `${tournament.name} has replacement spots open if capacity remains.`
            : `${tournament.name} is waiting for your check-in.`,
          deadlineAt: (replacementActive ? replacementDeadline : checkInDeadline)?.toISOString() ?? null,
          href: `/tournaments/${tournament.id}`,
          priority: replacementActive ? 65 : 60,
          timerLabel: replacementActive ? "Replacement window" : "Tournament check-in",
          title: replacementActive ? "Replacement window is open" : "Tournament check-in is open",
        });
      }
    }
  }

  const { data: matches, error: matchesError } = await supabase
    .from("matches")
    .select("*")
    .or(`player_one_id.eq.${userId},player_two_id.eq.${userId}`)
    .in("status", ["assigned", "check_in_open", "awaiting_host_setup", "in_game", "result_reported"]);

  if (matchesError) {
    throw matchesError;
  }

  const matchRows = (matches ?? []) as MatchRow[];
  const matchIds = matchRows.map((match) => match.id);

  if (matchIds.length > 0) {
    const matchTournamentIds = Array.from(new Set(matchRows.map((match) => match.tournament_id)));
    const matchRoundIds = Array.from(new Set(matchRows.map((match) => match.round_id).filter(Boolean) as string[]));
    const [checkInsResult, reportsResult, matchTournamentsResult, matchRoundsResult] = await Promise.all([
      supabase.from("match_check_ins").select("*").in("match_id", matchIds),
      supabase.from("match_reports").select("*").in("match_id", matchIds),
      supabase.from("tournaments").select("*").in("id", matchTournamentIds),
      matchRoundIds.length > 0
        ? supabase.from("tournament_rounds").select("*").in("id", matchRoundIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (checkInsResult.error) throw checkInsResult.error;
    if (reportsResult.error) throw reportsResult.error;
    if (matchTournamentsResult.error) throw matchTournamentsResult.error;
    if (matchRoundsResult.error) throw matchRoundsResult.error;

    const tournamentsById = ((matchTournamentsResult.data ?? []) as TournamentRow[]).reduce<
      Record<string, TournamentRow>
    >((byId, tournament) => {
      byId[tournament.id] = tournament;
      return byId;
    }, {});
    const roundsById = ((matchRoundsResult.data ?? []) as TournamentRoundRow[]).reduce<
      Record<string, TournamentRoundRow>
    >((byId, round) => {
      byId[round.id] = round;
      return byId;
    }, {});

    for (const match of matchRows) {
      const action = buildMatchAction(
        match,
        (checkInsResult.data ?? []) as MatchCheckInRow[],
        (reportsResult.data ?? []) as MatchReportRow[],
        userId,
        tournamentsById[match.tournament_id] ?? null,
        match.round_id ? roundsById[match.round_id] ?? null : null,
      );

      if (action) {
        actions.push(action);
      }
    }
  }

  if (roles.isAdmin) {
    const { data: reviewMatches, error: reviewError } = await supabase
      .from("matches")
      .select("id")
      .in("status", ["disputed", "needs_admin"])
      .limit(1);

    if (reviewError) {
      throw reviewError;
    }

    const reviewMatch = reviewMatches?.[0];
    if (reviewMatch) {
      actions.push({
        body: "A match is waiting for staff resolution.",
        deadlineAt: null,
        href: `/matches/${reviewMatch.id}`,
        priority: 95,
        timerLabel: null,
        title: "Organizer review needed",
      });
    }
  } else if (roles.isOrganizer) {
    const { data: managedRows, error: managedError } = await supabase
      .from("tournament_organizers")
      .select("tournament_id")
      .eq("user_id", userId);

    if (managedError) {
      throw managedError;
    }

    const managedTournamentIds = (managedRows ?? []).map((row) => row.tournament_id);
    if (managedTournamentIds.length > 0) {
      const { data: reviewMatches, error: reviewError } = await supabase
        .from("matches")
        .select("id")
        .in("tournament_id", managedTournamentIds)
        .in("status", ["disputed", "needs_admin"])
        .limit(1);

      if (reviewError) {
        throw reviewError;
      }

      const reviewMatch = reviewMatches?.[0];
      if (reviewMatch) {
        actions.push({
          body: "A match is waiting for staff resolution.",
          deadlineAt: null,
          href: `/matches/${reviewMatch.id}`,
          priority: 95,
          timerLabel: null,
          title: "Organizer review needed",
        });
      }
    }
  }

  return actions.sort((left, right) => right.priority - left.priority)[0] ?? null;
}
