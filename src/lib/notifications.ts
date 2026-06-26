import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { MatchCheckInRow, MatchReportRow, MatchRow, TournamentCheckInRow, TournamentRegistrationRow, TournamentRow } from "@/lib/tournaments";
import type { RoleState } from "@/lib/roles";

export type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];
export type AppSupabaseClient = SupabaseClient<Database>;

export const liveRefreshIntervalMs = 12_000;

export function getUnreadCount(notifications: Pick<NotificationRow, "read_at">[]) {
  return notifications.filter((notification) => !notification.read_at).length;
}

export type ActiveAction = {
  priority: number;
  title: string;
  body: string;
  href: string;
};

function buildMatchAction(
  match: MatchRow,
  checkIns: MatchCheckInRow[],
  reports: MatchReportRow[],
  userId: string,
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
    new Set(matchReports.map((report) => report.reported_winner_id)).size > 1;

  if (
    reportsMismatch &&
    ownReport &&
    ownReport.confirmation_state !== "confirmed_current"
  ) {
    return {
      priority: 100,
      title: "Confirm or update your report",
      body: "Reports do not match. Review your winner answer.",
      href: `/matches/${match.id}`,
    };
  }

  if (match.status === "in_game" && !ownReport) {
    return {
      priority: 90,
      title: "Report your match result",
      body: "Your match is in progress. Report the winner after the game ends.",
      href: `/matches/${match.id}`,
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
      href: `/matches/${match.id}`,
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
      href: `/matches/${match.id}`,
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
        actions.push({
          priority: 60,
          title: "Tournament check-in is open",
          body: `${tournament.name} is waiting for your check-in.`,
          href: `/tournaments/${tournament.id}`,
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
    const [checkInsResult, reportsResult] = await Promise.all([
      supabase.from("match_check_ins").select("*").in("match_id", matchIds),
      supabase.from("match_reports").select("*").in("match_id", matchIds),
    ]);

    if (checkInsResult.error) throw checkInsResult.error;
    if (reportsResult.error) throw reportsResult.error;

    for (const match of matchRows) {
      const action = buildMatchAction(
        match,
        (checkInsResult.data ?? []) as MatchCheckInRow[],
        (reportsResult.data ?? []) as MatchReportRow[],
        userId,
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
        priority: 95,
        title: "Organizer review needed",
        body: "A match is waiting for staff resolution.",
        href: `/matches/${reviewMatch.id}`,
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
          priority: 95,
          title: "Organizer review needed",
          body: "A match is waiting for staff resolution.",
          href: `/matches/${reviewMatch.id}`,
        });
      }
    }
  }

  return actions.sort((left, right) => right.priority - left.priority)[0] ?? null;
}
