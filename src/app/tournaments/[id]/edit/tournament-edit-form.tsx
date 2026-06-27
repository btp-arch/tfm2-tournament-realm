"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { formatError, logError } from "@/lib/errors";
import { bracketSizes } from "@/lib/brackets";
import {
  getGroupStageFormatSummary,
  validateGroupStageFormat,
} from "@/lib/group-stage";
import { ensureProfile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  buildTimingInsertPayload,
  canEditTimingSettings,
  maxTournamentTimerMinutes,
  minTournamentTimerMinutes,
  normalizeTournamentTimingSettings,
  validateTournamentTimingSettings,
  type TournamentTimingSettings,
} from "@/lib/tournament-timing";
import {
  editableTournamentStatuses,
  groupSizes,
  groupStageMatchFormats,
  getRegistrationReopenBlockedReason,
  qualifiersPerGroupOptions,
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
  status: TournamentStatus;
  timing: TournamentTimingSettings;
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
    tournamentFormat: tournament.tournament_format,
    singleEliminationBracketSize: tournament.max_players?.toString() ?? "16",
    groupSize: tournament.group_size?.toString() ?? "4",
    groupsCount: tournament.groups_count?.toString() ?? "4",
    qualifiersPerGroup: tournament.qualifiers_per_group?.toString() ?? "1",
    groupStageFormat: tournament.group_stage_format ?? "bo1",
    preSemifinalFormat: tournament.pre_semifinal_match_format ?? tournament.format,
    semifinalFormat: tournament.semifinal_match_format ?? "bo3",
    finalFormat: tournament.final_match_format ?? "bo5",
    rules: tournament.rules ?? "",
    externalCommunityUrl: tournament.external_community_url ?? "",
    status: editableTournamentStatuses.includes(tournament.status)
      ? tournament.status
      : "draft",
    timing: normalizeTournamentTimingSettings(tournament),
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
  const canEditTiming = Boolean(
    tournament &&
      canEditTimingSettings(tournament, roles, user?.id ?? null, isManagedByUser),
  );

  function updateField<Field extends keyof TournamentFormState>(
    field: Field,
    value: TournamentFormState[Field],
  ) {
    setFormState((current) => (current ? { ...current, [field]: value } : current));
  }

  function updateTimingField<Field extends keyof TournamentTimingSettings>(
    field: Field,
    value: TournamentTimingSettings[Field],
  ) {
    setFormState((current) =>
      current
        ? {
            ...current,
            timing: {
              ...current.timing,
              [field]: value,
            },
          }
        : current,
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!tournament || !formState || !canManageTournament) {
      return;
    }

    const title = formState.title.trim();
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

    if (
      formState.tournamentFormat === "single_elimination" &&
      !bracketSizes.includes(singleEliminationBracketSize as (typeof bracketSizes)[number])
    ) {
      setError("Select a supported single-elimination bracket size.");
      return;
    }

    if (maxPlayers < activeRegistrationCount) {
      setError("Max participants cannot be lower than the current registered participant count.");
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

    const timingValidationError = validateTournamentTimingSettings(formState.timing);

    if (timingValidationError) {
      setError(timingValidationError);
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
          updated_at: new Date().toISOString(),
          ...(canEditTiming ? buildTimingInsertPayload(formState.timing) : {}),
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

          <section className="form-section">
            <div>
              <h2>Timing Settings</h2>
              <p className="muted">
                Settings are editable before check-in starts. During live play, use Live Control to pause or extend timers.
              </p>
            </div>

            <div className="form-grid">
              <label htmlFor="check-in-window-minutes">
                Check-in window minutes
                <input
                  disabled={!canEditTiming}
                  id="check-in-window-minutes"
                  min={minTournamentTimerMinutes}
                  max={maxTournamentTimerMinutes}
                  required
                  type="number"
                  value={formState.timing.checkInWindowMinutes}
                  onChange={(event) =>
                    updateTimingField("checkInWindowMinutes", Number.parseInt(event.target.value, 10))
                  }
                />
              </label>

              <label htmlFor="replacement-window-minutes">
                Replacement window minutes
                <input
                  disabled={!canEditTiming}
                  id="replacement-window-minutes"
                  min={minTournamentTimerMinutes}
                  max={maxTournamentTimerMinutes}
                  required
                  type="number"
                  value={formState.timing.replacementWindowMinutes}
                  onChange={(event) =>
                    updateTimingField("replacementWindowMinutes", Number.parseInt(event.target.value, 10))
                  }
                />
              </label>
            </div>

            <div className="form-grid">
              <label htmlFor="group-bo1-round-minutes">
                Group BO1 minutes
                <input
                  disabled={!canEditTiming}
                  id="group-bo1-round-minutes"
                  min={minTournamentTimerMinutes}
                  max={maxTournamentTimerMinutes}
                  required
                  type="number"
                  value={formState.timing.groupBo1RoundMinutes}
                  onChange={(event) =>
                    updateTimingField("groupBo1RoundMinutes", Number.parseInt(event.target.value, 10))
                  }
                />
              </label>

              <label htmlFor="group-bo3-round-minutes">
                Group BO3 minutes
                <input
                  disabled={!canEditTiming}
                  id="group-bo3-round-minutes"
                  min={minTournamentTimerMinutes}
                  max={maxTournamentTimerMinutes}
                  required
                  type="number"
                  value={formState.timing.groupBo3RoundMinutes}
                  onChange={(event) =>
                    updateTimingField("groupBo3RoundMinutes", Number.parseInt(event.target.value, 10))
                  }
                />
              </label>
            </div>

            <div className="form-grid">
              <label htmlFor="bracket-bo1-round-minutes">
                Bracket BO1 minutes
                <input
                  disabled={!canEditTiming}
                  id="bracket-bo1-round-minutes"
                  min={minTournamentTimerMinutes}
                  max={maxTournamentTimerMinutes}
                  required
                  type="number"
                  value={formState.timing.bracketBo1RoundMinutes}
                  onChange={(event) =>
                    updateTimingField("bracketBo1RoundMinutes", Number.parseInt(event.target.value, 10))
                  }
                />
              </label>

              <label htmlFor="bracket-bo3-round-minutes">
                Bracket BO3 minutes
                <input
                  disabled={!canEditTiming}
                  id="bracket-bo3-round-minutes"
                  min={minTournamentTimerMinutes}
                  max={maxTournamentTimerMinutes}
                  required
                  type="number"
                  value={formState.timing.bracketBo3RoundMinutes}
                  onChange={(event) =>
                    updateTimingField("bracketBo3RoundMinutes", Number.parseInt(event.target.value, 10))
                  }
                />
              </label>

              <label htmlFor="bracket-bo5-round-minutes">
                Bracket BO5 minutes
                <input
                  disabled={!canEditTiming}
                  id="bracket-bo5-round-minutes"
                  min={minTournamentTimerMinutes}
                  max={maxTournamentTimerMinutes}
                  required
                  type="number"
                  value={formState.timing.bracketBo5RoundMinutes}
                  onChange={(event) =>
                    updateTimingField("bracketBo5RoundMinutes", Number.parseInt(event.target.value, 10))
                  }
                />
              </label>
            </div>

            <label className="checkbox-label" htmlFor="replacement-window-enabled">
              <input
                checked={formState.timing.replacementWindowEnabled}
                disabled={!canEditTiming}
                id="replacement-window-enabled"
                type="checkbox"
                onChange={(event) =>
                  updateTimingField("replacementWindowEnabled", event.target.checked)
                }
              />
              Allow replacement window
            </label>

            <label className="checkbox-label" htmlFor="independent-group-progression">
              <input
                checked={formState.timing.independentGroupProgression}
                disabled={!canEditTiming}
                id="independent-group-progression"
                type="checkbox"
                onChange={(event) =>
                  updateTimingField("independentGroupProgression", event.target.checked)
                }
              />
              Allow independent group progression
            </label>

            <label className="checkbox-label" htmlFor="auto-open-ready-matches">
              <input
                checked={formState.timing.autoOpenReadyMatches}
                disabled={!canEditTiming}
                id="auto-open-ready-matches"
                type="checkbox"
                onChange={(event) =>
                  updateTimingField("autoOpenReadyMatches", event.target.checked)
                }
              />
              Auto-open ready matches when both players are known
            </label>

            <label className="checkbox-label" htmlFor="auto-apply-timer-outcomes">
              <input
                checked={formState.timing.autoApplyTimerOutcomes}
                disabled
                id="auto-apply-timer-outcomes"
                type="checkbox"
                onChange={(event) =>
                  updateTimingField("autoApplyTimerOutcomes", event.target.checked)
                }
              />
              Auto-apply timer outcomes (planned; kept off)
            </label>
          </section>

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
