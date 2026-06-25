"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { formatError, logError } from "@/lib/errors";
import { ensureProfile, type Profile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  buildTournamentSlug,
  matchFormats,
  matchFormatLabels,
  normalizeOptionalText,
  toIsoFromLocalInput,
  tournamentFormats,
  tournamentFormatLabels,
  tournamentStatusLabels,
  type MatchFormat,
  type TournamentFormat,
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
  status: Extract<TournamentStatus, "draft" | "registration_open">;
};

const initialFormState: TournamentFormState = {
  title: "",
  description: "",
  startsAt: "",
  registrationClosesAt: "",
  maxPlayers: "16",
  tournamentFormat: "single_elimination",
  matchFormat: "bo1",
  rules: "",
  externalCommunityUrl: "",
  status: "draft",
};

export function CreateTournamentForm() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [formState, setFormState] = useState<TournamentFormState>(initialFormState);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadAccess() {
      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        router.replace("/auth?redirectTo=/tournaments/create");
        return;
      }

      try {
        const [loadedProfile, loadedRoles] = await Promise.all([
          ensureProfile(supabase, data.user),
          getCurrentUserRoles(supabase),
        ]);

        if (isMounted) {
          setUser(data.user);
          setProfile(loadedProfile);
          setRoles(loadedRoles);
        }
      } catch (caughtError) {
        if (isMounted) {
          logError("Create tournament access load failed.", caughtError);
          setError(formatError(caughtError, "Unable to load organizer access."));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadAccess();

    return () => {
      isMounted = false;
    };
  }, [router, supabase]);

  function updateField<Field extends keyof TournamentFormState>(
    field: Field,
    value: TournamentFormState[Field],
  ) {
    setFormState((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user || !profile || !roles.isOrganizer) {
      return;
    }

    const startsAt = toIsoFromLocalInput(formState.startsAt);
    const registrationClosesAt = toIsoFromLocalInput(formState.registrationClosesAt);
    const maxPlayers = Number.parseInt(formState.maxPlayers, 10);

    if (!startsAt || !registrationClosesAt) {
      setError("Scheduled start time and registration close time are required.");
      return;
    }

    if (new Date(registrationClosesAt) > new Date(startsAt)) {
      setError("Registration close time must be before the scheduled start time.");
      return;
    }

    if (!Number.isInteger(maxPlayers) || maxPlayers < 2) {
      setError("Max participants must be at least 2.");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const { data: tournament, error: insertError } = await supabase
        .from("tournaments")
        .insert({
          name: formState.title.trim(),
          slug: buildTournamentSlug(formState.title),
          description: normalizeOptionalText(formState.description),
          starts_at: startsAt,
          registration_closes_at: registrationClosesAt,
          max_players: maxPlayers,
          tournament_format: formState.tournamentFormat,
          format: formState.matchFormat,
          rules: normalizeOptionalText(formState.rules),
          external_community_url: normalizeOptionalText(formState.externalCommunityUrl),
          status: formState.status,
          created_by: user.id,
        })
        .select("*")
        .single();

      if (insertError) {
        throw insertError;
      }

      const { error: organizerError } = await supabase.from("tournament_organizers").insert({
        tournament_id: tournament.id,
        user_id: user.id,
      });

      if (organizerError) {
        throw organizerError;
      }

      router.push(`/tournaments/${tournament.id}`);
      router.refresh();
    } catch (caughtError) {
      logError("Create tournament failed.", caughtError);
      setError(formatError(caughtError, "Unable to create tournament."));
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return <p className="muted">Loading tournament creation...</p>;
  }

  if (error && !profile) {
    return <p className="error">{error}</p>;
  }

  if (!user || !profile || !roles.isOrganizer) {
    return (
      <AccessDenied message="Tournament creation is available only to organizer or admin accounts." />
    );
  }

  return (
    <>
      <h1>Create Tournament</h1>
      <p className="muted">Create a free-entry Teamfight Manager 2 community tournament.</p>

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
                min={2}
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
                onChange={(event) =>
                  updateField(
                    "status",
                    event.target.value as TournamentFormState["status"],
                  )
                }
              >
                <option value="draft">{tournamentStatusLabels.draft}</option>
                <option value="registration_open">
                  {tournamentStatusLabels.registration_open}
                </option>
              </select>
            </label>
          </div>

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

          {error ? <p className="error">{error}</p> : null}

          <button className="button" disabled={isSaving} type="submit">
            {isSaving ? "Creating..." : "Create Tournament"}
          </button>
        </div>
      </form>
    </>
  );
}
