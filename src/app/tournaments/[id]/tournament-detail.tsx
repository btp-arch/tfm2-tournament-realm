"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import {
  ErrorState,
  LoadingState,
  MatchStatusBadge,
  StatusBadge,
  TournamentTierBadge,
} from "@/components/ui";
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
import {
  getMatchSlotFallback,
  getNonPlayableMatchMessage,
  isPlayableMatch,
} from "@/lib/match-rooms";
import { ensureProfile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  canRegisterForTournament,
  canWithdrawFromTournament,
  editableTournamentStatuses,
  formatDateTime,
  formatMatchFinalScore,
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
type TournamentTabKey = "overview" | "players" | "bracket" | "matches" | "rules" | "admin";

type MatchRoundGroup = {
  round: TournamentRoundRow;
  matches: MatchRow[];
};

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
      next: "Players use match rooms to report results; organizers review disputed matches.",
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

function getMatchStatusTone(match: MatchRow): "danger" | "gold" | "muted" | undefined {
  if (match.status === "disputed" || match.status === "needs_admin") {
    return "danger";
  }

  if (
    match.status === "finalized" ||
    match.status === "confirmed" ||
    match.status === "bye"
  ) {
    return "gold";
  }

  return "muted";
}

function getRoundColumnStyle(roundIndex: number): CSSProperties {
  const cardHeight = 124;
  const baseGap = 16;
  const rhythm = cardHeight + baseGap;
  const offset = roundIndex === 0 ? 0 : (rhythm * (2 ** roundIndex - 1)) / 2;
  const gap = rhythm * 2 ** roundIndex - cardHeight;

  return {
    "--round-gap": `${gap}px`,
    "--round-offset": `${offset}px`,
  } as CSSProperties;
}

function getChampionName(matches: MatchRow[], profiles: Record<string, PublicProfile>) {
  const finalWinner = matches
    .slice()
    .sort((first, second) => second.round_number - first.round_number)
    .find((match) => match.winner_id);

  return finalWinner ? getProfileName(profiles, finalWinner.winner_id) : null;
}

function TournamentTabs({
  activeTab,
  canManageTournament,
  onTabChange,
}: {
  activeTab: TournamentTabKey;
  canManageTournament: boolean;
  onTabChange: (tab: TournamentTabKey) => void;
}) {
  const tabs: { key: TournamentTabKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "players", label: "Players" },
    { key: "bracket", label: "Bracket" },
    { key: "matches", label: "Matches" },
    { key: "rules", label: "Rules" },
  ];

  if (canManageTournament) {
    tabs.push({ key: "admin", label: "Organizer/Admin" });
  }

  return (
    <div aria-label="Tournament detail sections" className="tournament-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={activeTab === tab.key}
          className={activeTab === tab.key ? "active" : undefined}
          key={tab.key}
          role="tab"
          type="button"
          onClick={() => onTabChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function MatchSlotLine({
  isWinner,
  label,
  score,
}: {
  isWinner: boolean;
  label: string;
  score: number | null;
}) {
  return (
    <div className={["bracket-slot", isWinner ? "winner" : ""].filter(Boolean).join(" ")}>
      <span>{label}</span>
      {score !== null ? <strong>{score}</strong> : null}
    </div>
  );
}

function BracketMatchCard({
  isLastRound,
  match,
  profiles,
}: {
  isLastRound: boolean;
  match: MatchRow;
  profiles: Record<string, PublicProfile>;
}) {
  const shouldLinkMatch = isPlayableMatch(match);
  const playerOne = describeMatchSlot(
    match.player_one_id,
    profiles,
    match.player_one_seed,
    getMatchSlotFallback(match, "one"),
  );
  const playerTwo = describeMatchSlot(
    match.player_two_id,
    profiles,
    match.player_two_seed,
    getMatchSlotFallback(match, "two"),
  );
  const needsReview = match.status === "disputed" || match.status === "needs_admin";
  const finalScoreLabel = formatMatchFinalScore(match);
  const playerOneScore =
    finalScoreLabel && match.winner_id
      ? match.winner_id === match.player_one_id
        ? match.final_winner_score
        : match.final_loser_score
      : null;
  const playerTwoScore =
    finalScoreLabel && match.winner_id
      ? match.winner_id === match.player_two_id
        ? match.final_winner_score
        : match.final_loser_score
      : null;

  const cardClassName = [
    "bracket-match-card",
    shouldLinkMatch ? "playable" : "non-playable",
    needsReview ? "needs-review" : "",
    isLastRound ? "last-round" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const cardContent = (
    <>
      <div className="bracket-card-topline">
        <strong>Match {match.match_number ?? match.bracket_position}</strong>
        <span>
          {needsReview ? "Review" : matchFormatLabels[match.format]}
          {finalScoreLabel ? ` ${finalScoreLabel}` : ""}
        </span>
      </div>
      <MatchSlotLine
        isWinner={Boolean(match.winner_id) && match.winner_id === match.player_one_id}
        label={playerOne}
        score={playerOneScore}
      />
      <MatchSlotLine
        isWinner={Boolean(match.winner_id) && match.winner_id === match.player_two_id}
        label={playerTwo}
        score={playerTwoScore}
      />
    </>
  );

  if (shouldLinkMatch) {
    return (
      <Link
        aria-label={`Open match ${match.match_number ?? match.bracket_position}`}
        className={cardClassName}
        href={`/matches/${match.id}`}
      >
        {cardContent}
      </Link>
    );
  }

  return (
    <article className={cardClassName}>
      {cardContent}
    </article>
  );
}

function TournamentBracket({
  championName,
  matchesByRound,
  profiles,
}: {
  championName: string | null;
  matchesByRound: MatchRoundGroup[];
  profiles: Record<string, PublicProfile>;
}) {
  if (matchesByRound.length === 0) {
    return <p className="muted">No bracket has been generated yet.</p>;
  }

  return (
    <div className="bracket-scroll" role="region" aria-label="Tournament bracket">
      <div className="bracket-board">
        {matchesByRound.map(({ round, matches: roundMatches }, roundIndex) => (
          <section
            className="bracket-column"
            key={round.id}
            style={getRoundColumnStyle(roundIndex)}
          >
            <div className="bracket-column-heading">
              <h3>{round.name}</h3>
            </div>
            <div className="bracket-column-matches">
              {roundMatches.map((match) => (
                <BracketMatchCard
                  isLastRound={roundIndex === matchesByRound.length - 1}
                  key={match.id}
                  match={match}
                  profiles={profiles}
                />
              ))}
            </div>
          </section>
        ))}
        <section
          className="bracket-column champion-column"
          style={getRoundColumnStyle(Math.max(matchesByRound.length - 1, 0))}
        >
          <div className="bracket-column-heading">
            <h3>Champion</h3>
          </div>
          <div className="bracket-column-matches">
            <article className={["champion-card", championName ? "known" : ""].filter(Boolean).join(" ")}>
              <span>Champion</span>
              <strong>{championName ?? "Pending"}</strong>
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}

function TournamentPanel({
  active,
  children,
  id,
}: {
  active: boolean;
  children: ReactNode;
  id: TournamentTabKey;
}) {
  if (!active) {
    return null;
  }

  return (
    <div className="tournament-tab-panel" id={`tournament-tab-${id}`} role="tabpanel">
      {children}
    </div>
  );
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
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<TournamentTabKey>("overview");
  const [matchSearch, setMatchSearch] = useState("");

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
      let loadedProfileMap: Record<string, PublicProfile> = {};
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

      const loadedParticipants = registrationRows.map((row) => ({
        registrationId: row.id,
        userId: row.user_id,
        displayName: getProfileName(loadedProfileMap, row.user_id) ?? "Player",
        registrationStatus: row.status,
        registeredAt: row.created_at,
        checkIn: checkIns.find((checkIn) => checkIn.user_id === row.user_id) ?? null,
      }));

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
      setLastUpdatedAt(new Date());

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
    const intervalId = window.setInterval(() => {
      void loadTournament();
    }, 15_000);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
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
    return <LoadingState message="Loading tournament..." />;
  }

  if (error && !tournament) {
    return <ErrorState message={error} />;
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
    matches: matches.filter(
      (match) => match.round_id === round.id || match.round_number === round.round_number,
    ),
  }));
  const championName =
    tournament.status === "completed" ? getChampionName(matches, profileMap) : null;
  const selectedTab =
    activeTab === "admin" && !canManageTournament ? "overview" : activeTab;
  const currentUserMatch = user
    ? matches.find(
        (match) =>
          isPlayableMatch(match) &&
          match.status !== "finalized" &&
          match.status !== "confirmed" &&
          (match.player_one_id === user.id || match.player_two_id === user.id),
      )
    : null;
  const matchSearchText = matchSearch.trim().toLowerCase();
  const visibleMatchesByRound = matchesByRound
    .map(({ round, matches: roundMatches }) => ({
      round,
      matches: roundMatches.filter((match) => {
        if (!matchSearchText) {
          return true;
        }

        const playerOne = describeMatchSlot(
          match.player_one_id,
          profileMap,
          match.player_one_seed,
          getMatchSlotFallback(match, "one"),
        );
        const playerTwo = describeMatchSlot(
          match.player_two_id,
          profileMap,
          match.player_two_seed,
          getMatchSlotFallback(match, "two"),
        );
        const finalScoreLabel = formatMatchFinalScore(match) ?? "";

        return [
          `match ${match.match_number ?? match.bracket_position}`,
          round.name,
          playerOne,
          playerTwo,
          matchStatusLabels[match.status],
          matchFormatLabels[match.format],
          finalScoreLabel,
          getProfileName(profileMap, match.winner_id) ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(matchSearchText);
      }),
    }))
    .filter(({ matches: roundMatches }) => roundMatches.length > 0);

  return (
    <>
      <div className="section-heading tournament-title-block">
        <div>
          <div className="role-list">
            <StatusBadge status={tournament.status} />
            <TournamentTierBadge tier={tournament.tournament_tier} />
            {tournament.exclude_from_stats ? (
              <span className="badge status-badge status-badge-danger">Stats Excluded</span>
            ) : null}
          </div>
          <h1>{tournament.name}</h1>
          <p className="muted">Organized by {organizer?.display_name ?? "Tournament staff"}</p>
          {lastUpdatedAt ? (
            <p className="muted">Last updated {lastUpdatedAt.toLocaleTimeString()}.</p>
          ) : null}
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

      <TournamentTabs
        activeTab={selectedTab}
        canManageTournament={canManageTournament}
        onTabChange={setActiveTab}
      />

      <TournamentPanel active={selectedTab === "overview"} id="overview">
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Next Action</h2>
              {!user ? (
                <p className="muted">Sign in to register, check in, or open assigned match rooms.</p>
              ) : currentUserMatch ? (
                <p className="notice">You have an active match room.</p>
              ) : canCheckIn ? (
                <p className="notice">Tournament check-in is open for you.</p>
              ) : canRegister ? (
                <p className="notice">Registration is open for this free-entry tournament.</p>
              ) : registration?.status && registration.status !== "withdrawn" ? (
                <p className="muted">You are registered. Watch this page for check-in and match room updates.</p>
              ) : (
                <p className="muted">No player action is needed from this account right now.</p>
              )}
            </div>
            <div className="role-actions">
              {!user ? (
                <Link className="button button-link" href={`/auth?redirectTo=/tournaments/${tournament.id}`}>
                  Sign In
                </Link>
              ) : currentUserMatch ? (
                <Link className="button button-link" href={`/matches/${currentUserMatch.id}`}>
                  Go to Match
                </Link>
              ) : canCheckIn ? (
                <button
                  className="button"
                  disabled={savingAction === "check-in"}
                  type="button"
                  onClick={checkInForTournament}
                >
                  {savingAction === "check-in" ? "Checking in..." : "Check In"}
                </button>
              ) : canRegister ? (
                <button
                  className="button"
                  disabled={savingAction === "register"}
                  type="button"
                  onClick={registerForTournament}
                >
                  {savingAction === "register" ? "Registering..." : "Register"}
                </button>
              ) : hasGeneratedBracket ? (
                <button className="button secondary-button" type="button" onClick={() => setActiveTab("bracket")}>
                  View Bracket
                </button>
              ) : null}
            </div>
          </div>
        </section>

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
            <p className="muted">
              {checkedInParticipants.length} checked in
              {canManageTournament ? "" : " shown when visible to your account"}
            </p>
            {championName ? <p className="winner-line">Winner: {championName}</p> : null}
          </div>
        </section>

        {tournament.description ? (
          <section className="card">
            <h2>Description</h2>
            <p>{tournament.description}</p>
          </section>
        ) : null}
      </TournamentPanel>

      <TournamentPanel active={selectedTab === "players"} id="players">
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Player Registration</h2>
              <p className="muted">
                {activeRegistrationCount}
                {tournament.max_players ? `/${tournament.max_players}` : ""} players registered.
              </p>
            </div>
            {ownCheckIn ? <span className="badge status-badge status-badge-gold">Checked In</span> : null}
          </div>

          <div className="role-actions player-action-row">
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
          </div>
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
          <div className="section-heading">
            <div>
              <h2>Players</h2>
              <p className="muted">Check-in state is shown when visible to your account.</p>
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
                        : "Registered"}
                    </p>
                  </div>
                  <div className="role-actions">
                    <span className="badge">
                      {participant.checkIn ? "Checked In" : "Registered"}
                    </span>
                    {canManageTournament && participant.checkIn ? (
                      <button
                        className="button secondary-button"
                        disabled={savingAction === "manual-uncheck" || hasGeneratedBracket}
                        type="button"
                        onClick={() => manualUncheck(participant)}
                      >
                        Remove Check-In
                      </button>
                    ) : null}
                    {canManageTournament && !participant.checkIn ? (
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
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </TournamentPanel>

      <TournamentPanel active={selectedTab === "bracket"} id="bracket">
        <section className="card bracket-card-shell">
          <TournamentBracket
            championName={championName}
            matchesByRound={matchesByRound}
            profiles={profileMap}
          />
        </section>
      </TournamentPanel>

      <TournamentPanel active={selectedTab === "matches"} id="matches">
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Matches</h2>
              <p className="muted">List view for scanning status, players, results, and playable match rooms.</p>
            </div>
          </div>
          <div className="search-row">
            <label htmlFor="match-search">
              Search matches
              <input
                id="match-search"
                placeholder="Player, round, status, or match number"
                value={matchSearch}
                onChange={(event) => setMatchSearch(event.target.value)}
              />
            </label>
          </div>

          {visibleMatchesByRound.length === 0 ? (
            <p className="muted">No matches found.</p>
          ) : (
            <div className="bracket-rounds">
              {visibleMatchesByRound.map(({ round, matches: roundMatches }) => (
                <section className="bracket-round" key={round.id}>
                  <div className="section-heading">
                    <h3>{round.name}</h3>
                    <span className="badge">{matchFormatLabels[round.match_format]}</span>
                  </div>
                  <div className="match-list">
                    {roundMatches.map((match) => {
                      const shouldLinkMatch = isPlayableMatch(match);
                      const nonPlayableMessage = getNonPlayableMatchMessage(match, profileMap);
                      const finalScoreLabel = formatMatchFinalScore(match);

                      return (
                        <article className="match-row" key={match.id}>
                          <div>
                            <strong>Match {match.match_number ?? match.bracket_position}</strong>
                            <p className="muted">
                              {describeMatchSlot(
                                match.player_one_id,
                                profileMap,
                                match.player_one_seed,
                                getMatchSlotFallback(match, "one"),
                              )}{" "}
                              vs{" "}
                              {describeMatchSlot(
                                match.player_two_id,
                                profileMap,
                                match.player_two_seed,
                                getMatchSlotFallback(match, "two"),
                              )}
                            </p>
                            {nonPlayableMessage ? (
                              <p className="muted">{nonPlayableMessage}</p>
                            ) : match.winner_id ? (
                              <p className="notice">
                                Winner: {getProfileName(profileMap, match.winner_id) ?? "Player"}
                                {finalScoreLabel ? ` ${finalScoreLabel}` : ""}
                              </p>
                            ) : match.status === "disputed" || match.status === "needs_admin" ? (
                              <p className="error">Organizer review required.</p>
                            ) : match.status === "result_reported" ? (
                              <p className="muted">Result reports pending confirmation.</p>
                            ) : null}
                          </div>
                          <div className="role-actions">
                            <span className="badge">{matchFormatLabels[match.format]}</span>
                            <MatchStatusBadge tone={getMatchStatusTone(match)}>
                              {matchStatusLabels[match.status]}
                            </MatchStatusBadge>
                            {shouldLinkMatch ? (
                              <Link
                                className="button secondary-button button-link"
                                href={`/matches/${match.id}`}
                              >
                                Match Room
                              </Link>
                            ) : (
                              <span className="muted">No room action</span>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      </TournamentPanel>

      <TournamentPanel active={selectedTab === "rules"} id="rules">
        <section className="card">
          <h2>Rules</h2>
          {tournament.rules ? (
            <p className="pre-line">{tournament.rules}</p>
          ) : (
            <p className="muted">No rules posted yet.</p>
          )}
          {tournament.external_community_url ? (
            <p>
              <a href={tournament.external_community_url} rel="noreferrer" target="_blank">
                Community link
              </a>
            </p>
          ) : null}
        </section>
        <section className="grid">
          <div className="card">
            <h2>Format</h2>
            <p>{tournamentFormatLabels[tournament.tournament_format]}</p>
            <p className="muted">Generated brackets use stored round formats when available.</p>
          </div>
          <div className="card">
            <h2>Match Format</h2>
            <p>{matchFormatLabels[tournament.format]}</p>
            <p className="muted">Players use assigned match rooms for lobby setup and result reporting.</p>
          </div>
        </section>
      </TournamentPanel>

      {canManageTournament ? (
        <TournamentPanel active={selectedTab === "admin"} id="admin">
          <section className="card">
            <div className="section-heading">
              <div>
                <h2>Organizer/Admin</h2>
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

          {roles.isAdmin ? (
            <div className="management-actions">
              <div>
                <h3>Dashboard Calendar</h3>
                <p className="muted">
                  Public dashboard visibility is controlled from Admin Dashboard tournament management.
                </p>
              </div>
              <MatchStatusBadge tone={tournament.show_on_calendar ? "gold" : "muted"}>
                {tournament.show_on_calendar ? "Calendar Visible" : "Calendar Hidden"}
              </MatchStatusBadge>
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
        </TournamentPanel>
      ) : null}
    </>
  );
}
