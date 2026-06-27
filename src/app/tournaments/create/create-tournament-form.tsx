"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { formatError, logError } from "@/lib/errors";
import { bracketSizes } from "@/lib/brackets";
import {
  getGroupStageFormatSummary,
  validateGroupStageFormat,
} from "@/lib/group-stage";
import { ensureProfile, type Profile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  buildTournamentSlug,
  groupSizes,
  groupStageMatchFormats,
  qualifiersPerGroupOptions,
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
  tournamentFormat: TournamentFormat;
  singleEliminationBracketSize: string;
  groupSize: string;
  groupsCount: string;
  qualifiersPerGroup: string;
  groupStageFormat: MatchFormat;
  preSemifinalFormat: MatchFormat;
  semifinalFormat: MatchFormat;
  finalFormat: MatchFormat;
  rules: string;
  externalCommunityUrl: string;
  status: Extract<TournamentStatus, "draft" | "registration_open">;
};

const initialFormState: TournamentFormState = {
  title: "",
  description: "",
  startsAt: "",
  registrationClosesAt: "",
  tournamentFormat: "single_elimination",
  singleEliminationBracketSize: "16",
  groupSize: "4",
  groupsCount: "4",
  qualifiersPerGroup: "1",
  groupStageFormat: "bo1",
  preSemifinalFormat: "bo1",
  semifinalFormat: "bo3",
  finalFormat: "bo5",
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
    const singleEliminationBracketSize = Number.parseInt(formState.singleEliminationBracketSize, 10);
    const groupSize = Number.parseInt(formState.groupSize, 10);
    const groupsCount = Number.parseInt(formState.groupsCount, 10);
    const qualifiersPerGroup = Number.parseInt(formState.qualifiersPerGroup, 10);
    const maxPlayers =
      formState.tournamentFormat === "group_stage_playoff"
        ? groupSize * groupsCount
        : singleEliminationBracketSize;

    if (!startsAt || !registrationClosesAt) {
      setError("Scheduled start time and registration close time are required.");
      return;
    }

    if (new Date(registrationClosesAt) > new Date(startsAt)) {
      setError("Registration close time must be before the scheduled start time.");
      return;
    }

    if (
      formState.tournamentFormat === "single_elimination" &&
      !bracketSizes.includes(singleEliminationBracketSize as (typeof bracketSizes)[number])
    ) {
      setError("Select a supported single-elimination bracket size.");
      return;
    }

    if (formState.tournamentFormat === "group_stage_playoff") {
      const validationError = validateGroupStageFormat({
        groupSize,
        groupsCount,
        maxPlayers,
        qualifiersPerGroup,
      });

      if (validationError) {
        setError(validationError);
        return;
      }
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
          group_size: formState.tournamentFormat === "group_stage_playoff" ? groupSize : null,
          groups_count: formState.tournamentFormat === "group_stage_playoff" ? groupsCount : null,
          qualifiers_per_group:
            formState.tournamentFormat === "group_stage_playoff" ? qualifiersPerGroup : null,
          group_stage_format:
            formState.tournamentFormat === "group_stage_playoff" ? formState.groupStageFormat : null,
          format: formState.preSemifinalFormat,
          pre_semifinal_match_format: formState.preSemifinalFormat,
          semifinal_match_format: formState.semifinalFormat,
          final_match_format: formState.finalFormat,
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
            <div className="readonly-field">
              <span>Capacity</span>
              <strong>
                {formState.tournamentFormat === "group_stage_playoff"
                  ? Number.parseInt(formState.groupSize || "0", 10) *
                    Number.parseInt(formState.groupsCount || "0", 10)
                  : Number.parseInt(formState.singleEliminationBracketSize || "0", 10)}{" "}
                players
              </strong>
            </div>
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

            {formState.tournamentFormat === "single_elimination" ? (
              <label htmlFor="single-elimination-bracket-size">
                Bracket size
                <select
                  id="single-elimination-bracket-size"
                  value={formState.singleEliminationBracketSize}
                  onChange={(event) => updateField("singleEliminationBracketSize", event.target.value)}
                >
                  {bracketSizes.map((size) => (
                    <option key={size} value={size}>
                      {size} players
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          <div className="form-grid">
            <label htmlFor="pre-semifinal-format">
              Pre-semifinal rounds
              <select
                id="pre-semifinal-format"
                value={formState.preSemifinalFormat}
                onChange={(event) =>
                  updateField("preSemifinalFormat", event.target.value as MatchFormat)
                }
              >
                {matchFormats.map((format) => (
                  <option key={format} value={format}>
                    {matchFormatLabels[format]}
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor="semifinal-format">
              Semifinal
              <select
                id="semifinal-format"
                value={formState.semifinalFormat}
                onChange={(event) => updateField("semifinalFormat", event.target.value as MatchFormat)}
              >
                {matchFormats.map((format) => (
                  <option key={format} value={format}>
                    {matchFormatLabels[format]}
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor="final-format">
              Final
              <select
                id="final-format"
                value={formState.finalFormat}
                onChange={(event) => updateField("finalFormat", event.target.value as MatchFormat)}
              >
                {matchFormats.map((format) => (
                  <option key={format} value={format}>
                    {matchFormatLabels[format]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {formState.tournamentFormat === "group_stage_playoff" ? (
            <>
              <div className="form-grid">
                <label htmlFor="group-size">
                  Group size
                  <select
                    id="group-size"
                    value={formState.groupSize}
                    onChange={(event) => updateField("groupSize", event.target.value)}
                  >
                    {groupSizes.map((size) => (
                      <option key={size} value={size}>
                        {size} players
                      </option>
                    ))}
                  </select>
                </label>

                <label htmlFor="groups-count">
                  Number of groups
                  <input
                    id="groups-count"
                    min={1}
                    required
                    type="number"
                    value={formState.groupsCount}
                    onChange={(event) => updateField("groupsCount", event.target.value)}
                  />
                </label>
              </div>

              <div className="form-grid">
                <label htmlFor="qualifiers-per-group">
                  Qualifiers per group
                  <select
                    id="qualifiers-per-group"
                    value={formState.qualifiersPerGroup}
                    onChange={(event) => updateField("qualifiersPerGroup", event.target.value)}
                  >
                    {qualifiersPerGroupOptions.map((count) => (
                      <option key={count} value={count}>
                        Top {count}
                      </option>
                    ))}
                  </select>
                </label>

                <label htmlFor="group-stage-format">
                  Group match format
                  <select
                    id="group-stage-format"
                    value={formState.groupStageFormat}
                    onChange={(event) =>
                      updateField("groupStageFormat", event.target.value as MatchFormat)
                    }
                  >
                    {groupStageMatchFormats.map((format) => (
                      <option key={format} value={format}>
                        {matchFormatLabels[format]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <p className="muted">
                {getGroupStageFormatSummary({
                  groupsCount: Number.parseInt(formState.groupsCount || "0", 10),
                  qualifiersPerGroup: Number.parseInt(formState.qualifiersPerGroup || "0", 10),
                })}
                . Empty group slots become BYE/no-match slots.
              </p>
            </>
          ) : null}

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
