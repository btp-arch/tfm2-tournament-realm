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
  automationModeLabels,
  bothCheckedInNoResultPolicyLabels,
  buildAutomationPolicyPayload,
  getAutomationPolicyWarnings,
  getDefaultAutomationPolicy,
  neitherCheckedInTimeoutPolicyLabels,
  oneCheckedInTimeoutPolicyLabels,
  type AutomationMode,
  type BothCheckedInNoResultPolicy,
  type NeitherCheckedInTimeoutPolicy,
  type OneCheckedInTimeoutPolicy,
  type TournamentAutomationPolicy,
} from "@/lib/tournament-automation";
import {
  buildTimingInsertPayload,
  getDefaultTournamentTimingSettings,
  maxTournamentTimerMinutes,
  minTournamentTimerMinutes,
  validateTournamentTimingSettings,
  type TournamentTimingSettings,
} from "@/lib/tournament-timing";
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
  automation: TournamentAutomationPolicy;
  timing: TournamentTimingSettings;
};

const defaultTimingSettings = getDefaultTournamentTimingSettings();
const defaultAutomationPolicy = getDefaultAutomationPolicy();

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
  automation: defaultAutomationPolicy,
  timing: defaultTimingSettings,
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

  function updateTimingField<Field extends keyof TournamentTimingSettings>(
    field: Field,
    value: TournamentTimingSettings[Field],
  ) {
    setFormState((current) => ({
      ...current,
      timing: {
        ...current.timing,
        [field]: value,
      },
    }));
  }

  function updateAutomationField<Field extends keyof TournamentAutomationPolicy>(
    field: Field,
    value: TournamentAutomationPolicy[Field],
  ) {
    setFormState((current) => ({
      ...current,
      automation: {
        ...current.automation,
        [field]: value,
      },
    }));
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

    const timingValidationError = validateTournamentTimingSettings(formState.timing);

    if (timingValidationError) {
      setError(timingValidationError);
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
          ...buildTimingInsertPayload(formState.timing),
          ...buildAutomationPolicyPayload(formState.automation),
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

          <section className="form-section">
            <div>
              <h2>Timing Settings</h2>
              <p className="muted">
                Timers are displayed to players and controlled manually by tournament staff.
              </p>
            </div>

            <div className="form-grid">
              <label htmlFor="check-in-window-minutes">
                Check-in window minutes
                <input
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
                checked={formState.automation.autoOpenReadyMatches}
                id="auto-open-ready-matches"
                type="checkbox"
                onChange={(event) =>
                  updateAutomationField("autoOpenReadyMatches", event.target.checked)
                }
              />
              Allow automatic ready-match opening when both players are known
            </label>
          </section>

          <section className="form-section">
            <div>
              <h2>Automation Policy</h2>
              <p className="muted">
                Manual mode recommends actions. Automatic mode may run enabled actions from app activity.
              </p>
            </div>

            <label htmlFor="automation-mode">
              Automation mode
              <select
                id="automation-mode"
                value={formState.automation.automationMode}
                onChange={(event) =>
                  updateAutomationField("automationMode", event.target.value as AutomationMode)
                }
              >
                {Object.entries(automationModeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <div className="form-grid">
              <label className="checkbox-label" htmlFor="auto-close-registration">
                <input
                  checked={formState.automation.autoCloseRegistrationAtDeadline}
                  id="auto-close-registration"
                  type="checkbox"
                  onChange={(event) =>
                    updateAutomationField("autoCloseRegistrationAtDeadline", event.target.checked)
                  }
                />
                Allow automatic registration close at deadline
              </label>

              <label className="checkbox-label" htmlFor="auto-open-check-in">
                <input
                  checked={formState.automation.autoOpenCheckInAtStartTime}
                  id="auto-open-check-in"
                  type="checkbox"
                  onChange={(event) =>
                    updateAutomationField("autoOpenCheckInAtStartTime", event.target.checked)
                  }
                />
                Allow automatic check-in open at start time
              </label>

              <label className="checkbox-label" htmlFor="auto-close-check-in">
                <input
                  checked={formState.automation.autoCloseCheckInAtDeadline}
                  id="auto-close-check-in"
                  type="checkbox"
                  onChange={(event) =>
                    updateAutomationField("autoCloseCheckInAtDeadline", event.target.checked)
                  }
                />
                Allow automatic check-in close at deadline
              </label>

              <label className="checkbox-label" htmlFor="auto-open-replacement">
                <input
                  checked={formState.automation.autoOpenReplacementWindowIfSpotsAvailable}
                  id="auto-open-replacement"
                  type="checkbox"
                  onChange={(event) =>
                    updateAutomationField(
                      "autoOpenReplacementWindowIfSpotsAvailable",
                      event.target.checked,
                    )
                  }
                />
                Allow automatic replacement window opening
              </label>

              <label className="checkbox-label" htmlFor="auto-close-replacement">
                <input
                  checked={formState.automation.autoCloseReplacementWindowAtDeadline}
                  id="auto-close-replacement"
                  type="checkbox"
                  onChange={(event) =>
                    updateAutomationField("autoCloseReplacementWindowAtDeadline", event.target.checked)
                  }
                />
                Allow automatic replacement window close at deadline
              </label>

              <label className="checkbox-label" htmlFor="auto-generate-draw">
                <input
                  checked={formState.automation.autoGenerateDrawAfterReplacement}
                  id="auto-generate-draw"
                  type="checkbox"
                  onChange={(event) =>
                    updateAutomationField("autoGenerateDrawAfterReplacement", event.target.checked)
                  }
                />
                Allow automatic draw or bracket generation
              </label>

              <label className="checkbox-label" htmlFor="auto-timeout-outcomes">
                <input
                  checked={formState.automation.autoApplyMatchTimeoutOutcomes}
                  id="auto-timeout-outcomes"
                  type="checkbox"
                  onChange={(event) =>
                    updateAutomationField("autoApplyMatchTimeoutOutcomes", event.target.checked)
                  }
                />
                Allow automatic match timeout outcomes
              </label>

              <label className="checkbox-label" htmlFor="auto-playoff-generation">
                <input
                  checked={formState.automation.autoGeneratePlayoffWhenGroupsResolved}
                  id="auto-playoff-generation"
                  type="checkbox"
                  onChange={(event) =>
                    updateAutomationField("autoGeneratePlayoffWhenGroupsResolved", event.target.checked)
                  }
                />
                Allow automatic playoff generation when groups resolve
              </label>
            </div>

            <div className="form-grid">
              <label htmlFor="one-checked-in-policy">
                One player checked in
                <select
                  id="one-checked-in-policy"
                  value={formState.automation.oneCheckedInTimeoutPolicy}
                  onChange={(event) =>
                    updateAutomationField(
                      "oneCheckedInTimeoutPolicy",
                      event.target.value as OneCheckedInTimeoutPolicy,
                    )
                  }
                >
                  {Object.entries(oneCheckedInTimeoutPolicyLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label htmlFor="neither-group-policy">
                Neither checked in: groups
                <select
                  id="neither-group-policy"
                  value={formState.automation.neitherCheckedInGroupPolicy}
                  onChange={(event) =>
                    updateAutomationField(
                      "neitherCheckedInGroupPolicy",
                      event.target.value as NeitherCheckedInTimeoutPolicy,
                    )
                  }
                >
                  {Object.entries(neitherCheckedInTimeoutPolicyLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label htmlFor="neither-bracket-policy">
                Neither checked in: bracket
                <select
                  id="neither-bracket-policy"
                  value={formState.automation.neitherCheckedInBracketPolicy}
                  onChange={(event) =>
                    updateAutomationField(
                      "neitherCheckedInBracketPolicy",
                      event.target.value as NeitherCheckedInTimeoutPolicy,
                    )
                  }
                >
                  {Object.entries(neitherCheckedInTimeoutPolicyLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label htmlFor="both-no-result-policy">
                Both checked in, no result
                <select
                  id="both-no-result-policy"
                  value={formState.automation.bothCheckedInNoResultPolicy}
                  onChange={(event) =>
                    updateAutomationField(
                      "bothCheckedInNoResultPolicy",
                      event.target.value as BothCheckedInNoResultPolicy,
                    )
                  }
                >
                  {Object.entries(bothCheckedInNoResultPolicyLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {getAutomationPolicyWarnings(formState.automation).map((warning) => (
              <p className="error" key={warning}>
                {warning}
              </p>
            ))}
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

          {error ? <p className="error">{error}</p> : null}

          <button className="button" disabled={isSaving} type="submit">
            {isSaving ? "Creating..." : "Create Tournament"}
          </button>
        </div>
      </form>
    </>
  );
}
