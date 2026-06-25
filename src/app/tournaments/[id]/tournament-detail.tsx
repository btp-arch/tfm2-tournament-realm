"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { formatError, logError } from "@/lib/errors";
import { ensureProfile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  canRegisterForTournament,
  canWithdrawFromTournament,
  editableTournamentStatuses,
  formatDateTime,
  getRegistrationBlockedReason,
  getRegistrationReopenBlockedReason,
  getTournamentDeleteBlockedReason,
  isTournamentFull,
  matchFormatLabels,
  tournamentStatusDescriptions,
  tournamentFormatLabels,
  tournamentStatusLabels,
  type TournamentRegistrationRow,
  type TournamentRow,
  type TournamentStatus,
} from "@/lib/tournaments";

type PublicProfile = {
  id: string;
  display_name: string;
};

type RegistrationCountRow = {
  tournament_id: string | null;
  active_registration_count: number | null;
};

export function TournamentDetail({ tournamentId }: { tournamentId: string }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [tournament, setTournament] = useState<TournamentRow | null>(null);
  const [organizer, setOrganizer] = useState<PublicProfile | null>(null);
  const [registration, setRegistration] = useState<TournamentRegistrationRow | null>(null);
  const [activeRegistrationCount, setActiveRegistrationCount] = useState(0);
  const [totalRegistrationCount, setTotalRegistrationCount] = useState(0);
  const [isManagedByUser, setIsManagedByUser] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<TournamentStatus>("draft");
  const [adminDeleteConfirmation, setAdminDeleteConfirmation] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingAction, setSavingAction] = useState<
    "register" | "withdraw" | "status" | "cancel" | "delete" | "reopen" | "close" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTournament = useCallback(async () => {
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

      const { data: loadedTournament, error: tournamentError } = await supabase
        .from("tournaments")
        .select("*")
        .eq("id", tournamentId)
        .maybeSingle();

      if (tournamentError) {
        throw tournamentError;
      }

      if (!loadedTournament) {
        setUser(currentUser);
        setRoles(loadedRoles);
        setTournament(null);
        return;
      }

      const [
        organizerResult,
        countResult,
        registrationResult,
        organizerAccessResult,
        totalRegistrationsResult,
      ] = await Promise.all([
        supabase
          .from("public_profiles")
          .select("id, display_name")
          .eq("id", loadedTournament.created_by)
          .maybeSingle(),
        supabase
          .from("tournament_registration_counts")
          .select("tournament_id, active_registration_count")
          .eq("tournament_id", loadedTournament.id)
          .maybeSingle(),
        currentUser
          ? supabase
              .from("tournament_registrations")
              .select("*")
              .eq("tournament_id", loadedTournament.id)
              .eq("user_id", currentUser.id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        currentUser
          ? supabase
              .from("tournament_organizers")
              .select("tournament_id")
              .eq("tournament_id", loadedTournament.id)
              .eq("user_id", currentUser.id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        currentUser
          ? supabase
              .from("tournament_registrations")
              .select("id", { count: "exact", head: true })
              .eq("tournament_id", loadedTournament.id)
          : Promise.resolve({ data: null, error: null, count: 0 }),
      ]);

      if (organizerResult.error) {
        throw organizerResult.error;
      }

      if (countResult.error) {
        throw countResult.error;
      }

      if (registrationResult.error) {
        throw registrationResult.error;
      }

      if (organizerAccessResult.error) {
        throw organizerAccessResult.error;
      }

      if (totalRegistrationsResult.error) {
        throw totalRegistrationsResult.error;
      }

      const countRow = countResult.data as RegistrationCountRow | null;

      setUser(currentUser);
      setRoles(loadedRoles);
      setTournament(loadedTournament);
      setOrganizer(organizerResult.data as PublicProfile | null);
      setRegistration(registrationResult.data);
      setActiveRegistrationCount(countRow?.active_registration_count ?? 0);
      setTotalRegistrationCount(totalRegistrationsResult.count ?? 0);
      setIsManagedByUser(Boolean(organizerAccessResult.data));
      setSelectedStatus(loadedTournament.status);
      setAdminDeleteConfirmation("");
    } catch (caughtError) {
      logError("Tournament detail load failed.", caughtError);
      setError(formatError(caughtError, "Unable to load tournament."));
    } finally {
      setIsLoading(false);
    }
  }, [supabase, tournamentId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadTournament();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadTournament]);

  const canManageTournament = useMemo(() => {
    if (!user || !tournament) {
      return false;
    }

    return roles.isAdmin || tournament.created_by === user.id || isManagedByUser;
  }, [isManagedByUser, roles.isAdmin, tournament, user]);

  const registrationBlockedReason = tournament
    ? getRegistrationBlockedReason(tournament, activeRegistrationCount, registration, Boolean(user))
    : null;

  const canRegister = tournament
    ? Boolean(user) && canRegisterForTournament(tournament, activeRegistrationCount, registration)
    : false;

  const canWithdraw = tournament ? canWithdrawFromTournament(tournament, registration) : false;
  const isFull = tournament ? isTournamentFull(tournament, activeRegistrationCount) : false;
  const deleteBlockedReason =
    tournament && user
      ? getTournamentDeleteBlockedReason(
          tournament,
          totalRegistrationCount,
          user.id,
          roles.isAdmin,
        )
      : "Sign in with organizer or admin access to delete tournaments.";
  const canCancelTournament = Boolean(
    tournament &&
      canManageTournament &&
      tournament.status !== "cancelled" &&
      (roles.isAdmin || tournament.status !== "completed"),
  );
  const reopenBlockedReason = tournament
    ? getRegistrationReopenBlockedReason(tournament)
    : null;
  const isAdminDeleteReady = !roles.isAdmin || adminDeleteConfirmation === "DELETE";

  async function registerForTournament() {
    if (!user || !tournament || !canRegister) {
      return;
    }

    setSavingAction("register");
    setNotice(null);
    setError(null);

    try {
      await ensureProfile(supabase, user);

      const { error: insertError } = await supabase.from("tournament_registrations").insert({
        tournament_id: tournament.id,
        user_id: user.id,
        status: "pending",
      });

      if (insertError) {
        throw insertError;
      }

      setNotice("Registration confirmed.");
      await loadTournament();
    } catch (caughtError) {
      logError("Tournament registration failed.", caughtError);
      setError(formatError(caughtError, "Unable to register for this tournament."));
    } finally {
      setSavingAction(null);
    }
  }

  async function withdrawFromTournament() {
    if (!registration || !canWithdraw) {
      return;
    }

    setSavingAction("withdraw");
    setNotice(null);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from("tournament_registrations")
        .update({
          status: "withdrawn",
          updated_at: new Date().toISOString(),
        })
        .eq("id", registration.id);

      if (updateError) {
        throw updateError;
      }

      setNotice("Registration withdrawn.");
      await loadTournament();
    } catch (caughtError) {
      logError("Tournament withdrawal failed.", caughtError);
      setError(formatError(caughtError, "Unable to withdraw from this tournament."));
    } finally {
      setSavingAction(null);
    }
  }

  async function updateTournamentStatusTo(
    status: TournamentStatus,
    successMessage: string,
    action: "status" | "reopen" | "close" = "status",
  ) {
    if (!tournament || !canManageTournament || status === tournament.status) {
      return;
    }

    if (status === "registration_open") {
      const blockedReason = getRegistrationReopenBlockedReason(tournament);

      if (blockedReason) {
        setError(blockedReason);
        return;
      }
    }

    setSavingAction(action);
    setNotice(null);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from("tournaments")
        .update({
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tournament.id);

      if (updateError) {
        throw updateError;
      }

      setNotice(successMessage);
      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      logError("Tournament status update failed.", caughtError);
      setError(formatError(caughtError, "Unable to update tournament status."));
    } finally {
      setSavingAction(null);
    }
  }

  async function updateTournamentStatus() {
    await updateTournamentStatusTo(selectedStatus, "Tournament status updated.");
  }

  async function cancelTournament() {
    if (!tournament || !canCancelTournament) {
      return;
    }

    const confirmed = window.confirm("Cancel this tournament? Registration will stay closed.");
    if (!confirmed) {
      return;
    }

    setSavingAction("cancel");
    setNotice(null);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from("tournaments")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("id", tournament.id);

      if (updateError) {
        throw updateError;
      }

      setNotice("Tournament cancelled.");
      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      logError("Tournament cancellation failed.", caughtError);
      setError(formatError(caughtError, "Unable to cancel tournament."));
    } finally {
      setSavingAction(null);
    }
  }

  async function deleteTournament() {
    if (!tournament || !canManageTournament || deleteBlockedReason) {
      return;
    }

    if (roles.isAdmin && adminDeleteConfirmation !== "DELETE") {
      setError("Type DELETE to confirm the admin delete override.");
      return;
    }

    const confirmed = window.confirm(
      roles.isAdmin
        ? `Admin override delete "${tournament.name}"? This removes the tournament and all related registration rows.`
        : "Delete this empty draft tournament? This cannot be undone.",
    );
    if (!confirmed) {
      return;
    }

    setSavingAction("delete");
    setNotice(null);
    setError(null);

    try {
      const { error: deleteError } = await supabase
        .from("tournaments")
        .delete()
        .eq("id", tournament.id);

      if (deleteError) {
        throw deleteError;
      }

      router.push("/organizer");
      router.refresh();
    } catch (caughtError) {
      logError("Tournament deletion failed.", caughtError);
      setError(formatError(caughtError, "Unable to delete tournament."));
      setSavingAction(null);
    }
  }

  if (isLoading) {
    return <p className="muted">Loading tournament...</p>;
  }

  if (error && !tournament) {
    return <p className="error">{error}</p>;
  }

  if (!tournament) {
    return (
      <section className="card">
        <h1>Tournament Not Found</h1>
        <p className="muted">This tournament is unavailable or you do not have access to it.</p>
      </section>
    );
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <span className="badge">{tournamentStatusLabels[tournament.status]}</span>
          <h1>{tournament.name}</h1>
          <p className="muted">Organized by {organizer?.display_name ?? "Tournament staff"}</p>
        </div>
        {canManageTournament ? (
          <Link className="button secondary-button button-link" href="/organizer">
            Organizer Dashboard
          </Link>
        ) : null}
      </div>

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {tournament.status === "cancelled" ? (
        <p className="error">This tournament has been cancelled and is no longer accepting registration.</p>
      ) : null}

      <section className="grid">
        <div className="card">
          <h2>Schedule</h2>
          <dl className="meta-grid single-column">
            <div>
              <dt>Start</dt>
              <dd>{formatDateTime(tournament.starts_at)}</dd>
            </div>
            <div>
              <dt>Registration Closes</dt>
              <dd>{formatDateTime(tournament.registration_closes_at)}</dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h2>Format</h2>
          <dl className="meta-grid single-column">
            <div>
              <dt>Tournament</dt>
              <dd>{tournamentFormatLabels[tournament.tournament_format]}</dd>
            </div>
            <div>
              <dt>Matches</dt>
              <dd>{matchFormatLabels[tournament.format]}</dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h2>Registration</h2>
          <p className={isFull ? "error" : undefined}>
            {activeRegistrationCount}
            {tournament.max_players ? `/${tournament.max_players}` : ""} players registered
          </p>
          {registration?.status && registration.status !== "withdrawn" ? (
            <p className="notice">You are registered.</p>
          ) : null}
          {registration?.status === "withdrawn" ? (
            <p className="muted">You withdrew from this tournament.</p>
          ) : null}
        </div>
      </section>

      {tournament.description ? (
        <section className="card">
          <h2>Description</h2>
          <p>{tournament.description}</p>
        </section>
      ) : null}

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Player Registration</h2>
            <p className="muted">
              Registration is for your signed-in account only.
            </p>
          </div>
        </div>

        {!user ? (
          <Link className="button button-link" href={`/auth?redirectTo=/tournaments/${tournament.id}`}>
            Sign In To Register
          </Link>
        ) : canRegister ? (
          <button
            className="button"
            disabled={savingAction === "register"}
            type="button"
            onClick={registerForTournament}
          >
            {savingAction === "register" ? "Registering..." : "Register"}
          </button>
        ) : canWithdraw ? (
          <button
            className="button secondary-button"
            disabled={savingAction === "withdraw"}
            type="button"
            onClick={withdrawFromTournament}
          >
            {savingAction === "withdraw" ? "Withdrawing..." : "Withdraw"}
          </button>
        ) : (
          <p className="muted">{registrationBlockedReason}</p>
        )}
      </section>

      <section className="card">
        <h2>Rules</h2>
        {tournament.rules ? <p className="pre-line">{tournament.rules}</p> : <p className="muted">No rules posted yet.</p>}
        {tournament.external_community_url ? (
          <p>
            <a href={tournament.external_community_url} rel="noreferrer" target="_blank">
              Community link
            </a>
          </p>
        ) : null}
      </section>

      {canManageTournament ? (
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Management</h2>
              <p className="muted">
                {activeRegistrationCount}
                {tournament.max_players ? `/${tournament.max_players}` : ""} registered participant
                {activeRegistrationCount === 1 ? "" : "s"}.
              </p>
            </div>
            <Link className="button secondary-button button-link" href={`/tournaments/${tournament.id}/edit`}>
              Edit Tournament
            </Link>
          </div>

          <div className="status-control">
            <label htmlFor="tournament-status">
              Status
              <select
                id="tournament-status"
                value={selectedStatus}
                onChange={(event) => setSelectedStatus(event.target.value as TournamentStatus)}
              >
                {editableTournamentStatuses.map((status) => (
                  <option key={status} value={status}>
                    {tournamentStatusLabels[status]}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button"
              disabled={savingAction === "status" || selectedStatus === tournament.status}
              type="button"
              onClick={updateTournamentStatus}
            >
              {savingAction === "status" ? "Saving..." : "Save Status"}
            </button>
          </div>

          <p className="muted">
            {tournamentStatusDescriptions[selectedStatus] ?? "Use the selected tournament status."}
          </p>

          <div className="management-actions">
            <div>
              <h3>Cancel Tournament</h3>
              <p className="muted">
                Cancel keeps the tournament visible in history but prevents registration.
                {roles.isAdmin ? " Admins can cancel any non-cancelled tournament." : ""}
              </p>
            </div>
            <button
              className="button danger-button"
              disabled={!canCancelTournament || savingAction === "cancel"}
              type="button"
              onClick={cancelTournament}
            >
              {savingAction === "cancel" ? "Cancelling..." : "Cancel Tournament"}
            </button>
          </div>

          {roles.isAdmin ? (
            <div className="management-actions">
              <div>
                <h3>Admin Registration Controls</h3>
                <p className={reopenBlockedReason ? "muted" : undefined}>
                  {reopenBlockedReason ??
                    "Registration can be reopened because the close time is in the future."}
                </p>
              </div>
              <div className="role-actions">
                <button
                  className="button secondary-button"
                  disabled={
                    savingAction === "reopen" ||
                    tournament.status === "registration_open" ||
                    Boolean(reopenBlockedReason)
                  }
                  type="button"
                  onClick={() =>
                    updateTournamentStatusTo(
                      "registration_open",
                      "Registration reopened.",
                      "reopen",
                    )
                  }
                >
                  {savingAction === "reopen" ? "Reopening..." : "Reopen Registration"}
                </button>
                <button
                  className="button secondary-button"
                  disabled={
                    savingAction === "close" ||
                    tournament.status === "registration_closed"
                  }
                  type="button"
                  onClick={() =>
                    updateTournamentStatusTo(
                      "registration_closed",
                      "Registration closed.",
                      "close",
                    )
                  }
                >
                  {savingAction === "close" ? "Closing..." : "Close Registration"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="management-actions">
            <div>
              <h3>{roles.isAdmin ? "Admin Delete Override" : "Delete Draft"}</h3>
              {roles.isAdmin ? (
                <div className="destructive-summary">
                  <p>
                    <strong>{tournament.name}</strong>
                  </p>
                  <p>Status: {tournamentStatusLabels[tournament.status]}</p>
                  <p>
                    Active participants: {activeRegistrationCount}
                    {tournament.max_players ? `/${tournament.max_players}` : ""}
                  </p>
                  <p>Total registration records: {totalRegistrationCount}</p>
                  {totalRegistrationCount > 0 ? (
                    <p className="error">
                      Registrations exist. Cancel is preferred for real events with participants.
                    </p>
                  ) : (
                    <p className="muted">No registration records exist.</p>
                  )}
                  <label className="confirmation-field" htmlFor="admin-delete-confirmation">
                    Type DELETE to enable admin override delete
                    <input
                      id="admin-delete-confirmation"
                      value={adminDeleteConfirmation}
                      onChange={(event) => setAdminDeleteConfirmation(event.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <p className={deleteBlockedReason ? "muted" : undefined}>
                  {deleteBlockedReason ?? "This empty draft tournament can be deleted."}
                </p>
              )}
            </div>
            <button
              className="button danger-button"
              disabled={
                Boolean(deleteBlockedReason) ||
                savingAction === "delete" ||
                !isAdminDeleteReady
              }
              type="button"
              onClick={deleteTournament}
            >
              {savingAction === "delete"
                ? "Deleting..."
                : roles.isAdmin
                  ? "Admin Delete Tournament"
                  : "Delete Tournament"}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
