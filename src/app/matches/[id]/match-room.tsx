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
  isMatchBye,
  isMatchWaiting,
  type PublicProfile,
} from "@/lib/match-rooms";
import { ensureProfile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  formatDateTime,
  matchFormatLabels,
  matchStatusLabels,
  type MatchCheckInRow,
  type MatchEventRow,
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
  | null;

export function MatchRoom({ matchId }: { matchId: string }) {
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [tournament, setTournament] = useState<TournamentRow | null>(null);
  const [round, setRound] = useState<TournamentRoundRow | null>(null);
  const [checkIns, setCheckIns] = useState<MatchCheckInRow[]>([]);
  const [events, setEvents] = useState<MatchEventRow[]>([]);
  const [profileMap, setProfileMap] = useState<Record<string, PublicProfile>>({});
  const [canManageMatch, setCanManageMatch] = useState(false);
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
      if (organizerAccessResult.error) throw organizerAccessResult.error;

      const loadedTournament = tournamentResult.data as TournamentRow | null;
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

      setUser(currentUser);
      setRoles(loadedRoles);
      setMatch(loadedMatch);
      setTournament(loadedTournament);
      setRound(roundResult.data as TournamentRoundRow | null);
      setCheckIns((checkInsResult.data ?? []) as MatchCheckInRow[]);
      setEvents((eventsResult.data ?? []) as MatchEventRow[]);
      setProfileMap(loadedProfileMap);
      setCanManageMatch(managed);
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
  const lobbyName = guestName ?? "Opponent display name";
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
          <p>Do not report winners here yet. Result reporting, evidence, and disputes are intentionally out of scope.</p>
        </div>
      </section>

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
