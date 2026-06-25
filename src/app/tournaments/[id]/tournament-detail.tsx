"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import {
  bracketSizes,
  generateSingleEliminationMatches,
  getBracketSetupWarning,
  getDefaultRoundFormats,
  getRoundName,
  isBracketSize,
  seedingMethodLabels,
  seedingMethods,
  type BracketSize,
  type SeedingMethod,
} from "@/lib/brackets";
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
  matchFormats,
  matchStatusLabels,
  tournamentStatusDescriptions,
  tournamentFormatLabels,
  tournamentStatusLabels,
  type MatchFormat,
  type MatchRow,
  type TournamentCheckInRow,
  type TournamentRegistrationRow,
  type TournamentRoundRow,
  type TournamentRow,
  type TournamentStageRow,
  type TournamentStatus,
} from "@/lib/tournaments";

type PublicProfile = {
  id: string;
  display_name: string | null;
};

type RegistrationCountRow = {
  tournament_id: string | null;
  active_registration_count: number | null;
};

type Participant = {
  registrationId: string;
  userId: string;
  displayName: string;
  registrationStatus: TournamentRegistrationRow["status"];
  registeredAt: string;
  checkIn: TournamentCheckInRow | null;
};

type SavingAction =
  | "register"
  | "withdraw"
  | "status"
  | "cancel"
  | "delete"
  | "reopen"
  | "close"
  | "check-in"
  | "manual-check-in"
  | "manual-uncheck"
  | "generate"
  | "admin-force-check-in"
  | "admin-force-start"
  | "reset"
  | "activate"
  | null;

type ActiveSavingAction = Exclude<SavingAction, null>;

function getProfileName(profiles: Record<string, PublicProfile>, userId: string | null) {
  if (!userId) {
    return null;
  }

  return profiles[userId]?.display_name ?? "Player";
}

function describeMatchSlot(
  userId: string | null,
  profiles: Record<string, PublicProfile>,
  seed: number | null,
  fallback: "BYE" | "TBD",
) {
  const name = getProfileName(profiles, userId);

  if (!name) {
    return fallback;
  }

  return seed ? `${seed}. ${name}` : name;
}

function isActiveRegistration(registration: TournamentRegistrationRow | null) {
  return Boolean(
    registration &&
      registration.status !== "withdrawn" &&
      registration.status !== "rejected",
  );
}

function shuffleParticipants(participants: Participant[]) {
  const shuffled = participants.slice();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function orderParticipantsForSeeding(
  participants: Participant[],
  seedingMethod: SeedingMethod,
) {
  if (seedingMethod === "random") {
    return shuffleParticipants(participants);
  }

  return participants.slice().sort((first, second) => {
    if (seedingMethod === "registration_order") {
      return first.registeredAt.localeCompare(second.registeredAt) || first.userId.localeCompare(second.userId);
    }

    const firstCheckedAt = first.checkIn?.checked_in_at ?? first.registeredAt;
    const secondCheckedAt = second.checkIn?.checked_in_at ?? second.registeredAt;

    return firstCheckedAt.localeCompare(secondCheckedAt) || first.userId.localeCompare(second.userId);
  });
}

function isEligibleParticipant(participant: Participant) {
  return participant.registrationStatus !== "withdrawn" && participant.registrationStatus !== "rejected";
}

function getTournamentStatusGuidance(
  status: TournamentStatus,
  hasGeneratedBracket: boolean,
  checkedInCount: number,
  registeredCount: number,
) {
  if (status === "registration_open") {
    return {
      current: "Players can register and registered players may still withdraw.",
      next: "Close registration when the field is set, then open check-in.",
    };
  }

  if (status === "registration_closed") {
    return {
      current: "Registration is locked and no new player check-ins are available yet.",
      next: "Open check-in so registered players can confirm attendance.",
    };
  }

  if (status === "check_in") {
    if (checkedInCount < 2) {
      return {
        current: "Registered players can check in, and staff can manually mark registered players checked in.",
        next: "Wait for at least 2 checked-in players before generating the bracket.",
      };
    }

    return {
      current: "Checked-in players are ready for bracket generation.",
      next: hasGeneratedBracket
        ? "The bracket has already been generated."
        : "Choose bracket size, seeding, and round formats, then generate the bracket and start.",
    };
  }

  if (status === "active") {
    return {
      current: "The tournament is live and the generated bracket is visible.",
      next: "Match rooms and result reporting are intentionally out of scope for this milestone.",
    };
  }

  if (status === "completed") {
    return {
      current: "The tournament is marked completed.",
      next: "No live-event action is recommended.",
    };
  }

  if (status === "cancelled") {
    return {
      current: "The tournament was called off and registration is unavailable.",
      next: "Use delete only for admin cleanup or test mistakes.",
    };
  }

  if (status === "draft") {
    return {
      current: "The tournament is in setup and is not publicly open for registration.",
      next: "Publish by opening registration when setup is ready.",
    };
  }

  return {
    current: tournamentStatusDescriptions[status] ?? "Use the selected tournament status.",
    next: registeredCount > 0 ? "Move the event into the normal live flow when ready." : "Open registration when ready.",
  };
}

export function TournamentDetail({ tournamentId }: { tournamentId: string }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [tournament, setTournament] = useState<TournamentRow | null>(null);
  const [organizer, setOrganizer] = useState<PublicProfile | null>(null);
  const [registration, setRegistration] = useState<TournamentRegistrationRow | null>(null);
  const [ownCheckIn, setOwnCheckIn] = useState<TournamentCheckInRow | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [profileMap, setProfileMap] = useState<Record<string, PublicProfile>>({});
  const [stages, setStages] = useState<TournamentStageRow[]>([]);
  const [rounds, setRounds] = useState<TournamentRoundRow[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [activeRegistrationCount, setActiveRegistrationCount] = useState(0);
  const [totalRegistrationCount, setTotalRegistrationCount] = useState(0);
  const [isManagedByUser, setIsManagedByUser] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<TournamentStatus>("draft");
  const [selectedBracketSize, setSelectedBracketSize] = useState<BracketSize>(4);
  const [selectedSeedingMethod, setSelectedSeedingMethod] = useState<SeedingMethod>("random");
  const [roundFormats, setRoundFormats] = useState<MatchFormat[]>(getDefaultRoundFormats(4));
  const [adminDeleteConfirmation, setAdminDeleteConfirmation] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingAction, setSavingAction] = useState<SavingAction>(null);
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
        checkInResult,
        stagesResult,
        roundsResult,
        matchesResult,
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
        currentUser
          ? supabase
              .from("tournament_check_ins")
              .select("*")
              .eq("tournament_id", loadedTournament.id)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from("tournament_stages")
          .select("*")
          .eq("tournament_id", loadedTournament.id)
          .order("stage_number", { ascending: true }),
        supabase
          .from("tournament_rounds")
          .select("*")
          .eq("tournament_id", loadedTournament.id)
          .order("round_number", { ascending: true }),
        supabase
          .from("matches")
          .select("*")
          .eq("tournament_id", loadedTournament.id)
          .order("round_number", { ascending: true })
          .order("bracket_position", { ascending: true }),
      ]);

      if (organizerResult.error) throw organizerResult.error;
      if (countResult.error) throw countResult.error;
      if (registrationResult.error) throw registrationResult.error;
      if (organizerAccessResult.error) throw organizerAccessResult.error;
      if (totalRegistrationsResult.error) throw totalRegistrationsResult.error;
      if (checkInResult.error) throw checkInResult.error;
      if (stagesResult.error) throw stagesResult.error;
      if (roundsResult.error) throw roundsResult.error;
      if (matchesResult.error) throw matchesResult.error;

      const countRow = countResult.data as RegistrationCountRow | null;
      const checkIns = (checkInResult.data ?? []) as TournamentCheckInRow[];
      const canManageLoaded =
        Boolean(currentUser) &&
        (loadedRoles.isAdmin ||
          loadedTournament.created_by === currentUser?.id ||
          Boolean(organizerAccessResult.data));
      let loadedParticipants: Participant[] = [];
      let loadedProfileMap: Record<string, PublicProfile> = {};

      if (canManageLoaded) {
        const { data: registrationRows, error: registrationsError } = await supabase
          .from("tournament_registrations")
          .select("*")
          .eq("tournament_id", loadedTournament.id)
          .neq("status", "withdrawn")
          .order("created_at", { ascending: true });

        if (registrationsError) {
          throw registrationsError;
        }

        const userIds = Array.from(
          new Set([
            loadedTournament.created_by,
            ...stagesResult.data.map((stage) => stage.generated_by),
            ...registrationRows.map((row) => row.user_id),
            ...matchesResult.data.flatMap((match) => [
              match.player_one_id,
              match.player_two_id,
              match.winner_id,
            ]),
          ].filter(Boolean) as string[]),
        );

        if (userIds.length > 0) {
          const { data: profiles, error: profilesError } = await supabase
            .from("public_profiles")
            .select("id, display_name")
            .in("id", userIds);

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

        loadedParticipants = registrationRows.map((row) => ({
          registrationId: row.id,
          userId: row.user_id,
          displayName: getProfileName(loadedProfileMap, row.user_id) ?? "Player",
          registrationStatus: row.status,
          registeredAt: row.created_at,
          checkIn: checkIns.find((checkIn) => checkIn.user_id === row.user_id) ?? null,
        }));
      } else {
        const matchUserIds = Array.from(
          new Set(
            [
              loadedTournament.created_by,
              ...stagesResult.data.map((stage) => stage.generated_by),
              ...matchesResult.data.flatMap((match) => [
                match.player_one_id,
                match.player_two_id,
                match.winner_id,
              ]),
            ]
              .filter(Boolean) as string[],
          ),
        );

        if (matchUserIds.length > 0) {
          const { data: profiles, error: profilesError } = await supabase
            .from("public_profiles")
            .select("id, display_name")
            .in("id", matchUserIds);

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
      }

      setUser(currentUser);
      setRoles(loadedRoles);
      setTournament(loadedTournament);
      setOrganizer(organizerResult.data as PublicProfile | null);
      setRegistration(registrationResult.data);
      setOwnCheckIn(
        currentUser ? checkIns.find((checkIn) => checkIn.user_id === currentUser.id) ?? null : null,
      );
      setParticipants(loadedParticipants);
      setProfileMap(loadedProfileMap);
      setStages(stagesResult.data);
      setRounds(roundsResult.data);
      setMatches(matchesResult.data);
      setActiveRegistrationCount(countRow?.active_registration_count ?? 0);
      setTotalRegistrationCount(totalRegistrationsResult.count ?? 0);
      setIsManagedByUser(Boolean(organizerAccessResult.data));
      setSelectedStatus(loadedTournament.status);
      setAdminDeleteConfirmation("");

      const firstStage = stagesResult.data[0];
      if (firstStage && isBracketSize(firstStage.bracket_size)) {
        setSelectedBracketSize(firstStage.bracket_size);
        setSelectedSeedingMethod(firstStage.seeding_method);
      }
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

  const registeredParticipants = useMemo(() => {
    return participants.filter(isEligibleParticipant);
  }, [participants]);

  const checkedInParticipants = useMemo(() => {
    return registeredParticipants.filter((participant) => Boolean(participant.checkIn));
  }, [registeredParticipants]);

  const bracketWarning = getBracketSetupWarning(
    checkedInParticipants.length,
    selectedBracketSize,
  );
  const hasGeneratedBracket = stages.length > 0;
  const registrationBlockedReason = tournament
    ? getRegistrationBlockedReason(tournament, activeRegistrationCount, registration, Boolean(user))
    : null;
  const canRegister = tournament
    ? Boolean(user) && canRegisterForTournament(tournament, activeRegistrationCount, registration)
    : false;
  const canWithdraw = tournament ? canWithdrawFromTournament(tournament, registration) : false;
  const canCheckIn = Boolean(
    user &&
      tournament?.status === "check_in" &&
      isActiveRegistration(registration) &&
      !ownCheckIn,
  );
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
  const activeStage = stages[0] ?? null;
  const statusGuidance = tournament
    ? getTournamentStatusGuidance(
        tournament.status,
        hasGeneratedBracket,
        checkedInParticipants.length,
        registeredParticipants.length,
      )
    : null;
  const adminForceStartParticipantCount =
    checkedInParticipants.length > 0 ? checkedInParticipants.length : registeredParticipants.length;
  const adminForceStartWarning =
    tournament && roles.isAdmin && !hasGeneratedBracket
      ? getBracketSetupWarning(adminForceStartParticipantCount, selectedBracketSize)
      : null;
  const canAdminForceStart = Boolean(
    tournament &&
      roles.isAdmin &&
      !hasGeneratedBracket &&
      tournament.status !== "active" &&
      tournament.status !== "completed" &&
      tournament.status !== "cancelled" &&
      adminForceStartParticipantCount >= 2 &&
      adminForceStartParticipantCount <= selectedBracketSize,
  );

  function updateBracketSize(value: number) {
    if (!isBracketSize(value)) {
      return;
    }

    setSelectedBracketSize(value);
    setRoundFormats(getDefaultRoundFormats(value));
  }

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

  async function checkInForTournament() {
    if (!user || !tournament || !canCheckIn) {
      return;
    }

    setSavingAction("check-in");
    setNotice(null);
    setError(null);

    try {
      const { error: insertError } = await supabase.from("tournament_check_ins").insert({
        tournament_id: tournament.id,
        user_id: user.id,
        checked_in_by: user.id,
      });

      if (insertError) {
        throw insertError;
      }

      setNotice("You are checked in.");
      await loadTournament();
    } catch (caughtError) {
      logError("Tournament check-in failed.", caughtError);
      setError(formatError(caughtError, "Unable to check in for this tournament."));
    } finally {
      setSavingAction(null);
    }
  }

  async function updateTournamentStatusTo(
    status: TournamentStatus,
    successMessage: string,
    action: SavingAction = "status",
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

    if (status === "active") {
      if (!hasGeneratedBracket) {
        setError("Generate a bracket before setting the tournament active.");
        return;
      }

      if (!roles.isAdmin && tournament.status !== "check_in") {
        setError("Open check-in before starting the tournament.");
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

  async function manualCheckIn(participant: Participant) {
    if (!user || !tournament || !canManageTournament || participant.checkIn) {
      return;
    }

    setSavingAction("manual-check-in");
    setNotice(null);
    setError(null);

    try {
      const { error: insertError } = await supabase.from("tournament_check_ins").insert({
        tournament_id: tournament.id,
        user_id: participant.userId,
        checked_in_by: user.id,
      });

      if (insertError) {
        throw insertError;
      }

      setNotice(`${participant.displayName} checked in.`);
      await loadTournament();
    } catch (caughtError) {
      logError("Manual tournament check-in failed.", caughtError);
      setError(formatError(caughtError, "Unable to update participant check-in."));
    } finally {
      setSavingAction(null);
    }
  }

  async function manualUncheck(participant: Participant) {
    if (!participant.checkIn || !canManageTournament) {
      return;
    }

    setSavingAction("manual-uncheck");
    setNotice(null);
    setError(null);

    try {
      const { error: deleteError } = await supabase
        .from("tournament_check_ins")
        .delete()
        .eq("id", participant.checkIn.id);

      if (deleteError) {
        throw deleteError;
      }

      setNotice(`${participant.displayName} unchecked.`);
      await loadTournament();
    } catch (caughtError) {
      logError("Manual tournament uncheck failed.", caughtError);
      setError(formatError(caughtError, "Unable to remove participant check-in."));
    } finally {
      setSavingAction(null);
    }
  }

  async function createBracketFromParticipants(
    participantsToSeed: Participant[],
    action: ActiveSavingAction,
    successMessage: string,
  ) {
    if (!user || !tournament || !canManageTournament) {
      return;
    }

    if (hasGeneratedBracket) {
      setError("This tournament already has a generated bracket. Reset it before generating again.");
      return;
    }

    const blockingWarning = getBracketSetupWarning(
      participantsToSeed.length,
      selectedBracketSize,
    );

    if (
      participantsToSeed.length < 2 ||
      participantsToSeed.length > selectedBracketSize
    ) {
      setError(blockingWarning ?? "Unable to generate bracket with the current check-in count.");
      return;
    }

    setSavingAction(action);
    setNotice(null);
    setError(null);
    let createdStageId: string | null = null;

    try {
      const seededPlayers = orderParticipantsForSeeding(
        participantsToSeed,
        selectedSeedingMethod,
      )
        .map((participant, index) => ({
          userId: participant.userId,
          seed: index + 1,
        }));

      const { data: stage, error: stageError } = await supabase
        .from("tournament_stages")
        .insert({
          tournament_id: tournament.id,
          stage_number: 1,
          name: "Single Elimination",
          bracket_type: "single_elimination",
          bracket_size: selectedBracketSize,
          seeding_method: selectedSeedingMethod,
          generated_by: user.id,
        })
        .select()
        .single();

      if (stageError) {
        throw stageError;
      }

      createdStageId = stage.id;

      const { data: createdRounds, error: roundsError } = await supabase
        .from("tournament_rounds")
        .insert(
          roundFormats.map((format, index) => ({
            tournament_id: tournament.id,
            stage_id: stage.id,
            round_number: index + 1,
            name: getRoundName(selectedBracketSize, index + 1),
            match_format: format,
          })),
        )
        .select();

      if (roundsError) {
        throw roundsError;
      }

      const roundByNumber = new Map(
        createdRounds.map((round) => [round.round_number, round]),
      );
      const generatedMatches = generateSingleEliminationMatches(
        seededPlayers,
        selectedBracketSize,
        roundFormats,
      );

      const { error: matchesError } = await supabase.from("matches").insert(
        generatedMatches.map((match) => ({
          tournament_id: tournament.id,
          stage_id: stage.id,
          round_id: roundByNumber.get(match.roundNumber)?.id ?? null,
          round_number: match.roundNumber,
          match_number: match.matchNumber,
          bracket_position: match.bracketPosition,
          player_one_id: match.playerOneId,
          player_two_id: match.playerTwoId,
          player_one_seed: match.playerOneSeed,
          player_two_seed: match.playerTwoSeed,
          player_one_slot: match.playerOneSlot,
          player_two_slot: match.playerTwoSlot,
          format: match.format,
          status: match.status,
          winner_id: match.winnerId,
        })),
      );

      if (matchesError) {
        throw matchesError;
      }

      const { error: statusError } = await supabase
        .from("tournaments")
        .update({
          status: "active",
          updated_at: new Date().toISOString(),
        })
        .eq("id", tournament.id);

      if (statusError) {
        throw statusError;
      }

      setNotice(successMessage);
      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      if (createdStageId) {
        await supabase.from("tournament_stages").delete().eq("id", createdStageId);
      }

      logError("Bracket generation failed.", caughtError);
      setError(formatError(caughtError, "Unable to generate bracket."));
    } finally {
      setSavingAction(null);
    }
  }

  async function generateBracket() {
    if (!tournament || !canManageTournament) {
      return;
    }

    if (tournament.status !== "check_in") {
      setError("Open check-in before generating the bracket and starting the tournament.");
      return;
    }

    await createBracketFromParticipants(
      checkedInParticipants,
      "generate",
      "Bracket generated and tournament started.",
    );
  }

  async function adminForceOpenCheckIn() {
    if (!tournament || !roles.isAdmin) {
      return;
    }

    await updateTournamentStatusTo(
      "check_in",
      "Admin force opened check-in.",
      "admin-force-check-in",
    );
  }

  async function adminForceStartTournament() {
    if (!user || !tournament || !roles.isAdmin || !canAdminForceStart) {
      return;
    }

    const shouldCheckInAllRegistered = checkedInParticipants.length === 0;
    let participantsToSeed = checkedInParticipants;

    if (shouldCheckInAllRegistered) {
      const confirmed = window.confirm(
        `Admin force start will mark all ${registeredParticipants.length} registered player${
          registeredParticipants.length === 1 ? "" : "s"
        } checked in, generate the bracket, and start the tournament. Continue?`,
      );

      if (!confirmed) {
        return;
      }

      setSavingAction("admin-force-start");
      setNotice(null);
      setError(null);

      try {
        if (tournament.status !== "check_in") {
          const { error: statusError } = await supabase
            .from("tournaments")
            .update({
              status: "check_in",
              updated_at: new Date().toISOString(),
            })
            .eq("id", tournament.id);

          if (statusError) {
            throw statusError;
          }
        }

        const baseCheckedInAt = Date.now();
        const forcedCheckIns = registeredParticipants.map((participant, index) => {
          const checkedInAt = new Date(baseCheckedInAt + index).toISOString();

          return {
            tournament_id: tournament.id,
            user_id: participant.userId,
            checked_in_by: user.id,
            checked_in_at: checkedInAt,
          };
        });

        const { error: insertError } = await supabase
          .from("tournament_check_ins")
          .insert(forcedCheckIns);

        if (insertError) {
          throw insertError;
        }

        participantsToSeed = registeredParticipants.map((participant, index) => {
          const checkedInAt = forcedCheckIns[index]?.checked_in_at ?? new Date().toISOString();

          return {
            ...participant,
            checkIn: {
              checked_in_at: checkedInAt,
              checked_in_by: user.id,
              created_at: checkedInAt,
              id: `${participant.registrationId}-admin-force-check-in`,
              tournament_id: tournament.id,
              updated_at: checkedInAt,
              user_id: participant.userId,
            },
          };
        });
      } catch (caughtError) {
        logError("Admin force check-in failed.", caughtError);
        setError(formatError(caughtError, "Unable to mark registered players checked in."));
        setSavingAction(null);
        return;
      }
    }

    await createBracketFromParticipants(
      participantsToSeed,
      "admin-force-start",
      shouldCheckInAllRegistered
        ? `Admin force started tournament with ${participantsToSeed.length} registered players checked in.`
        : "Admin force started tournament from checked-in players.",
    );
  }

  async function resetBracket() {
    if (!tournament || !canManageTournament || !hasGeneratedBracket) {
      return;
    }

    const confirmed = window.confirm(
      "Reset the generated bracket? This is only allowed before match events or reports exist.",
    );
    if (!confirmed) {
      return;
    }

    setSavingAction("reset");
    setNotice(null);
    setError(null);

    try {
      const { error: deleteError } = await supabase
        .from("tournament_stages")
        .delete()
        .eq("tournament_id", tournament.id);

      if (deleteError) {
        throw deleteError;
      }

      if (tournament.status === "active") {
        const { error: statusError } = await supabase
          .from("tournaments")
          .update({
            status: "check_in",
            updated_at: new Date().toISOString(),
          })
          .eq("id", tournament.id);

        if (statusError) {
          throw statusError;
        }
      }

      setNotice("Generated bracket reset.");
      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      logError("Bracket reset failed.", caughtError);
      setError(formatError(caughtError, "Unable to reset bracket."));
    } finally {
      setSavingAction(null);
    }
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

  const matchesByRound = rounds.map((round) => ({
    round,
    matches: matches.filter((match) => match.round_id === round.id),
  }));

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

      {statusGuidance ? (
        <section className="card">
          <h2>Event Status</h2>
          <p>
            <strong>{tournamentStatusLabels[tournament.status]}:</strong> {statusGuidance.current}
          </p>
          <p className="muted">Recommended next action: {statusGuidance.next}</p>
        </section>
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
              <dt>Default Matches</dt>
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
            <p className="muted">Registration and check-in use your signed-in account.</p>
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
        <div className="section-heading">
          <div>
            <h2>Check-In</h2>
            <p className="muted">
              {tournament.status === "check_in"
                ? "Check-in is open for registered players."
                : `Check-in is not open. Current status: ${tournamentStatusLabels[tournament.status]}.`}
            </p>
          </div>
          {ownCheckIn ? <span className="badge">Checked In</span> : null}
        </div>

        {!user ? (
          <p className="muted">Sign in to check in after registration is locked.</p>
        ) : ownCheckIn ? (
          <p className="notice">You checked in at {formatDateTime(ownCheckIn.checked_in_at)}.</p>
        ) : canCheckIn ? (
          <button
            className="button"
            disabled={savingAction === "check-in"}
            type="button"
            onClick={checkInForTournament}
          >
            {savingAction === "check-in" ? "Checking in..." : "Check In"}
          </button>
        ) : !isActiveRegistration(registration) ? (
          <p className="muted">You must be registered for this tournament before you can check in.</p>
        ) : (
          <p className="muted">Check-in opens after tournament staff move the event to check-in.</p>
        )}
      </section>

      <section className="card">
        <h2>Bracket</h2>
        {activeStage ? (
          <>
            <p className="muted">
              {activeStage.name}, {activeStage.bracket_size} players. Round formats are stored on each round.
            </p>
            <dl className="meta-grid">
              <div>
                <dt>Seeding</dt>
                <dd>{seedingMethodLabels[activeStage.seeding_method]}</dd>
              </div>
              <div>
                <dt>Generated By</dt>
                <dd>{getProfileName(profileMap, activeStage.generated_by) ?? "Tournament staff"}</dd>
              </div>
              <div>
                <dt>Generated At</dt>
                <dd>{formatDateTime(activeStage.created_at)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="muted">No bracket has been generated yet.</p>
        )}

        {matchesByRound.length > 0 ? (
          <div className="bracket-rounds">
            {matchesByRound.map(({ round, matches: roundMatches }) => (
              <section className="bracket-round" key={round.id}>
                <div className="section-heading">
                  <h3>{round.name}</h3>
                  <span className="badge">{matchFormatLabels[round.match_format]}</span>
                </div>
                <div className="match-list">
                  {roundMatches.map((match) => {
                    const playerOneFallback = match.player_two_id ? "TBD" : "BYE";
                    const playerTwoFallback = match.player_one_id ? "BYE" : "TBD";
                    const shouldLinkMatch = match.status !== "bye";

                    return (
                      <article className="match-row" key={match.id}>
                        <div>
                          <strong>Match {match.match_number ?? match.bracket_position}</strong>
                          <p className="muted">
                            {describeMatchSlot(
                              match.player_one_id,
                              profileMap,
                              match.player_one_seed,
                              playerOneFallback,
                            )}{" "}
                            vs{" "}
                            {describeMatchSlot(
                              match.player_two_id,
                              profileMap,
                              match.player_two_seed,
                              playerTwoFallback,
                            )}
                          </p>
                        </div>
                        <div className="role-actions">
                          <span className="badge">{matchFormatLabels[match.format]}</span>
                          <span className="badge">{matchStatusLabels[match.status]}</span>
                          {shouldLinkMatch ? (
                            <Link
                              className="button secondary-button button-link"
                              href={`/matches/${match.id}`}
                            >
                              Match Room
                            </Link>
                          ) : (
                            <span className="muted">BYE, no room action</span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : null}
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
                {checkedInParticipants.length}/{activeRegistrationCount} active participants checked in.
              </p>
            </div>
            <Link className="button secondary-button button-link" href={`/tournaments/${tournament.id}/edit`}>
              Edit Tournament
            </Link>
          </div>

          {roles.isAdmin ? (
            <div className="management-actions">
              <div>
                <h3>Admin Status Override</h3>
                <p className="muted">
                  {tournamentStatusDescriptions[selectedStatus] ?? "Use the selected tournament status."}
                </p>
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
            </div>
          ) : null}

          <div className="management-actions">
            <div>
              <h3>Event Flow</h3>
              <p className="muted">Normal organizer flow is registration open, registration closed, check-in, then bracket start.</p>
            </div>
            <div className="role-actions">
              <button
                className="button secondary-button"
                disabled={savingAction === "close" || tournament.status !== "registration_open"}
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
              <button
                className="button secondary-button"
                disabled={savingAction === "status" || tournament.status !== "registration_closed"}
                type="button"
                onClick={() =>
                  updateTournamentStatusTo(
                    "check_in",
                    "Check-in opened.",
                    "status",
                  )
                }
              >
                {savingAction === "status" ? "Opening..." : "Open Check-In"}
              </button>
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
            </div>
          </div>

          {roles.isAdmin ? (
            <div className="management-actions">
              <div>
                <h3>Admin Start Overrides</h3>
                <p className="muted">
                  Force start includes {adminForceStartParticipantCount} player{adminForceStartParticipantCount === 1 ? "" : "s"} with the current bracket settings.
                </p>
                {checkedInParticipants.length === 0 && registeredParticipants.length > 0 ? (
                  <p className="muted">
                    Admin Force Start will ask for confirmation before marking all registered players checked in.
                  </p>
                ) : null}
                {adminForceStartWarning ? (
                  <p className="muted">{adminForceStartWarning}</p>
                ) : null}
              </div>
              <div className="role-actions">
                <button
                  className="button secondary-button"
                  disabled={
                    savingAction === "admin-force-check-in" ||
                    tournament.status === "check_in" ||
                    tournament.status === "active" ||
                    tournament.status === "completed" ||
                    tournament.status === "cancelled"
                  }
                  type="button"
                  onClick={adminForceOpenCheckIn}
                >
                  {savingAction === "admin-force-check-in"
                    ? "Opening..."
                    : "Admin Force Open Check-In"}
                </button>
                <button
                  className="button"
                  disabled={savingAction === "admin-force-start" || !canAdminForceStart}
                  type="button"
                  onClick={adminForceStartTournament}
                >
                  {savingAction === "admin-force-start"
                    ? "Starting..."
                    : "Admin Force Start Tournament"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="management-actions">
            <div>
              <h3>Participant Check-In</h3>
              <p className="muted">Manually include or remove registered players during check-in.</p>
            </div>
          </div>

          <div className="participant-list">
            {participants.length === 0 ? (
              <p className="muted">No registered participants yet.</p>
            ) : (
              participants.map((participant) => (
                <article className="participant-row" key={participant.registrationId}>
                  <div>
                    <strong>{participant.displayName}</strong>
                    <p className="muted">
                      {participant.checkIn
                        ? `Checked in ${formatDateTime(participant.checkIn.checked_in_at)}`
                        : "Not checked in"}
                    </p>
                  </div>
                  <div className="role-actions">
                    <span className="badge">
                      {participant.checkIn ? "Checked In" : "Missing"}
                    </span>
                    {participant.checkIn ? (
                      <button
                        className="button secondary-button"
                        disabled={savingAction === "manual-uncheck" || hasGeneratedBracket}
                        type="button"
                        onClick={() => manualUncheck(participant)}
                      >
                        Remove
                      </button>
                    ) : (
                      <button
                        className="button secondary-button"
                        disabled={
                          savingAction === "manual-check-in" ||
                          hasGeneratedBracket ||
                          tournament.status !== "check_in"
                        }
                        type="button"
                        onClick={() => manualCheckIn(participant)}
                      >
                        Mark Checked In
                      </button>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>

          <div className="management-actions">
            <div>
              <h3>Bracket Setup</h3>
              <p className={bracketWarning ? "muted" : undefined}>
                {bracketWarning ?? "Ready to generate the bracket from checked-in players."}
              </p>
            </div>
            <div className="status-control">
              <label htmlFor="bracket-size">
                Bracket Size
                <select
                  id="bracket-size"
                  disabled={hasGeneratedBracket}
                  value={selectedBracketSize}
                  onChange={(event) => updateBracketSize(Number(event.target.value))}
                >
                  {bracketSizes.map((size) => (
                    <option key={size} value={size}>
                      {size} players
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="seeding-method">
                Seeding
                <select
                  id="seeding-method"
                  disabled={hasGeneratedBracket}
                  value={selectedSeedingMethod}
                  onChange={(event) => setSelectedSeedingMethod(event.target.value as SeedingMethod)}
                >
                  {seedingMethods.map((method) => (
                    <option key={method} value={method}>
                      {seedingMethodLabels[method]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="round-format-grid">
            {roundFormats.map((format, index) => (
              <label key={`${selectedBracketSize}-${index}`} htmlFor={`round-format-${index}`}>
                {getRoundName(selectedBracketSize, index + 1)}
                <select
                  id={`round-format-${index}`}
                  disabled={hasGeneratedBracket}
                  value={format}
                  onChange={(event) => {
                    const nextFormats = roundFormats.slice();
                    nextFormats[index] = event.target.value as MatchFormat;
                    setRoundFormats(nextFormats);
                  }}
                >
                  {matchFormats.map((matchFormat) => (
                    <option key={matchFormat} value={matchFormat}>
                      {matchFormatLabels[matchFormat]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="management-actions">
            <div>
              <h3>Generate Bracket And Start</h3>
              <p className="muted">
                Generation creates all rounds, seeds players by {seedingMethodLabels[selectedSeedingMethod].toLowerCase()}, first-round matches, bye advancements, and TBD placeholders.
              </p>
            </div>
            <div className="role-actions">
              <button
                className="button"
                disabled={
                  savingAction === "generate" ||
                  hasGeneratedBracket ||
                  tournament.status !== "check_in" ||
                  checkedInParticipants.length < 2 ||
                  checkedInParticipants.length > selectedBracketSize
                }
                type="button"
                onClick={generateBracket}
              >
                {savingAction === "generate" ? "Starting..." : "Generate Bracket & Start Tournament"}
              </button>
              <button
                className="button danger-button"
                disabled={savingAction === "reset" || !hasGeneratedBracket}
                type="button"
                onClick={resetBracket}
              >
                {savingAction === "reset" ? "Resetting..." : "Reset Bracket"}
              </button>
            </div>
          </div>

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
