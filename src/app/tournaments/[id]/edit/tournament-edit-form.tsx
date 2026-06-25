"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { formatError, logError } from "@/lib/errors";
import { ensureProfile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  editableTournamentStatuses,
  getRegistrationReopenBlockedReason,
  matchFormats,
  matchFormatLabels,
  normalizeOptionalText,
  toIsoFromLocalInput,
  toLocalDateTimeInput,
  tournamentFormats,
  tournamentFormatLabels,
  tournamentStatusDescriptions,
  tournamentStatusLabels,
  type MatchFormat,
  type TournamentFormat,
  type TournamentRow,
  type TournamentStatus,
} from "@/lib/tournaments";

type TournamentFormState = {
  title: string;
  description: string;
  startsAt: string;
  registrationClosesAt: string;
  maxPlayers: string;
  tournamentFormat: TournamentFormat;
  matchFormat: MatchFormat;
  rules: string;
  externalCommunityUrl: string;
  status: TournamentStatus;
};

type RegistrationCountRow = {
  tournament_id: string | null;
  active_registration_count: number | null;
};

function toFormState(tournament: TournamentRow): TournamentFormState {
  return {
    title: tournament.name,
    description: tournament.description ?? "",
    startsAt: toLocalDateTimeInput(tournament.starts_at),
    registrationClosesAt: toLocalDateTimeInput(tournament.registration_closes_at),
    maxPlayers: tournament.max_players?.toString() ?? "",
    tournamentFormat: tournament.tournament_format,
    matchFormat: tournament.format,
    rules: tournament.rules ?? "",
    externalCommunityUrl: tournament.external_community_url ?? "",
    status: editableTournamentStatuses.includes(tournament.status)
      ? tournament.status
      : "draft",
  };
}

export function EditTournamentForm({ tournamentId }: { tournamentId: string }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [tournament, setTournament] = useState<TournamentRow | null>(null);
  const [formState, setFormState] = useState<TournamentFormState | null>(null);
  const [activeRegistrationCount, setActiveRegistrationCount] = useState(0);
  const [isManagedByUser, setIsManagedByUser] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTournament = useCallback(async () => {
    const { data } = await supabase.auth.getUser();

    if (!data.user) {
      router.replace(`/auth?redirectTo=/tournaments/${tournamentId}/edit`);
      return;
    }

    try {
      const [, loadedRoles] = await Promise.all([
        ensureProfile(supabase, data.user),
        getCurrentUserRoles(supabase),
      ]);

      const { data: loadedTournament, error: tournamentError } = await supabase
        .from("tournaments")
        .select("*")
        .eq("id", tournamentId)
        .maybeSingle();

      if (tournamentError) {
        throw tournamentError;
      }

      if (!loadedTournament) {
        setUser(data.user);
        setRoles(loadedRoles);
        setTournament(null);
        return;
      }

      const [organizerAccessResult, countResult] = await Promise.all([
        supabase
          .from("tournament_organizers")
          .select("tournament_id")
          .eq("tournament_id", loadedTournament.id)
          .eq("user_id", data.user.id)
          .maybeSingle(),
        supabase
          .from("tournament_registration_counts")
          .select("tournament_id, active_registration_count")
          .eq("tournament_id", loadedTournament.id)
          .maybeSingle(),
      ]);

      if (organizerAccessResult.error) {
        throw organizerAccessResult.error;
      }

      if (countResult.error) {
        throw countResult.error;
      }

      const countRow = countResult.data as RegistrationCountRow | null;

      setUser(data.user);
      setRoles(loadedRoles);
      setTournament(loadedTournament);
      setFormState(toFormState(loadedTournament));
      setActiveRegistrationCount(countRow?.active_registration_count ?? 0);
      setIsManagedByUser(Boolean(organizerAccessResult.data));
    } catch (caughtError) {
      logError("Tournament edit load failed.", caughtError);
      setError(formatError(caughtError, "Unable to load tournament editor."));
    } finally {
      setIsLoading(false);
    }
  }, [router, supabase, tournamentId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadTournament();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadTournament]);

  const canManageTournament = Boolean(
    user &&
      tournament &&
      (roles.isAdmin || tournament.created_by === user.id || isManagedByUser),
  );

  function updateField<Field extends keyof TournamentFormState>(
    field: Field,
    value: TournamentFormState[Field],
  ) {
    setFormState((current) => (current ? { ...current, [field]: value } : current));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!tournament || !formState || !canManageTournament) {
      return;
    }

    const title = formState.title.trim();
    const startsAt = toIsoFromLocalInput(formState.startsAt);
    const registrationClosesAt = toIsoFromLocalInput(formState.registrationClosesAt);
    const maxPlayers = Number.parseInt(formState.maxPlayers, 10);

    if (title.length < 3 || title.length > 120) {
      setError("Title must be between 3 and 120 characters.");
      return;
    }

    if (!startsAt || !registrationClosesAt) {
      setError("Scheduled start time and registration close time are required.");
      return;
    }

    if (new Date(registrationClosesAt) > new Date(startsAt)) {
      setError("Registration close time must be before the scheduled start time.");
      return;
    }

    if (formState.status === "registration_open") {
      const blockedReason = getRegistrationReopenBlockedReason({
        registration_closes_at: registrationClosesAt,
      });

      if (blockedReason) {
        setError(blockedReason);
        return;
      }
    }

    if (!Number.isInteger(maxPlayers) || maxPlayers < 2) {
      setError("Max participants must be at least 2.");
      return;
    }

    if (maxPlayers < activeRegistrationCount) {
      setError("Max participants cannot be lower than the current registered participant count.");
      return;
    }

    setIsSaving(true);
    setNotice(null);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from("tournaments")
        .update({
          name: title,
          description: normalizeOptionalText(formState.description),
          starts_at: startsAt,
          registration_closes_at: registrationClosesAt,
          max_players: maxPlayers,
          tournament_format: formState.tournamentFormat,
          format: formState.matchFormat,
          rules: normalizeOptionalText(formState.rules),
          external_community_url: normalizeOptionalText(formState.externalCommunityUrl),
          status: formState.status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tournament.id);

      if (updateError) {
        throw updateError;
      }

      setNotice("Tournament updated.");
      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      logError("Tournament edit failed.", caughtError);
      setError(formatError(caughtError, "Unable to update tournament."));
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return <p className="muted">Loading tournament editor...</p>;
  }

  if (error && !tournament) {
    return <p className="error">{error}</p>;
  }

  if (!tournament || !formState) {
    return (
      <section className="card">
        <h1>Tournament Not Found</h1>
        <p className="muted">This tournament is unavailable or you do not have access to it.</p>
      </section>
    );
  }

  if (!canManageTournament) {
    return <AccessDenied message="Tournament editing is available only to tournament staff or admins." />;
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Edit Tournament</h1>
          <p className="muted">Update setup, registration, and status details.</p>
        </div>
        <Link className="button secondary-button button-link" href={`/tournaments/${tournament.id}`}>
          Back To Tournament
        </Link>
      </div>

      <form className="card form-card wide-form" onSubmit={handleSubmit}>
        <div className="form-stack">
          <label htmlFor="title">
            Title
            <input
              id="title"
              required
              minLength={3}
              maxLength={120}
              value={formState.title}
              onChange={(event) => updateField("title", event.target.value)}
            />
          </label>

          <label htmlFor="description">
            Description
            <textarea
              id="description"
              rows={4}
              value={formState.description}
              onChange={(event) => updateField("description", event.target.value)}
            />
          </label>

          <div className="form-grid">
            <label htmlFor="starts-at">
              Scheduled start time
              <input
                id="starts-at"
                required
                type="datetime-local"
                value={formState.startsAt}
                onChange={(event) => updateField("startsAt", event.target.value)}
              />
            </label>

            <label htmlFor="registration-closes-at">
              Registration close time
              <input
                id="registration-closes-at"
                required
                type="datetime-local"
                value={formState.registrationClosesAt}
                onChange={(event) => updateField("registrationClosesAt", event.target.value)}
              />
            </label>
          </div>

          <div className="form-grid">
            <label htmlFor="max-players">
              Max participants
              <input
                id="max-players"
                required
                min={Math.max(2, activeRegistrationCount)}
                type="number"
                value={formState.maxPlayers}
                onChange={(event) => updateField("maxPlayers", event.target.value)}
              />
            </label>

            <label htmlFor="status">
              Status
              <select
                id="status"
                value={formState.status}
                onChange={(event) => updateField("status", event.target.value as TournamentStatus)}
              >
                {editableTournamentStatuses.map((status) => (
                  <option key={status} value={status}>
                    {tournamentStatusLabels[status]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="muted">
            {tournamentStatusDescriptions[formState.status] ?? "Use the current tournament status."}
          </p>

          <div className="form-grid">
            <label htmlFor="tournament-format">
              Tournament format
              <select
                id="tournament-format"
                value={formState.tournamentFormat}
                onChange={(event) =>
                  updateField("tournamentFormat", event.target.value as TournamentFormat)
                }
              >
                {tournamentFormats.map((format) => (
                  <option key={format} value={format}>
                    {tournamentFormatLabels[format]}
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor="match-format">
              Match format
              <select
                id="match-format"
                value={formState.matchFormat}
                onChange={(event) => updateField("matchFormat", event.target.value as MatchFormat)}
              >
                {matchFormats.map((format) => (
                  <option key={format} value={format}>
                    {matchFormatLabels[format]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label htmlFor="rules">
            Rules
            <textarea
              id="rules"
              rows={6}
              value={formState.rules}
              onChange={(event) => updateField("rules", event.target.value)}
            />
          </label>

          <label htmlFor="external-community-url">
            External community link
            <input
              id="external-community-url"
              placeholder="https://..."
              type="url"
              value={formState.externalCommunityUrl}
              onChange={(event) => updateField("externalCommunityUrl", event.target.value)}
            />
          </label>

          <p className="muted">{activeRegistrationCount} registered participant{activeRegistrationCount === 1 ? "" : "s"}.</p>
          {notice ? <p className="notice">{notice}</p> : null}
          {error ? <p className="error">{error}</p> : null}

          <button className="button" disabled={isSaving} type="submit">
            {isSaving ? "Saving..." : "Save Tournament"}
          </button>
        </div>
      </form>
    </>
  );
}
