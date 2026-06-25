"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { formatError, logError } from "@/lib/errors";
import {
  describeCheckInStatus,
  describeEvent,
  getActionMessage,
  getGuestId,
  getMatchLabel,
  getOpponentId,
  getProfileName,
  getReportedWinnerName,
  isMatchBye,
  isMatchWaiting,
  type PublicProfile,
} from "@/lib/match-rooms";
import { ensureProfile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  formatDateTime,
  matchEvidenceTypeLabels,
  matchFormatLabels,
  matchResolutionLabels,
  matchStatusLabels,
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
  const [reportNotes, setReportNotes] = useState("");
  const [evidenceType, setEvidenceType] = useState<MatchEvidenceType>("result_screen");
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [resolutionAction, setResolutionAction] = useState<MatchResolutionAction>("confirm_winner");
  const [resolutionWinnerId, setResolutionWinnerId] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingAction, setSavingAction] = useState<SavingAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      const ownLoadedReport = currentUser
        ? loadedReports.find((report) => report.reporter_id === currentUser.id)
        : null;
      if (ownLoadedReport) {
        setReportWinnerId(ownLoadedReport.reported_winner_id);
        setReportNotes(ownLoadedReport.notes ?? "");
      } else if (loadedMatch.player_one_id) {
        setReportWinnerId(loadedMatch.player_one_id);
      }
      setResolutionWinnerId(loadedMatch.winner_id ?? loadedMatch.player_one_id ?? "");
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

    return () => window.clearTimeout(timeoutId);
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
  const reportsMismatch = Boolean(
    playerOneReport &&
      playerTwoReport &&
      playerOneReport.reported_winner_id !== playerTwoReport.reported_winner_id,
  );
  const bothReportsSubmitted = Boolean(playerOneReport && playerTwoReport);
  const waitingForOpponentReport = Boolean(ownReport && !bothReportsSubmitted);
  const ownReportEvidence = ownReport
    ? evidence.filter((item) => item.match_report_id === ownReport.id)
    : [];
  const canReportResult = Boolean(
    match &&
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
  const canUsePlayerActions = Boolean(
    match &&
      user &&
      !isMatchBye(match) &&
      !isMatchWaiting(match) &&
      (isParticipant || canManageMatch),
  );
  const canCheckIn = Boolean(canUsePlayerActions && isParticipant && !ownCheckIn);
  const canMarkGameCreated = Boolean(
    canUsePlayerActions &&
      match?.host_user_id &&
      match.status !== "in_game" &&
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
        notes: reportNotes.trim() || null,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
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

    await runMatchAction(
      "report",
      async () => {
        const files = evidenceFiles.slice(0, maxEvidenceUploads);
        const { data: report, error: rpcError } = await supabase.rpc("submit_match_report", {
          target_match: match.id,
          reported_winner: reportWinnerId,
          report_notes: reportNotes.trim() || null,
        });

        if (rpcError) {
          throw rpcError;
        }

        if (report) {
          await uploadEvidenceFiles(report as MatchReportRow, files);
        }
      },
      "Result report submitted.",
    );
    setEvidenceFiles([]);
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

    await runMatchAction(
      "resolve",
      async () => {
        const { error: rpcError } = await supabase.rpc("resolve_match_dispute", {
          target_match: match.id,
          resolution_action: resolutionAction,
          selected_winner: resolutionAction === "confirm_winner" ? resolutionWinnerId : null,
          resolution_notes: resolutionNote.trim() || null,
        });

        if (rpcError) {
          throw rpcError;
        }
      },
      "Match review resolved.",
    );
  }

  if (isLoading) {
    return <p className="muted">Loading match room...</p>;
  }

  if (error && !match) {
    return <p className="error">{error}</p>;
  }

  if (!match || !tournament) {
    return (
      <section className="card">
        <h1>Match Not Found</h1>
        <p className="muted">This match is unavailable or you do not have access to it.</p>
      </section>
    );
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <span className="badge">{matchStatusLabels[match.status]}</span>
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

      <section className="grid">
        <div className="card">
          <h2>Players</h2>
          <dl className="meta-grid single-column">
            <div>
              <dt>Player A</dt>
              <dd>{getProfileName(profileMap, match.player_one_id) ?? "TBD"}</dd>
            </div>
            <div>
              <dt>Player B</dt>
              <dd>{getProfileName(profileMap, match.player_two_id) ?? (isMatchBye(match) ? "BYE" : "TBD")}</dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h2>Match</h2>
          <dl className="meta-grid single-column">
            <div>
              <dt>Format</dt>
              <dd>{matchFormatLabels[match.format]}</dd>
            </div>
            <div>
              <dt>Patch/Game Version</dt>
              <dd>Not specified</dd>
            </div>
            <div>
              <dt>Match ID</dt>
              <dd className="mono-text">{match.id}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Room Status</h2>
            <p className="muted">{actionMessage}</p>
          </div>
          {roles.isAdmin ? <span className="badge">Admin</span> : canManageMatch ? <span className="badge">Staff</span> : null}
        </div>

        <dl className="meta-grid">
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
            <dd>{hostName ?? "Not assigned"}</dd>
          </div>
          <div>
            <dt>Host Side</dt>
            <dd>{match.host_user_id ? "Blue" : "Assigned with host"}</dd>
          </div>
          <div>
            <dt>Guest</dt>
            <dd>{guestName ?? "Not assigned"}</dd>
          </div>
          <div>
            <dt>Guest Side</dt>
            <dd>{guestId ? "Red" : "Assigned with guest"}</dd>
          </div>
          <div>
            <dt>Lobby Name</dt>
            <dd>{match.host_user_id ? lobbyName : "Assigned after host is selected"}</dd>
          </div>
          <div>
            <dt>Match Created</dt>
            <dd>{match.game_created_at ? formatDateTime(match.game_created_at) : "Not yet"}</dd>
          </div>
        </dl>

        {canUsePlayerActions ? (
          <div className="match-action-grid">
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
            <h2>Result Reporting</h2>
            <p className="muted">
              Both players report the winner. Matching reports finalize automatically; confirmed mismatches go to organizer review.
            </p>
          </div>
          {match.winner_id ? (
            <span className="badge">
              Winner: {getProfileName(profileMap, match.winner_id) ?? "Player"}
            </span>
          ) : null}
        </div>

        {isMatchBye(match) || isMatchWaiting(match) ? (
          <p className="muted">This match does not need result reporting yet.</p>
        ) : match.status === "finalized" || match.status === "confirmed" ? (
          <p className="notice">
            Result confirmed. {match.winner_id ? `${getProfileName(profileMap, match.winner_id) ?? "Winner"} advanced.` : "No winner was advanced."}
          </p>
        ) : openDispute ? (
          <p className="error">A dispute is open for organizer review.</p>
        ) : reportsMismatch ? (
          <p className="error">Reports do not match. Please confirm or change your report.</p>
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
                ? `${getReportedWinnerName(playerOneReport, profileMap) ?? "Player"} reported${playerOneReport.confirmation_state === "confirmed_current" ? " and confirmed" : ""}`
                : "No report"}
            </dd>
          </div>
          <div>
            <dt>{playerTwoName}</dt>
            <dd>
              {playerTwoReport
                ? `${getReportedWinnerName(playerTwoReport, profileMap) ?? "Player"} reported${playerTwoReport.confirmation_state === "confirmed_current" ? " and confirmed" : ""}`
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
              <label htmlFor="evidence-type">
                Evidence Type
                <select
                  id="evidence-type"
                  disabled={!canReportResult}
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

            <label className="wide-field" htmlFor="evidence-files">
              Image Evidence
              <input
                accept="image/png,image/jpeg,image/webp"
                disabled={!canReportResult || ownReportEvidence.length >= maxEvidenceUploads}
                id="evidence-files"
                multiple
                type="file"
                onChange={(event) =>
                  setEvidenceFiles(Array.from(event.target.files ?? []).slice(0, maxEvidenceUploads))
                }
              />
            </label>
            <p className="muted">
              Optional PNG, JPG/JPEG, or WEBP images. Max 5 MB each, 3 uploads per report.
            </p>

            <div className="match-action-grid">
              <button
                className="button"
                disabled={!canReportResult || !reportWinnerId || savingAction === "report"}
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
          </div>
        ) : (
          <p className="muted">Only match players can submit or confirm result reports.</p>
        )}

        {bothReportsSubmitted && !reportsMismatch && !match.winner_id ? (
          <p className="muted">Reports match and finalization is processing. Refresh if the winner is not shown.</p>
        ) : null}
      </section>

      {evidence.length > 0 ? (
        <section className="card">
          <h2>Evidence</h2>
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
        </section>
      ) : null}

      {canManageMatch ? (
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Organizer Tools</h2>
              <p className="muted">Staff can reset setup, reassign host, or mark the match created when helping players.</p>
            </div>
          </div>
          <div className="match-action-grid">
            <button
              className="button secondary-button"
              disabled={!match.player_one_id || savingAction === "assign-player-one"}
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
              disabled={!match.player_two_id || savingAction === "assign-player-two"}
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

          <div className="management-actions">
            <div>
              <h3>Result Review</h3>
              <p className="muted">
                Staff can confirm a winner, require replay, or mark no contest when player reports need review.
              </p>
              {openDispute ? (
                <p className="error">{openDispute.reason}</p>
              ) : reportsMismatch ? (
                <p className="muted">Reports mismatch, but both players have not confirmed different winners yet.</p>
              ) : null}
            </div>
          </div>

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
                (resolutionAction === "confirm_winner" && !resolutionWinnerId)
              }
              type="button"
              onClick={resolveDispute}
            >
              {savingAction === "resolve" ? "Resolving..." : "Resolve Match"}
            </button>
          </div>
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
