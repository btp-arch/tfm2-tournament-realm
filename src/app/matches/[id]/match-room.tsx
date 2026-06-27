"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { ErrorState, LoadingState, MatchStatusBadge } from "@/components/ui";
import { formatError, logError } from "@/lib/errors";
import {
  describeCheckInStatus,
  describeEvent,
  getActionMessage,
  getCurrentStepLabel,
  getGuestId,
  getMatchLabel,
  getMatchSlotFallback,
  getNonPlayableMatchMessage,
  getOpponentId,
  getProfileName,
  getReportConfirmationLabel,
  getReportedScoreLabel,
  getReportedWinnerName,
  doMatchReportsMismatch,
  isMatchBye,
  isMatchWaiting,
  isPlayableMatch,
  type PublicProfile,
} from "@/lib/match-rooms";
import { ensureProfile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  formatDateTime,
  formatMatchFinalScore,
  formatSeriesScore,
  getValidScoresForMatchFormat,
  matchEvidenceTypeLabels,
  matchFormatLabels,
  matchResolutionLabels,
  matchStatusLabels,
  validateSeriesScore,
  type DisputeRow,
  type MatchEvidenceRow,
  type MatchEvidenceType,
  type MatchCheckInRow,
  type MatchEventRow,
  type MatchReportRow,
  type MatchResolutionAction,
  type MatchRow,
  type TournamentRoundRow,
  type TournamentRow,
} from "@/lib/tournaments";

type SavingAction =
  | "check-in"
  | "game-created"
  | "reset"
  | "assign-player-one"
  | "assign-player-two"
  | "report"
  | "confirm-report"
  | "upload-evidence"
  | "resolve"
  | null;

const evidenceTypes: MatchEvidenceType[] = [
  "result_screen",
  "lobby_setup",
  "no_show",
  "disconnect",
  "chat_proof",
  "other",
];

const imageMimeTypes = ["image/png", "image/jpeg", "image/webp"];
const maxEvidenceFileSize = 5 * 1024 * 1024;
const maxEvidenceUploads = 3;

function getEvidenceObjectPath(filePath: string) {
  return filePath.startsWith("match-evidence/")
    ? filePath.slice("match-evidence/".length)
    : filePath;
}

function getSafeFileName(file: File) {
  return file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

function getEvidenceExpirationIso() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  return expiresAt.toISOString();
}

function parseScoreKey(scoreKey: string) {
  const [winnerScoreText, loserScoreText] = scoreKey.split("-");
  const winnerScore = Number(winnerScoreText);
  const loserScore = Number(loserScoreText);

  return Number.isInteger(winnerScore) && Number.isInteger(loserScore)
    ? { winnerScore, loserScore }
    : null;
}

function PlayerProfileLink({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string | null;
}) {
  if (!userId) {
    return <>{children}</>;
  }

  return <Link href={`/players/${userId}`}>{children}</Link>;
}

export function MatchRoom({ matchId }: { matchId: string }) {
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [tournament, setTournament] = useState<TournamentRow | null>(null);
  const [round, setRound] = useState<TournamentRoundRow | null>(null);
  const [checkIns, setCheckIns] = useState<MatchCheckInRow[]>([]);
  const [events, setEvents] = useState<MatchEventRow[]>([]);
  const [reports, setReports] = useState<MatchReportRow[]>([]);
  const [evidence, setEvidence] = useState<MatchEvidenceRow[]>([]);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [profileMap, setProfileMap] = useState<Record<string, PublicProfile>>({});
  const [canManageMatch, setCanManageMatch] = useState(false);
  const [reportWinnerId, setReportWinnerId] = useState("");
  const [reportScoreKey, setReportScoreKey] = useState("");
  const [reportNotes, setReportNotes] = useState("");
  const [evidenceType, setEvidenceType] = useState<MatchEvidenceType>("result_screen");
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [evidenceNotes, setEvidenceNotes] = useState("");
  const [resolutionAction, setResolutionAction] = useState<MatchResolutionAction>("confirm_winner");
  const [resolutionWinnerId, setResolutionWinnerId] = useState("");
  const [resolutionScoreKey, setResolutionScoreKey] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingAction, setSavingAction] = useState<SavingAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const loadMatch = useCallback(async () => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      const currentUser = authData.user;
      let loadedRoles = emptyRoleState;

      if (currentUser) {
        const [, currentRoles] = await Promise.all([
          ensureProfile(supabase, currentUser),
          getCurrentUserRoles(supabase),
        ]);
        loadedRoles = currentRoles;
      }

      const { data: loadedMatch, error: matchError } = await supabase
        .from("matches")
        .select("*")
        .eq("id", matchId)
        .maybeSingle();

      if (matchError) {
        throw matchError;
      }

      if (!loadedMatch) {
        setUser(currentUser);
        setRoles(loadedRoles);
        setMatch(null);
        setTournament(null);
        return;
      }

      const [
        tournamentResult,
        roundResult,
        checkInsResult,
        eventsResult,
        reportsResult,
        evidenceResult,
        disputesResult,
        organizerAccessResult,
      ] = await Promise.all([
        supabase
          .from("tournaments")
          .select("*")
          .eq("id", loadedMatch.tournament_id)
          .maybeSingle(),
        loadedMatch.round_id
          ? supabase
              .from("tournament_rounds")
              .select("*")
              .eq("id", loadedMatch.round_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        currentUser
          ? supabase
              .from("match_check_ins")
              .select("*")
              .eq("match_id", loadedMatch.id)
              .order("checked_in_at", { ascending: true })
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from("match_events")
          .select("*")
          .eq("match_id", loadedMatch.id)
          .order("created_at", { ascending: true }),
        currentUser
          ? supabase
              .from("match_reports")
              .select("*")
              .eq("match_id", loadedMatch.id)
              .order("created_at", { ascending: true })
          : Promise.resolve({ data: [], error: null }),
        currentUser
          ? supabase
              .from("match_evidence")
              .select("*")
              .eq("match_id", loadedMatch.id)
              .order("created_at", { ascending: true })
          : Promise.resolve({ data: [], error: null }),
        currentUser
          ? supabase
              .from("disputes")
              .select("*")
              .eq("match_id", loadedMatch.id)
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        currentUser
          ? supabase
              .from("tournament_organizers")
              .select("tournament_id")
              .eq("tournament_id", loadedMatch.tournament_id)
              .eq("user_id", currentUser.id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (tournamentResult.error) throw tournamentResult.error;
      if (roundResult.error) throw roundResult.error;
      if (checkInsResult.error) throw checkInsResult.error;
      if (eventsResult.error) throw eventsResult.error;
      if (reportsResult.error) throw reportsResult.error;
      if (evidenceResult.error) throw evidenceResult.error;
      if (disputesResult.error) throw disputesResult.error;
      if (organizerAccessResult.error) throw organizerAccessResult.error;

      const loadedTournament = tournamentResult.data as TournamentRow | null;
      const loadedReports = (reportsResult.data ?? []) as MatchReportRow[];
      const loadedEvidence = (evidenceResult.data ?? []) as MatchEvidenceRow[];
      const loadedDisputes = (disputesResult.data ?? []) as DisputeRow[];
      const managed =
        Boolean(currentUser && loadedTournament) &&
        (loadedRoles.isAdmin ||
          loadedTournament?.created_by === currentUser?.id ||
          Boolean(organizerAccessResult.data));
      const profileIds = Array.from(
        new Set(
          [
            loadedTournament?.created_by,
            loadedMatch.player_one_id,
            loadedMatch.player_two_id,
            loadedMatch.host_user_id,
            loadedMatch.winner_id,
            loadedMatch.finalized_by,
            ...loadedReports.flatMap((report) => [
              report.reporter_id,
              report.reported_winner_id,
            ]),
            ...loadedEvidence.map((item) => item.uploaded_by),
            ...loadedDisputes.flatMap((dispute) => [
              dispute.opened_by,
              dispute.assigned_to,
              dispute.resolved_by,
              dispute.resolution_winner_id,
            ]),
            ...(checkInsResult.data ?? []).flatMap((checkIn) => [
              checkIn.user_id,
              checkIn.checked_in_by,
            ]),
            ...(eventsResult.data ?? []).map((event) => event.actor_id),
          ].filter(Boolean) as string[],
        ),
      );
      let loadedProfileMap: Record<string, PublicProfile> = {};

      if (profileIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from("public_profiles")
          .select("id, display_name")
          .in("id", profileIds);

        if (profilesError) {
          throw profilesError;
        }

        loadedProfileMap = (profiles as PublicProfile[]).reduce<Record<string, PublicProfile>>(
          (profilesById, profile) => {
            if (profile.id) {
              profilesById[profile.id] = profile;
            }

            return profilesById;
          },
          {},
        );
      }

      const signedEvidenceUrls: Record<string, string> = {};
      if (loadedEvidence.length > 0) {
        await Promise.all(
          loadedEvidence.map(async (item) => {
            const { data: signedData } = await supabase.storage
              .from("match-evidence")
              .createSignedUrl(getEvidenceObjectPath(item.file_path), 60 * 60);

            if (signedData?.signedUrl) {
              signedEvidenceUrls[item.id] = signedData.signedUrl;
            }
          }),
        );
      }

      setUser(currentUser);
      setRoles(loadedRoles);
      setMatch(loadedMatch);
      setTournament(loadedTournament);
      setRound(roundResult.data as TournamentRoundRow | null);
      setCheckIns((checkInsResult.data ?? []) as MatchCheckInRow[]);
      setEvents((eventsResult.data ?? []) as MatchEventRow[]);
      setReports(loadedReports);
      setEvidence(loadedEvidence);
      setDisputes(loadedDisputes);
      setEvidenceUrls(signedEvidenceUrls);
      setProfileMap(loadedProfileMap);
      setCanManageMatch(managed);
      setLastUpdatedAt(new Date());

      const ownLoadedReport = currentUser
        ? loadedReports.find((report) => report.reporter_id === currentUser.id)
        : null;
      if (ownLoadedReport) {
        setReportWinnerId(ownLoadedReport.reported_winner_id);
        setReportScoreKey(
          ownLoadedReport.reported_winner_score !== null &&
            ownLoadedReport.reported_loser_score !== null
            ? `${ownLoadedReport.reported_winner_score}-${ownLoadedReport.reported_loser_score}`
            : "",
        );
        setReportNotes(ownLoadedReport.notes ?? "");
      } else if (loadedMatch.player_one_id) {
        setReportWinnerId(loadedMatch.player_one_id);
      }
      const defaultScore = getValidScoresForMatchFormat(loadedMatch.format)[0];
      if (!ownLoadedReport && defaultScore) {
        setReportScoreKey(formatSeriesScore(defaultScore) ?? "");
      }
      setResolutionWinnerId(loadedMatch.winner_id ?? loadedMatch.player_one_id ?? "");
      setResolutionScoreKey(
        loadedMatch.final_winner_score !== null && loadedMatch.final_loser_score !== null
          ? `${loadedMatch.final_winner_score}-${loadedMatch.final_loser_score}`
          : formatSeriesScore(defaultScore) ?? "",
      );
    } catch (caughtError) {
      logError("Match room load failed.", caughtError);
      setError(formatError(caughtError, "Unable to load match room."));
    } finally {
      setIsLoading(false);
    }
  }, [matchId, supabase]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadMatch();
    }, 0);
    const intervalId = window.setInterval(() => {
      void loadMatch();
    }, 12_000);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [loadMatch]);

  const playerOneCheckIn = match
    ? checkIns.find((checkIn) => checkIn.user_id === match.player_one_id) ?? null
    : null;
  const playerTwoCheckIn = match
    ? checkIns.find((checkIn) => checkIn.user_id === match.player_two_id) ?? null
    : null;
  const ownCheckIn =
    user && match ? checkIns.find((checkIn) => checkIn.user_id === user.id) ?? null : null;
  const opponentId = match ? getOpponentId(match, user?.id ?? null) : null;
  const opponentCheckIn = opponentId
    ? checkIns.find((checkIn) => checkIn.user_id === opponentId) ?? null
    : null;
  const isParticipant = Boolean(
    user && match && [match.player_one_id, match.player_two_id].includes(user.id),
  );
  const hostName = match ? getProfileName(profileMap, match.host_user_id) : null;
  const guestId = match ? getGuestId(match) : null;
  const guestName = getProfileName(profileMap, guestId);
  const playerOneName = match ? getProfileName(profileMap, match.player_one_id) ?? "Player A" : "Player A";
  const playerTwoName = match ? getProfileName(profileMap, match.player_two_id) ?? "Player B" : "Player B";
  const scoreOptions = match ? getValidScoresForMatchFormat(match.format) : [];
  const selectedReportScore = parseScoreKey(reportScoreKey);
  const selectedResolutionScore = parseScoreKey(resolutionScoreKey);
  const finalScoreLabel = match ? formatMatchFinalScore(match) : null;
  const playableMatch = match ? isPlayableMatch(match) : false;
  const nonPlayableMessage = match ? getNonPlayableMatchMessage(match, profileMap) : null;
  const lobbyName = guestName ?? "Opponent display name";
  const playerOneReport = match
    ? reports.find((report) => report.reporter_id === match.player_one_id) ?? null
    : null;
  const playerTwoReport = match
    ? reports.find((report) => report.reporter_id === match.player_two_id) ?? null
    : null;
  const ownReport =
    user && match ? reports.find((report) => report.reporter_id === user.id) ?? null : null;
  const openDispute =
    disputes.find((dispute) => dispute.status === "open" || dispute.status === "under_review") ??
    null;
  const reportsMismatch = doMatchReportsMismatch(playerOneReport, playerTwoReport);
  const bothReportsSubmitted = Boolean(playerOneReport && playerTwoReport);
  const waitingForOpponentReport = Boolean(ownReport && !bothReportsSubmitted);
  const ownReportEvidence = ownReport
    ? evidence.filter((item) => item.match_report_id === ownReport.id)
    : [];
  const canReportResult = Boolean(
    match &&
      playableMatch &&
      isParticipant &&
      match.player_one_id &&
      match.player_two_id &&
      (match.status === "in_game" || match.status === "result_reported"),
  );
  const canConfirmMismatch = Boolean(
    canReportResult &&
      ownReport &&
      reportsMismatch &&
      ownReport.confirmation_state !== "confirmed_current",
  );
  const reviewOpen = Boolean(
    openDispute || match?.status === "disputed" || match?.status === "needs_admin",
  );
  const matchPastSetup = Boolean(
    match &&
      (match.status === "in_game" ||
        match.status === "result_reported" ||
        match.status === "disputed" ||
        match.status === "needs_admin" ||
        match.status === "replay_required" ||
        match.status === "confirmed" ||
        match.status === "finalized" ||
        match.winner_id ||
        reports.length > 0 ||
        openDispute),
  );
  const setupStatusMessage = matchPastSetup
    ? "Match is past setup."
    : match?.game_created_at
      ? "Lobby setup is complete."
      : "Lobby setup is not complete yet.";
  const showEvidenceReview = Boolean(reviewOpen || canManageMatch);
  const evidenceUploadsRemaining = Math.max(0, maxEvidenceUploads - ownReportEvidence.length);
  const canUploadEvidence = Boolean(
    isParticipant && ownReport && showEvidenceReview && evidenceUploadsRemaining > 0,
  );
  const actionMessage = match
    ? getActionMessage(
        match,
        user?.id ?? null,
        isParticipant,
        canManageMatch,
        ownCheckIn,
        opponentCheckIn,
      )
    : null;
  const currentStepLabel = match
    ? getCurrentStepLabel({
        match,
        userId: user?.id ?? null,
        isParticipant,
        ownCheckIn,
        opponentCheckIn,
        ownReport,
        bothReportsSubmitted,
        reportsMismatch,
        reviewOpen,
      })
    : null;
  const canUsePlayerActions = Boolean(
    match &&
      playableMatch &&
      user &&
      !isMatchBye(match) &&
      !isMatchWaiting(match) &&
      (isParticipant || canManageMatch),
  );
  const canCheckIn = Boolean(
    canUsePlayerActions &&
      isParticipant &&
      !ownCheckIn &&
      !matchPastSetup &&
      (match?.status === "assigned" || match?.status === "check_in_open"),
  );
  const canMarkGameCreated = Boolean(
    canUsePlayerActions &&
      match?.host_user_id &&
      match.status === "awaiting_host_setup" &&
      !match.game_created_at &&
      !matchPastSetup &&
      (user?.id === match.host_user_id || canManageMatch),
  );
  const orderedEvents = useMemo(() => events.slice().reverse(), [events]);

  async function runMatchAction(action: Exclude<SavingAction, null>, request: () => Promise<unknown>, successMessage: string) {
    setSavingAction(action);
    setNotice(null);
    setError(null);

    try {
      await request();
      setNotice(successMessage);
      await loadMatch();
    } catch (caughtError) {
      logError("Match room action failed.", caughtError);
      setError(formatError(caughtError, "Unable to update match room."));
    } finally {
      setSavingAction(null);
    }
  }

  async function checkInForMatch() {
    if (!match || !canCheckIn) {
      return;
    }

    await runMatchAction(
      "check-in",
      async () => {
        const { error: rpcError } = await supabase.rpc("check_in_for_match", {
          target_match: match.id,
        });

        if (rpcError) {
          throw rpcError;
        }
      },
      "Match check-in recorded.",
    );
  }

  async function markGameCreated() {
    if (!match || !canMarkGameCreated) {
      return;
    }

    await runMatchAction(
      "game-created",
      async () => {
        const { error: rpcError } = await supabase.rpc("mark_match_game_created", {
          target_match: match.id,
        });

        if (rpcError) {
          throw rpcError;
        }
      },
      "Match created. Match is in game.",
    );
  }

  async function resetMatchRoom() {
    if (!match || !canManageMatch) {
      return;
    }

    const confirmed = window.confirm("Reset this match room to check-in/open state?");
    if (!confirmed) {
      return;
    }

    await runMatchAction(
      "reset",
      async () => {
        const { error: rpcError } = await supabase.rpc("reset_match_room", {
          target_match: match.id,
        });

        if (rpcError) {
          throw rpcError;
        }
      },
      "Match room reset.",
    );
  }

  async function assignHost(userId: string, action: "assign-player-one" | "assign-player-two") {
    if (!match || !canManageMatch) {
      return;
    }

    await runMatchAction(
      action,
      async () => {
        const { error: rpcError } = await supabase.rpc("assign_match_host", {
          target_match: match.id,
          selected_host: userId,
        });

        if (rpcError) {
          throw rpcError;
        }
      },
      "Host assignment updated.",
    );
  }

  async function uploadEvidenceFiles(report: MatchReportRow, files: File[]) {
    if (!match || !user || files.length === 0) {
      return;
    }

    const existingCount = evidence.filter((item) => item.match_report_id === report.id).length;
    if (existingCount + files.length > maxEvidenceUploads) {
      throw new Error("Each player report can have at most 3 evidence uploads.");
    }

    for (const file of files) {
      if (!imageMimeTypes.includes(file.type)) {
        throw new Error("Evidence must be a PNG, JPG/JPEG, or WEBP image.");
      }

      if (file.size > maxEvidenceFileSize) {
        throw new Error("Evidence images must be 5 MB or smaller.");
      }

      const safeName = getSafeFileName(file);
      const objectPath = `${match.id}/${user.id}/${report.id}/${crypto.randomUUID()}-${safeName}`;
      const filePath = `match-evidence/${objectPath}`;
      const { error: uploadError } = await supabase.storage
        .from("match-evidence")
        .upload(objectPath, file, {
          contentType: file.type,
          upsert: false,
        });

      if (uploadError) {
        throw uploadError;
      }

      const { error: evidenceError } = await supabase.from("match_evidence").insert({
        match_id: match.id,
        match_report_id: report.id,
        uploaded_by: user.id,
        storage_path: filePath,
        file_path: filePath,
        file_name: file.name,
        mime_type: file.type,
        file_size_bytes: file.size,
        evidence_type: evidenceType,
        notes: evidenceNotes.trim() || null,
        expires_at: getEvidenceExpirationIso(),
      });

      if (evidenceError) {
        throw evidenceError;
      }
    }
  }

  async function submitResultReport() {
    if (!match || !canReportResult || !reportWinnerId) {
      return;
    }

    if (
      !selectedReportScore ||
      !validateSeriesScore(match.format, selectedReportScore.winnerScore, selectedReportScore.loserScore)
    ) {
      setError("Select a valid score for this match format.");
      return;
    }

    await runMatchAction(
      "report",
      async () => {
        const { error: rpcError } = await supabase.rpc("submit_match_report", {
          target_match: match.id,
          reported_winner: reportWinnerId,
          reported_winner_score: selectedReportScore.winnerScore,
          reported_loser_score: selectedReportScore.loserScore,
          report_notes: reportNotes.trim() || undefined,
        });

        if (rpcError) {
          throw rpcError;
        }
      },
      "Result report submitted.",
    );
  }

  async function uploadReviewEvidence() {
    if (!match || !ownReport || evidenceFiles.length === 0) {
      return;
    }

    await runMatchAction(
      "upload-evidence",
      async () => {
        await uploadEvidenceFiles(ownReport, evidenceFiles.slice(0, maxEvidenceUploads));
      },
      "Evidence uploaded for review.",
    );
    setEvidenceFiles([]);
    setEvidenceNotes("");
  }

  async function confirmCurrentReport() {
    if (!match || !canConfirmMismatch) {
      return;
    }

    await runMatchAction(
      "confirm-report",
      async () => {
        const { error: rpcError } = await supabase.rpc("confirm_match_report", {
          target_match: match.id,
        });

        if (rpcError) {
          throw rpcError;
        }
      },
      "Report confirmation saved.",
    );
  }

  async function resolveDispute() {
    if (!match || !canManageMatch) {
      return;
    }

    if (
      resolutionAction === "confirm_winner" &&
      (!selectedResolutionScore ||
        !validateSeriesScore(
          match.format,
          selectedResolutionScore.winnerScore,
          selectedResolutionScore.loserScore,
        ))
    ) {
      setError("Select a valid final score for this match format.");
      return;
    }

    await runMatchAction(
      "resolve",
      async () => {
        const { error: rpcError } = await supabase.rpc("resolve_match_dispute", {
          target_match: match.id,
          resolution_action: resolutionAction,
          selected_winner: resolutionAction === "confirm_winner" ? resolutionWinnerId : undefined,
          selected_winner_score:
            resolutionAction === "confirm_winner" ? selectedResolutionScore?.winnerScore : undefined,
          selected_loser_score:
            resolutionAction === "confirm_winner" ? selectedResolutionScore?.loserScore : undefined,
          resolution_notes: resolutionNote.trim() || undefined,
        });

        if (rpcError) {
          throw rpcError;
        }
      },
      "Match review resolved.",
    );
  }

  if (isLoading) {
    return <LoadingState message="Loading match room..." />;
  }

  if (error && !match) {
    return <ErrorState message={error} />;
  }

  if (!match || !tournament) {
    return (
      <section className="card">
        <h1>Match Not Found</h1>
        <p className="muted">This match is unavailable or you do not have access to it.</p>
      </section>
    );
  }

  if (!playableMatch) {
    const playerOneSlot = match.player_one_id ? (
      <PlayerProfileLink userId={match.player_one_id}>{playerOneName}</PlayerProfileLink>
    ) : (
      getMatchSlotFallback(match, "one")
    );
    const playerTwoSlot = match.player_two_id ? (
      <PlayerProfileLink userId={match.player_two_id}>{playerTwoName}</PlayerProfileLink>
    ) : (
      getMatchSlotFallback(match, "two")
    );

    return (
      <>
        <div className="section-heading">
          <div>
            <MatchStatusBadge>{matchStatusLabels[match.status]}</MatchStatusBadge>
            <h1>{getMatchLabel(match)}</h1>
            <p className="muted">
              <Link href={`/tournaments/${tournament.id}`}>{tournament.name}</Link>
              {round ? `, ${round.name}` : `, Round ${match.round_number}`}
            </p>
          </div>
          <Link className="button secondary-button button-link" href={`/tournaments/${tournament.id}`}>
            Back To Bracket
          </Link>
        </div>

        {notice ? <p className="notice">{notice}</p> : null}
        {error ? <p className="error">{error}</p> : null}

        <section className="card">
          <span className="badge">No Match Room Action</span>
          <h2>{nonPlayableMessage ?? "No playable match is available yet."}</h2>
          <p className="muted">
            BYE and TBD bracket placeholders do not use check-in, lobby setup, result reporting, disputes, or evidence uploads.
          </p>
          <dl className="meta-grid">
            <div>
              <dt>Player A Slot</dt>
              <dd>{playerOneSlot}</dd>
            </div>
            <div>
              <dt>Player B Slot</dt>
              <dd>{playerTwoSlot}</dd>
            </div>
            <div>
              <dt>Match ID</dt>
              <dd className="mono-text">{match.id}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{matchStatusLabels[match.status]}</dd>
            </div>
            {match.winner_id ? (
              <div>
                <dt>Advancing Player</dt>
                <dd>
                  <PlayerProfileLink userId={match.winner_id}>
                    {getProfileName(profileMap, match.winner_id) ?? "Player"}
                  </PlayerProfileLink>
                </dd>
              </div>
            ) : null}
          </dl>
          {canManageMatch ? (
            <p className="muted">Staff context: raw status {match.status}.</p>
          ) : null}
        </section>
      </>
    );
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <MatchStatusBadge
            tone={
              match.status === "disputed" || match.status === "needs_admin"
                ? "danger"
                : match.status === "finalized" || match.status === "confirmed"
                  ? "gold"
                  : "action"
            }
          >
            {matchStatusLabels[match.status]}
          </MatchStatusBadge>
          <h1>{getMatchLabel(match)}</h1>
          <p className="muted">
            <Link href={`/tournaments/${tournament.id}`}>{tournament.name}</Link>
            {round ? `, ${round.name}` : `, Round ${match.round_number}`}
          </p>
        </div>
        <Link className="button secondary-button button-link" href={`/tournaments/${tournament.id}`}>
          Back To Bracket
        </Link>
      </div>

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <section className="card">
        <div className="section-heading">
          <div>
            <span className="badge">Current Step</span>
            <h2>{currentStepLabel}</h2>
            <p className="muted">{actionMessage}</p>
            <p className="muted">{setupStatusMessage}</p>
            {lastUpdatedAt ? (
              <p className="muted">Last updated {lastUpdatedAt.toLocaleTimeString()}.</p>
            ) : null}
          </div>
          {roles.isAdmin ? <span className="badge">Admin</span> : canManageMatch ? <span className="badge">Staff</span> : null}
        </div>

        {canUsePlayerActions ? (
          <div className="match-action-grid primary-actions">
            {isParticipant ? (
              <button
                className="button"
                disabled={!canCheckIn || savingAction === "check-in"}
                type="button"
                onClick={checkInForMatch}
              >
                {savingAction === "check-in" ? "Checking In..." : ownCheckIn ? "Checked In" : "Check In"}
              </button>
            ) : null}

            <button
              className="button"
              disabled={!canMarkGameCreated || savingAction === "game-created"}
              type="button"
              onClick={markGameCreated}
            >
              {savingAction === "game-created" ? "Saving..." : "Match Created"}
            </button>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>Match Summary</h2>
        <dl className="meta-grid">
          <div>
            <dt>Tournament</dt>
            <dd>{tournament.name}</dd>
          </div>
          <div>
            <dt>Round</dt>
            <dd>{round ? round.name : `Round ${match.round_number}`}</dd>
          </div>
          <div>
            <dt>Match ID</dt>
            <dd className="mono-text">{match.id}</dd>
          </div>
          <div>
            <dt>Player A</dt>
            <dd>
              <PlayerProfileLink userId={match.player_one_id}>{playerOneName}</PlayerProfileLink>
            </dd>
          </div>
          <div>
            <dt>Player B</dt>
            <dd>
              {match.player_two_id ? (
                <PlayerProfileLink userId={match.player_two_id}>{playerTwoName}</PlayerProfileLink>
              ) : (
                getProfileName(profileMap, match.player_two_id) ?? (isMatchBye(match) ? "BYE" : "TBD")
              )}
            </dd>
          </div>
          <div>
            <dt>BO Format</dt>
            <dd>{matchFormatLabels[match.format]}</dd>
          </div>
          <div>
            <dt>Final Score</dt>
            <dd>{finalScoreLabel ?? "Not finalized"}</dd>
          </div>
          <div>
            <dt>Player A Check-In</dt>
            <dd>
              {describeCheckInStatus(
                match.player_one_id,
                playerOneCheckIn,
                match,
                user?.id ?? null,
                canManageMatch,
              )}
            </dd>
          </div>
          <div>
            <dt>Player B Check-In</dt>
            <dd>
              {describeCheckInStatus(
                match.player_two_id,
                playerTwoCheckIn,
                match,
                user?.id ?? null,
                canManageMatch,
              )}
            </dd>
          </div>
          <div>
            <dt>Host</dt>
            <dd>
              {match.host_user_id ? (
                <PlayerProfileLink userId={match.host_user_id}>{hostName ?? "Player"}</PlayerProfileLink>
              ) : (
                "Not assigned"
              )}
            </dd>
          </div>
          <div>
            <dt>Host Side</dt>
            <dd>{match.host_user_id ? "Blue" : "Assigned with host"}</dd>
          </div>
          <div>
            <dt>Guest</dt>
            <dd>
              {guestId ? (
                <PlayerProfileLink userId={guestId}>{guestName ?? "Player"}</PlayerProfileLink>
              ) : (
                "Not assigned"
              )}
            </dd>
          </div>
          <div>
            <dt>Guest Side</dt>
            <dd>{guestId ? "Red" : "Assigned with guest"}</dd>
          </div>
          <div>
            <dt>Lobby Name</dt>
            <dd>{match.host_user_id ? lobbyName : "Use the guest/opponent display name after host is assigned"}</dd>
          </div>
          <div>
            <dt>Match Created</dt>
            <dd>{match.game_created_at ? formatDateTime(match.game_created_at) : "Not yet"}</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <h2>Lobby Instructions</h2>
        <div className="instruction-list">
          <p>Host: create a public friendly game in Teamfight Manager 2.</p>
          <p>Lobby name: {match.host_user_id ? lobbyName : "the opponent's Tournament Realm display name"}.</p>
          <p>Host side: Blue.</p>
          <p>Guest side: Red.</p>
          <p>Format: {matchFormatLabels[match.format]}.</p>
          <p>For BO3/BO5, if TFM2 gives the previous game loser side selection, follow the in-game rule instead of overriding it here.</p>
          <p>After creating the lobby, the host clicks Match Created.</p>
        </div>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Report Result</h2>
            <p className="muted">
              Each player chooses the winner. Matching reports finalize automatically; confirmed mismatches go to organizer review.
            </p>
          </div>
          {match.winner_id ? (
            <span className="badge">
              Winner:{" "}
              <PlayerProfileLink userId={match.winner_id}>
                {getProfileName(profileMap, match.winner_id) ?? "Player"}
              </PlayerProfileLink>
            </span>
          ) : null}
        </div>

        {isMatchBye(match) || isMatchWaiting(match) ? (
          <p className="muted">This match does not need result reporting yet.</p>
        ) : match.status === "finalized" || match.status === "confirmed" ? (
          <p className="notice">
            Result confirmed.{" "}
            {match.result_type === "forfeit" && match.winner_id
              ? `${getProfileName(profileMap, match.winner_id) ?? "Winner"} won by forfeit.`
              : match.winner_id
              ? `${getProfileName(profileMap, match.winner_id) ?? "Winner"} advanced${finalScoreLabel ? ` ${finalScoreLabel}` : ""}.`
              : "No winner was advanced."}
          </p>
        ) : openDispute ? (
          <p className="error">A dispute is open for organizer review.</p>
        ) : reportsMismatch ? (
          <p className="error">Reports do not match on winner or score. Please confirm or change your report.</p>
        ) : waitingForOpponentReport ? (
          <p className="notice">Your report was submitted. Waiting for opponent report.</p>
        ) : match.status === "replay_required" ? (
          <p className="notice">Tournament staff required a replay. Use this room again after the replay.</p>
        ) : null}

        <dl className="meta-grid">
          <div>
            <dt>{playerOneName}</dt>
            <dd>
              {playerOneReport
                ? `${getReportedWinnerName(playerOneReport, profileMap) ?? "Player"} ${getReportedScoreLabel(playerOneReport) ?? "score pending"}, ${getReportConfirmationLabel(playerOneReport).toLowerCase()}`
                : "No report"}
            </dd>
          </div>
          <div>
            <dt>{playerTwoName}</dt>
            <dd>
              {playerTwoReport
                ? `${getReportedWinnerName(playerTwoReport, profileMap) ?? "Player"} ${getReportedScoreLabel(playerTwoReport) ?? "score pending"}, ${getReportConfirmationLabel(playerTwoReport).toLowerCase()}`
                : "No report"}
            </dd>
          </div>
        </dl>

        {isParticipant ? (
          <div className="result-panel">
            <div className="form-grid">
              <label htmlFor="reported-winner">
                Winner
                <select
                  id="reported-winner"
                  disabled={!canReportResult}
                  value={reportWinnerId}
                  onChange={(event) => setReportWinnerId(event.target.value)}
                >
                  {match.player_one_id ? (
                    <option value={match.player_one_id}>{playerOneName}</option>
                  ) : null}
                  {match.player_two_id ? (
                    <option value={match.player_two_id}>{playerTwoName}</option>
                  ) : null}
                </select>
              </label>
              <label htmlFor="reported-score">
                Score
                <select
                  id="reported-score"
                  disabled={!canReportResult}
                  value={reportScoreKey}
                  onChange={(event) => setReportScoreKey(event.target.value)}
                >
                  {scoreOptions.map((score) => {
                    const scoreLabel = formatSeriesScore(score) ?? "";

                    return (
                      <option key={scoreLabel} value={scoreLabel}>
                        {scoreLabel}
                      </option>
                    );
                  })}
                </select>
              </label>
            </div>

            <label className="wide-field" htmlFor="report-notes">
              Notes
              <textarea
                id="report-notes"
                disabled={!canReportResult}
                maxLength={1000}
                rows={3}
                value={reportNotes}
                onChange={(event) => setReportNotes(event.target.value)}
              />
            </label>

            <div className="match-action-grid">
              <button
                className="button"
                disabled={!canReportResult || !reportWinnerId || !reportScoreKey || savingAction === "report"}
                type="button"
                onClick={submitResultReport}
              >
                {savingAction === "report" ? "Submitting..." : ownReport ? "Update Report" : "Submit Report"}
              </button>
              {canConfirmMismatch ? (
                <button
                  className="button secondary-button"
                  disabled={savingAction === "confirm-report"}
                  type="button"
                  onClick={confirmCurrentReport}
                >
                  {savingAction === "confirm-report" ? "Confirming..." : "Confirm Current Report"}
                </button>
              ) : null}
            </div>

            {reportsMismatch ? (
              <p className="muted">
                Keep your answer if it is correct, or change the winner/score and submit again. If both players confirm different reports, organizer review opens.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="muted">Only match players can submit or confirm result reports.</p>
        )}

        {bothReportsSubmitted && !reportsMismatch && !match.winner_id ? (
          <p className="muted">Reports match and finalization is processing. Refresh if the winner is not shown.</p>
        ) : null}
      </section>

      {showEvidenceReview ? (
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Review Evidence</h2>
              <p className="muted">
                Evidence is only used for disputes or staff review. It is stored privately and shared only with match participants and staff.
              </p>
            </div>
            {openDispute ? <span className="badge">Dispute Open</span> : canManageMatch ? <span className="badge">Staff Review</span> : null}
          </div>

          {isParticipant ? (
            ownReport ? (
              <div className="result-panel">
                <div className="form-grid">
                  <label htmlFor="review-evidence-type">
                    Evidence Type
                    <select
                      id="review-evidence-type"
                      disabled={!canUploadEvidence}
                      value={evidenceType}
                      onChange={(event) => setEvidenceType(event.target.value as MatchEvidenceType)}
                    >
                      {evidenceTypes.map((type) => (
                        <option key={type} value={type}>
                          {matchEvidenceTypeLabels[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor="review-evidence-files">
                    Image Evidence
                    <input
                      accept="image/png,image/jpeg,image/webp"
                      disabled={!canUploadEvidence}
                      id="review-evidence-files"
                      multiple
                      type="file"
                      onChange={(event) =>
                        setEvidenceFiles(
                          Array.from(event.target.files ?? []).slice(0, evidenceUploadsRemaining),
                        )
                      }
                    />
                  </label>
                </div>
                <label className="wide-field" htmlFor="review-evidence-notes">
                  Evidence Notes
                  <textarea
                    id="review-evidence-notes"
                    disabled={!canUploadEvidence}
                    maxLength={1000}
                    rows={3}
                    value={evidenceNotes}
                    onChange={(event) => setEvidenceNotes(event.target.value)}
                  />
                </label>
                <p className="muted">
                  PNG, JPG/JPEG, or WEBP only. Max 5 MB each, 3 uploads per player report. You have {evidenceUploadsRemaining} upload{evidenceUploadsRemaining === 1 ? "" : "s"} remaining.
                </p>
                <div className="match-action-grid">
                  <button
                    className="button"
                    disabled={!canUploadEvidence || evidenceFiles.length === 0 || savingAction === "upload-evidence"}
                    type="button"
                    onClick={uploadReviewEvidence}
                  >
                    {savingAction === "upload-evidence" ? "Uploading..." : "Upload Evidence"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">Submit a result report before uploading review evidence.</p>
            )
          ) : null}

          {evidence.length > 0 ? (
            <div className="evidence-list">
              {evidence.map((item) => (
                <article className="evidence-row" key={item.id}>
                  <div>
                    <strong>{item.file_name}</strong>
                    <p className="muted">
                      {matchEvidenceTypeLabels[item.evidence_type as MatchEvidenceType] ?? "Evidence"} from{" "}
                      {getProfileName(profileMap, item.uploaded_by) ?? "Player"}
                    </p>
                    <p className="muted">
                      Expires {formatDateTime(item.expires_at)}
                      {item.retained_by_admin ? ", retained by admin" : ""}
                    </p>
                  </div>
                  {evidenceUrls[item.id] ? (
                    <a
                      className="button secondary-button button-link"
                      href={evidenceUrls[item.id]}
                      rel="noreferrer"
                      target="_blank"
                    >
                      View
                    </a>
                  ) : (
                    <span className="muted">No view link</span>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">No review evidence has been uploaded.</p>
          )}
        </section>
      ) : null}

      {canManageMatch ? (
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Organizer Review</h2>
              <p className="muted">
                Staff can resolve disputes, require a replay, or mark no contest when player reports need review.
              </p>
            </div>
          </div>

          <div className="management-actions">
            <div>
              <h3>Player Reports</h3>
              {openDispute ? (
                <p className="error">{openDispute.reason}</p>
              ) : reportsMismatch ? (
                <p className="muted">Reports mismatch, but both players have not confirmed different reports yet.</p>
              ) : bothReportsSubmitted ? (
                <p className="muted">Reports currently align or have already finalized.</p>
              ) : (
                <p className="muted">Waiting for both player reports.</p>
              )}
            </div>
          </div>
          <dl className="meta-grid">
            <div>
              <dt>{playerOneName}</dt>
              <dd>
                {playerOneReport
                  ? `${getReportedWinnerName(playerOneReport, profileMap) ?? "Player"} ${getReportedScoreLabel(playerOneReport) ?? "score pending"}; ${getReportConfirmationLabel(playerOneReport)}`
                  : "No report"}
              </dd>
            </div>
            <div>
              <dt>{playerTwoName}</dt>
              <dd>
                {playerTwoReport
                  ? `${getReportedWinnerName(playerTwoReport, profileMap) ?? "Player"} ${getReportedScoreLabel(playerTwoReport) ?? "score pending"}; ${getReportConfirmationLabel(playerTwoReport)}`
                  : "No report"}
              </dd>
            </div>
            <div>
              <dt>Raw Status</dt>
              <dd className="mono-text">{match.status}</dd>
            </div>
          </dl>

          <div className="form-grid">
            <label htmlFor="resolution-action">
              Resolution
              <select
                id="resolution-action"
                value={resolutionAction}
                onChange={(event) => setResolutionAction(event.target.value as MatchResolutionAction)}
              >
                {Object.entries(matchResolutionLabels).map(([action, label]) => (
                  <option key={action} value={action}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="resolution-winner">
              Winner
              <select
                id="resolution-winner"
                disabled={resolutionAction !== "confirm_winner"}
                value={resolutionWinnerId}
                onChange={(event) => setResolutionWinnerId(event.target.value)}
              >
                {match.player_one_id ? (
                  <option value={match.player_one_id}>{playerOneName}</option>
                ) : null}
                {match.player_two_id ? (
                  <option value={match.player_two_id}>{playerTwoName}</option>
                ) : null}
              </select>
            </label>
            <label htmlFor="resolution-score">
              Final Score
              <select
                id="resolution-score"
                disabled={resolutionAction !== "confirm_winner"}
                value={resolutionScoreKey}
                onChange={(event) => setResolutionScoreKey(event.target.value)}
              >
                {scoreOptions.map((score) => {
                  const scoreLabel = formatSeriesScore(score) ?? "";

                  return (
                    <option key={scoreLabel} value={scoreLabel}>
                      {scoreLabel}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>
          <label className="wide-field" htmlFor="resolution-note">
            Resolution Note
            <textarea
              id="resolution-note"
              maxLength={1000}
              rows={3}
              value={resolutionNote}
              onChange={(event) => setResolutionNote(event.target.value)}
            />
          </label>
          <div className="match-action-grid">
            <button
              className="button"
              disabled={
                savingAction === "resolve" ||
                match.status === "finalized" ||
                (resolutionAction === "confirm_winner" && (!resolutionWinnerId || !resolutionScoreKey))
              }
              type="button"
              onClick={resolveDispute}
            >
              {savingAction === "resolve" ? "Resolving..." : "Resolve Match"}
            </button>
          </div>

          <details className="advanced-controls">
            <summary>Advanced organizer controls</summary>
            <p className="muted">
              Use these only when helping players recover match setup or correcting host assignment.
            </p>
            <div className="match-action-grid">
              <button
                className="button secondary-button"
                disabled={!match.player_one_id || matchPastSetup || savingAction === "assign-player-one"}
                type="button"
                onClick={() =>
                  match.player_one_id
                    ? assignHost(match.player_one_id, "assign-player-one")
                    : undefined
                }
              >
                {savingAction === "assign-player-one"
                  ? "Assigning..."
                  : `Assign ${getProfileName(profileMap, match.player_one_id) ?? "Player A"} Host`}
              </button>
              <button
                className="button secondary-button"
                disabled={!match.player_two_id || matchPastSetup || savingAction === "assign-player-two"}
                type="button"
                onClick={() =>
                  match.player_two_id
                    ? assignHost(match.player_two_id, "assign-player-two")
                    : undefined
                }
              >
                {savingAction === "assign-player-two"
                  ? "Assigning..."
                  : `Assign ${getProfileName(profileMap, match.player_two_id) ?? "Player B"} Host`}
              </button>
              <button
                className="button danger-button"
                disabled={savingAction === "reset"}
                type="button"
                onClick={resetMatchRoom}
              >
                {savingAction === "reset" ? "Resetting..." : "Reset Match Room"}
              </button>
            </div>
          </details>
        </section>
      ) : null}

      <section className="card">
        <h2>Timeline</h2>
        {orderedEvents.length === 0 ? (
          <p className="muted">No match-room activity yet.</p>
        ) : (
          <div className="timeline-list">
            {orderedEvents.map((event) => (
              <article className="timeline-row" key={event.id}>
                <strong>{describeEvent(event, profileMap)}</strong>
                <p className="muted">{formatDateTime(event.created_at)}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
