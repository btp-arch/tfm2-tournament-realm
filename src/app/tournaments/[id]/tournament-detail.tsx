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
  buildSeededSingleEliminationSlots,
  generateSingleEliminationMatches,
  getBracketSetupWarning,
  getDefaultRoundFormats,
  getRoundFormatsFromDefaults,
  getRoundName,
  isBracketSize,
  seedingMethodLabels,
  seedingMethods,
  validateManualSeed,
  type BracketSize,
  type SeedingMethod,
} from "@/lib/brackets";
import { formatError, logError } from "@/lib/errors";
import {
  areGroupMatchesComplete,
  buildSeededGroupAssignments,
  calculateGroupStandings,
  explainGroupSeedPlacement,
  getGroupStageFormatSummary,
  getGroupLabel,
  getPlayoffByeCount,
  getQualifierBlockedReason,
  getSupportedPlayoffBracketSize,
  isGroupBye,
  isForfeitResult,
  type GroupWithMembers,
} from "@/lib/group-stage";
import {
  getMatchSlotFallback,
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
  matchStatusLabels,
  tournamentStatusDescriptions,
  tournamentFormatLabels,
  tournamentStatusLabels,
  type MatchFormat,
  type MatchRow,
  type TournamentCheckInRow,
  type TournamentGroupMemberRow,
  type TournamentGroupRow,
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
  manualSeed: number | null;
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
  | "manual-seed"
  | "generate"
  | "generate-groups"
  | "reset-groups"
  | "override-qualifier"
  | "clear-qualifiers"
  | "admin-force-check-in"
  | "admin-force-start"
  | "reset"
  | "activate"
  | null;

type ActiveSavingAction = Exclude<SavingAction, null>;
type TournamentTabKey = "overview" | "players" | "groups" | "bracket" | "rules" | "admin";

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

function orderParticipantsForGroupDraw(
  participants: Participant[],
  drawMethod: SeedingMethod,
) {
  return orderParticipantsForSeeding(participants, drawMethod);
}

function createRoundRobinPairings(members: TournamentGroupMemberRow[]) {
  const orderedMembers = members
    .filter((member) => !isGroupBye(member) && member.user_id)
    .slice()
    .sort((first, second) => first.seed - second.seed);
  const pairings: { playerOne: TournamentGroupMemberRow; playerTwo: TournamentGroupMemberRow }[] = [];

  for (let firstIndex = 0; firstIndex < orderedMembers.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < orderedMembers.length; secondIndex += 1) {
      const first = orderedMembers[firstIndex];
      const second = orderedMembers[secondIndex];

      if (first && second) {
        pairings.push({ playerOne: first, playerTwo: second });
      }
    }
  }

  return pairings;
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
        next: "Wait for at least 2 checked-in players before starting the tournament.",
      };
    }

    return {
      current: "Checked-in players are ready to start.",
      next: hasGeneratedBracket
        ? "The bracket has already been generated."
        : "Confirm seeding, then start the tournament.",
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

function getTournamentRoundFormats(tournament: TournamentRow, bracketSize: BracketSize) {
  return getRoundFormatsFromDefaults(bracketSize, {
    final: tournament.final_match_format,
    preSemifinal: tournament.pre_semifinal_match_format,
    semifinal: tournament.semifinal_match_format,
  });
}

function TournamentTabs({
  activeTab,
  canManageTournament,
  hasGroupStage,
  onTabChange,
}: {
  activeTab: TournamentTabKey;
  canManageTournament: boolean;
  hasGroupStage: boolean;
  onTabChange: (tab: TournamentTabKey) => void;
}) {
  const tabs: { key: TournamentTabKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "players", label: "Players" },
    ...(hasGroupStage ? [{ key: "groups" as const, label: "Groups" }] : []),
    { key: "bracket", label: hasGroupStage ? "Playoff Bracket" : "Bracket" },
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

function PlayerProfileLink({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string | null;
}) {
  if (!userId) {
    return <>{children}</>;
  }

  return <Link href={`/players/${userId}`}>{children}</Link>;
}

function MatchSlotLine({
  isWinner,
  label,
  score,
  userId,
}: {
  isWinner: boolean;
  label: string;
  score: number | null;
  userId: string | null;
}) {
  return (
    <div className={["bracket-slot", isWinner ? "winner" : ""].filter(Boolean).join(" ")}>
      <span>
        <PlayerProfileLink userId={userId}>{label}</PlayerProfileLink>
      </span>
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
        userId={match.player_one_id}
      />
      <MatchSlotLine
        isWinner={Boolean(match.winner_id) && match.winner_id === match.player_two_id}
        label={playerTwo}
        score={playerTwoScore}
        userId={match.player_two_id}
      />
      {shouldLinkMatch ? (
        <Link
          aria-label={`Open match ${match.match_number ?? match.bracket_position}`}
          className="bracket-room-link"
          href={`/matches/${match.id}`}
        >
          Match Room
        </Link>
      ) : null}
    </>
  );

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
  const [groups, setGroups] = useState<TournamentGroupRow[]>([]);
  const [groupMembers, setGroupMembers] = useState<TournamentGroupMemberRow[]>([]);
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
  const [historyGroupId, setHistoryGroupId] = useState<string | null>(null);

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
        groupsResult,
        groupMembersResult,
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
        supabase
          .from("tournament_groups")
          .select("*")
          .eq("tournament_id", loadedTournament.id)
          .order("group_number", { ascending: true }),
        supabase
          .from("tournament_group_members")
          .select("*")
          .eq("tournament_id", loadedTournament.id)
          .order("draw_position", { ascending: true }),
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
      if (groupsResult.error) throw groupsResult.error;
      if (groupMembersResult.error) throw groupMembersResult.error;

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
          ...groupMembersResult.data.map((member) => member.user_id),
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
        manualSeed: row.manual_seed,
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
      setGroups(groupsResult.data);
      setGroupMembers(groupMembersResult.data);
      setActiveRegistrationCount(countRow?.active_registration_count ?? 0);
      setTotalRegistrationCount(totalRegistrationsResult.count ?? 0);
      setIsManagedByUser(Boolean(organizerAccessResult.data));
      setSelectedStatus(loadedTournament.status);
      setAdminDeleteConfirmation("");
      setLastUpdatedAt(new Date());

      const firstStage = stagesResult.data.find(
        (stage) => stage.bracket_type === "single_elimination",
      );
      if (firstStage && isBracketSize(firstStage.bracket_size)) {
        setSelectedBracketSize(firstStage.bracket_size);
        setSelectedSeedingMethod(firstStage.seeding_method);
        setRoundFormats(getTournamentRoundFormats(loadedTournament, firstStage.bracket_size));
      } else if (loadedTournament.max_players && isBracketSize(loadedTournament.max_players)) {
        setSelectedBracketSize(loadedTournament.max_players);
        setRoundFormats(getTournamentRoundFormats(loadedTournament, loadedTournament.max_players));
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

  const isGroupStageTournament = tournament?.tournament_format === "group_stage_playoff";
  const groupStage = useMemo(
    () => stages.find((stage) => stage.bracket_type === "group_stage_playoff") ?? null,
    [stages],
  );
  const playoffStage = useMemo(
    () =>
      isGroupStageTournament
        ? stages.find(
            (stage) => stage.bracket_type === "single_elimination" && stage.stage_number > 1,
          ) ?? null
        : stages.find((stage) => stage.bracket_type === "single_elimination") ?? null,
    [isGroupStageTournament, stages],
  );
  const groupsWithMembers = useMemo<GroupWithMembers[]>(() => {
    return groups.map((group) => ({
      ...group,
      members: groupMembers
        .filter((member) => member.group_id === group.id)
        .sort((first, second) => first.draw_position - second.draw_position),
    }));
  }, [groupMembers, groups]);
  const groupStageMatches = useMemo(
    () => matches.filter((match) => Boolean(match.group_id)),
    [matches],
  );
  const playoffMatches = useMemo(
    () => (playoffStage ? matches.filter((match) => match.stage_id === playoffStage.id) : []),
    [matches, playoffStage],
  );

  const bracketWarning = getBracketSetupWarning(
    checkedInParticipants.length,
    selectedBracketSize,
  );
  const hasGroupDraw = groupsWithMembers.length > 0;
  const hasPlayoffBracket = Boolean(playoffStage);
  const hasGeneratedBracket = isGroupStageTournament ? hasGroupDraw : stages.length > 0;
  const canEditManualSeeds = Boolean(canManageTournament && !hasGeneratedBracket);
  const maxManualSeedForTournament = isGroupStageTournament ? 8 : Math.min(8, selectedBracketSize);
  const assignedManualSeeds = useMemo(() => {
    return participants.reduce<Map<number, Participant>>((seedsByNumber, participant) => {
      if (isEligibleParticipant(participant) && participant.manualSeed !== null) {
        seedsByNumber.set(participant.manualSeed, participant);
      }

      return seedsByNumber;
    }, new Map());
  }, [participants]);
  const manualSeedOptions = Array.from(
    { length: maxManualSeedForTournament },
    (_, index) => index + 1,
  );
  const participantsByUserId = useMemo(() => {
    return participants.reduce<Map<string, Participant>>((participantsById, participant) => {
      participantsById.set(participant.userId, participant);

      return participantsById;
    }, new Map());
  }, [participants]);
  const requiredGroupPlayerCount =
    (tournament?.group_size ?? 0) * (tournament?.groups_count ?? 0);
  const totalGroupQualifiers =
    (tournament?.groups_count ?? 0) * (tournament?.qualifiers_per_group ?? 0);
  const configuredPlayoffBracketSize = getSupportedPlayoffBracketSize(totalGroupQualifiers);
  const configuredPlayoffByeCount = getPlayoffByeCount(totalGroupQualifiers);
  const groupDrawWarning =
    isGroupStageTournament && tournament
      ? checkedInParticipants.length > requiredGroupPlayerCount
        ? `Group draw can hold ${requiredGroupPlayerCount} checked-in players. ${checkedInParticipants.length} are checked in.`
        : checkedInParticipants.length < 2
            ? "At least 2 checked-in players are required to start the tournament."
          : null
      : null;
  const groupMatchesComplete = areGroupMatchesComplete(groupsWithMembers, matches);
  const playoffBlockedReason = tournament
    ? getQualifierBlockedReason(groupsWithMembers, matches, tournament)
    : null;
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
        setError("Start the tournament before setting it active manually.");
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

  async function setTournamentRegistrationSeed(participant: Participant, manualSeed: number | null) {
    if (!tournament || !canEditManualSeeds) {
      return;
    }

    const validationError = validateManualSeed(manualSeed, maxManualSeedForTournament);

    if (validationError) {
      setError(validationError);
      return;
    }

    const assignedParticipant = manualSeed !== null ? assignedManualSeeds.get(manualSeed) : null;

    if (assignedParticipant && assignedParticipant.registrationId !== participant.registrationId) {
      setError(`Seed ${manualSeed} is already assigned to ${assignedParticipant.displayName}.`);
      return;
    }

    setSavingAction("manual-seed");
    setNotice(null);
    setError(null);

    try {
      const { error: rpcError } = await supabase.rpc("set_tournament_registration_seed", {
        seed_value: manualSeed,
        target_registration: participant.registrationId,
      });

      if (rpcError) {
        throw rpcError;
      }

      setNotice(
        manualSeed === null
          ? `${participant.displayName}'s seed cleared.`
          : `${participant.displayName} assigned seed ${manualSeed}.`,
      );
      await loadTournament();
    } catch (caughtError) {
      logError("Manual seed update failed.", caughtError);
      setError(formatError(caughtError, "Unable to update manual seed."));
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
      const hasManualSeeds = participantsToSeed.some((participant) => participant.manualSeed !== null);
      const seededPlayers = buildSeededSingleEliminationSlots(
        participantsToSeed,
        selectedBracketSize,
        (unseededParticipants) =>
          hasManualSeeds
            ? shuffleParticipants(unseededParticipants)
            : orderParticipantsForSeeding(unseededParticipants, selectedSeedingMethod),
      );

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
      setError("Open check-in before starting the tournament.");
      return;
    }

    await createBracketFromParticipants(
      checkedInParticipants,
      "generate",
      "Bracket generated and tournament started.",
    );
  }

  async function startTournament() {
    if (!tournament || !canManageTournament) {
      return;
    }

    if (isGroupStageTournament) {
      await generateGroupDraw();
      return;
    }

    await generateBracket();
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

  async function generateGroupDraw() {
    if (!user || !tournament || !canManageTournament || !isGroupStageTournament) {
      return;
    }

    if (tournament.status !== "check_in") {
      setError("Open check-in before starting the tournament.");
      return;
    }

    if (hasGroupDraw) {
      setError("This tournament already has a generated group draw.");
      return;
    }

    if (groupDrawWarning) {
      setError(groupDrawWarning);
      return;
    }

    if (!tournament.group_size || !tournament.groups_count || !tournament.group_stage_format) {
      setError("Group-stage settings are incomplete.");
      return;
    }

    setSavingAction("generate-groups");
    setNotice(null);
    setError(null);
    let createdStageId: string | null = null;
    let createdPlayoffStageId: string | null = null;
    let noMatchPlayoffGenerated = false;

    try {
      const hasManualSeeds = checkedInParticipants.some((participant) => participant.manualSeed !== null);
      const groupAssignments = buildSeededGroupAssignments(
        checkedInParticipants,
        tournament.group_size,
        tournament.groups_count,
        (unseededParticipants) =>
          hasManualSeeds
            ? shuffleParticipants(unseededParticipants)
            : orderParticipantsForGroupDraw(unseededParticipants, selectedSeedingMethod),
      );

      const { data: stage, error: stageError } = await supabase
        .from("tournament_stages")
        .insert({
          tournament_id: tournament.id,
          stage_number: 1,
          name: "Group Stage",
          bracket_type: "group_stage_playoff",
          bracket_size: requiredGroupPlayerCount,
          seeding_method: selectedSeedingMethod,
          generated_by: user.id,
        })
        .select()
        .single();

      if (stageError) {
        throw stageError;
      }

      createdStageId = stage.id;

      const { data: createdRound, error: roundError } = await supabase
        .from("tournament_rounds")
        .insert({
          tournament_id: tournament.id,
          stage_id: stage.id,
          round_number: 1,
          name: "Group Round Robin",
          match_format: tournament.group_stage_format,
        })
        .select()
        .single();

      if (roundError) {
        throw roundError;
      }

      const { data: createdGroups, error: groupsError } = await supabase
        .from("tournament_groups")
        .insert(
          Array.from({ length: tournament.groups_count }, (_, index) => ({
            tournament_id: tournament.id,
            stage_id: stage.id,
            group_number: index + 1,
            name: getGroupLabel(index + 1),
            draw_method: selectedSeedingMethod,
            generated_by: user.id,
          })),
        )
        .select();

      if (groupsError) {
        throw groupsError;
      }

      const memberInserts = groupAssignments.map((assignment) => {
        const group = createdGroups[assignment.groupIndex];

        if (!group) {
          throw new Error("Unable to match group assignment to a created group.");
        }

        return {
          tournament_id: tournament.id,
          group_id: group.id,
          user_id: assignment.participant?.userId ?? null,
          is_bye: assignment.isBye,
          seed: assignment.slotIndex + 1,
          draw_position: assignment.groupIndex * tournament.group_size! + assignment.slotIndex + 1,
        };
      });

      const { data: createdMembers, error: membersError } = await supabase
        .from("tournament_group_members")
        .insert(memberInserts)
        .select();

      if (membersError) {
        throw membersError;
      }

      let matchNumber = 1;
      const matchInserts = createdGroups.flatMap((group) => {
        const members = createdMembers.filter((member) => member.group_id === group.id);

        return createRoundRobinPairings(members).map((pairing, index) => ({
          tournament_id: tournament.id,
          stage_id: stage.id,
          round_id: createdRound.id,
          group_id: group.id,
          round_number: 1,
          match_number: matchNumber++,
          bracket_position: index + 1,
          player_one_id: pairing.playerOne.user_id!,
          player_two_id: pairing.playerTwo.user_id!,
          player_one_seed: pairing.playerOne.seed,
          player_two_seed: pairing.playerTwo.seed,
          player_one_slot: pairing.playerOne.draw_position,
          player_two_slot: pairing.playerTwo.draw_position,
          format: tournament.group_stage_format!,
          status: "assigned" as const,
          result_type: "played" as const,
        }));
      });

      if (matchInserts.length > 0) {
        const { error: matchesError } = await supabase.from("matches").insert(matchInserts);

        if (matchesError) {
          throw matchesError;
        }
      } else {
        const { data: generatedPlayoff, error: playoffError } = await supabase.rpc("auto_generate_group_playoff", {
          actor: user.id,
          target_tournament: tournament.id,
        });

        if (playoffError) {
          throw playoffError;
        }

        if (!generatedPlayoff) {
          const qualifiers = createdGroups
            .flatMap((group) => {
              return createdMembers
                .filter((member) => member.group_id === group.id && !isGroupBye(member) && member.user_id)
                .sort((first, second) => first.seed - second.seed)
                .slice(0, tournament.qualifiers_per_group ?? 0)
                .map((member) => ({
                  groupNumber: group.group_number,
                  seed: member.seed,
                  userId: member.user_id!,
                }));
            })
            .sort(
              (first, second) =>
                first.seed - second.seed ||
                first.groupNumber - second.groupNumber ||
                first.userId.localeCompare(second.userId),
            );
          const playoffBracketSize = getSupportedPlayoffBracketSize(qualifiers.length);

          if (!playoffBracketSize || qualifiers.length < 2) {
            throw new Error("No-match group draw did not produce enough playoff qualifiers.");
          }

          const playoffRoundFormats = getTournamentRoundFormats(tournament, playoffBracketSize);
          const { data: playoffStage, error: playoffStageError } = await supabase
            .from("tournament_stages")
            .insert({
              tournament_id: tournament.id,
              stage_number: stage.stage_number + 1,
              name: "Playoff Bracket",
              bracket_type: "single_elimination",
              bracket_size: playoffBracketSize,
              seeding_method: "group_finish",
              generated_by: user.id,
            })
            .select()
            .single();

          if (playoffStageError) {
            throw playoffStageError;
          }

          createdPlayoffStageId = playoffStage.id;

          const { data: createdPlayoffRounds, error: playoffRoundsError } = await supabase
            .from("tournament_rounds")
            .insert(
              playoffRoundFormats.map((format, index) => ({
                tournament_id: tournament.id,
                stage_id: playoffStage.id,
                round_number: index + 1,
                name: getRoundName(playoffBracketSize, index + 1),
                match_format: format,
              })),
            )
            .select();

          if (playoffRoundsError) {
            throw playoffRoundsError;
          }

          const playoffRoundByNumber = new Map(
            createdPlayoffRounds.map((round) => [round.round_number, round]),
          );
          const generatedPlayoffMatches = generateSingleEliminationMatches(
            qualifiers.map((qualifier, index) => ({
              userId: qualifier.userId,
              seed: index + 1,
            })),
            playoffBracketSize,
            playoffRoundFormats,
          );

          const { error: playoffMatchesError } = await supabase.from("matches").insert(
            generatedPlayoffMatches.map((match) => ({
              tournament_id: tournament.id,
              stage_id: playoffStage.id,
              round_id: playoffRoundByNumber.get(match.roundNumber)?.id ?? null,
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
              result_type: match.status === "bye" ? "bye" : "played",
            })),
          );

          if (playoffMatchesError) {
            throw playoffMatchesError;
          }
        }

        noMatchPlayoffGenerated = true;
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

      setNotice(
        noMatchPlayoffGenerated
          ? "Group draw generated with no group matches; playoff bracket created."
          : "Group draw generated and group matches created.",
      );
      await loadTournament();
      router.refresh();
      setActiveTab("groups");
    } catch (caughtError) {
      if (createdPlayoffStageId) {
        await supabase.from("tournament_stages").delete().eq("id", createdPlayoffStageId);
      }

      if (createdStageId) {
        await supabase.from("tournament_stages").delete().eq("id", createdStageId);
      }

      logError("Group draw generation failed.", caughtError);
      setError(formatError(caughtError, "Unable to generate group draw."));
    } finally {
      setSavingAction(null);
    }
  }

  async function resetGroupDraw() {
    if (!tournament || !canManageTournament || !groupStage) {
      return;
    }

    if (hasPlayoffBracket) {
      setError("Reset the group draw before generating playoffs.");
      return;
    }

    if (groupStageMatches.some((match) => match.status !== "assigned")) {
      setError("Group draw can only be reset before group matches start.");
      return;
    }

    const confirmed = window.confirm("Reset the generated group draw and group matches?");
    if (!confirmed) {
      return;
    }

    setSavingAction("reset-groups");
    setNotice(null);
    setError(null);

    try {
      const { error: deleteError } = await supabase
        .from("tournament_stages")
        .delete()
        .eq("id", groupStage.id);

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

      setNotice("Group draw reset.");
      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      logError("Group draw reset failed.", caughtError);
      setError(formatError(caughtError, "Unable to reset group draw."));
    } finally {
      setSavingAction(null);
    }
  }

  async function setManualQualifier(member: TournamentGroupMemberRow, qualifierSeed: number) {
    if (!canManageTournament) {
      return;
    }

    setSavingAction("override-qualifier");
    setNotice(null);
    setError(null);

    try {
      const { error: clearError } = await supabase
        .from("tournament_group_members")
        .update({ qualifier_seed: null, updated_at: new Date().toISOString() })
        .eq("group_id", member.group_id)
        .eq("qualifier_seed", qualifierSeed);

      if (clearError) {
        throw clearError;
      }

      const { error: updateError } = await supabase
        .from("tournament_group_members")
        .update({ qualifier_seed: qualifierSeed, updated_at: new Date().toISOString() })
        .eq("id", member.id);

      if (updateError) {
        throw updateError;
      }

      setNotice("Manual qualifier override saved.");
      await loadTournament();
    } catch (caughtError) {
      logError("Qualifier override failed.", caughtError);
      setError(formatError(caughtError, "Unable to save qualifier override."));
    } finally {
      setSavingAction(null);
    }
  }

  async function clearManualQualifiers(group: GroupWithMembers) {
    if (!canManageTournament) {
      return;
    }

    setSavingAction("clear-qualifiers");
    setNotice(null);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from("tournament_group_members")
        .update({ qualifier_seed: null, updated_at: new Date().toISOString() })
        .eq("group_id", group.id);

      if (updateError) {
        throw updateError;
      }

      setNotice(`${group.name} qualifier overrides cleared.`);
      await loadTournament();
    } catch (caughtError) {
      logError("Clear qualifier overrides failed.", caughtError);
      setError(formatError(caughtError, "Unable to clear qualifier overrides."));
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

  const bracketRounds = isGroupStageTournament && playoffStage
    ? rounds.filter((round) => round.stage_id === playoffStage.id)
    : rounds.filter((round) => {
        const stage = stages.find((candidate) => candidate.id === round.stage_id);

        return stage?.bracket_type === "single_elimination";
      });
  const matchesByRound = bracketRounds.map((round) => ({
    round,
    matches: matches.filter(
      (match) =>
        match.stage_id === round.stage_id &&
        (match.round_id === round.id || match.round_number === round.round_number),
    ),
  }));
  const championName =
    tournament.status === "completed" ? getChampionName(playoffMatches.length > 0 ? playoffMatches : matches, profileMap) : null;
  const selectedTab =
    activeTab === "admin" && !canManageTournament
      ? "overview"
      : activeTab === "groups" && !isGroupStageTournament
        ? "overview"
        : activeTab;
  const currentUserMatch = user
    ? matches.find(
        (match) =>
          isPlayableMatch(match) &&
          match.status !== "finalized" &&
          match.status !== "confirmed" &&
          (match.player_one_id === user.id || match.player_two_id === user.id),
      )
    : null;
  const historyGroup = historyGroupId
    ? groupsWithMembers.find((group) => group.id === historyGroupId) ?? null
    : null;
  const historyGroupMatches = historyGroup
    ? groupStageMatches
        .filter(
          (match) =>
            match.group_id === historyGroup.id &&
            Boolean(match.player_one_id) &&
            Boolean(match.player_two_id),
        )
        .sort(
          (first, second) =>
            first.round_number - second.round_number ||
            (first.match_number ?? 0) - (second.match_number ?? 0) ||
            (first.bracket_position ?? 0) - (second.bracket_position ?? 0),
        )
    : [];
  const historyMatchesByRound = historyGroupMatches.reduce<
    { matches: MatchRow[]; roundNumber: number }[]
  >((roundGroups, match) => {
    const existingGroup = roundGroups.find((group) => group.roundNumber === match.round_number);

    if (existingGroup) {
      existingGroup.matches.push(match);
    } else {
      roundGroups.push({ matches: [match], roundNumber: match.round_number });
    }

    return roundGroups;
  }, []);

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
          <p className="muted">
            Organized by{" "}
            {organizer?.id ? (
              <Link href={`/players/${organizer.id}`}>{organizer.display_name ?? "Tournament staff"}</Link>
            ) : (
              "Tournament staff"
            )}
          </p>
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
        hasGroupStage={Boolean(isGroupStageTournament)}
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
                <button
                  className="button secondary-button"
                  type="button"
                  onClick={() => setActiveTab(isGroupStageTournament && !hasPlayoffBracket ? "groups" : "bracket")}
                >
                  {isGroupStageTournament && !hasPlayoffBracket ? "View Groups" : "View Bracket"}
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
              {isGroupStageTournament ? (
                <>
                  <div>
                    <dt>Groups</dt>
                    <dd>
                      {tournament.groups_count} groups of {tournament.group_size}, top{" "}
                      {tournament.qualifiers_per_group} advance
                    </dd>
                  </div>
                  <div>
                    <dt>Group Matches</dt>
                    <dd>{tournament.group_stage_format ? matchFormatLabels[tournament.group_stage_format] : "Not set"}</dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt>Round Defaults</dt>
                <dd>
                  Pre-semis {matchFormatLabels[tournament.pre_semifinal_match_format]},
                  semis {matchFormatLabels[tournament.semifinal_match_format]},
                  final {matchFormatLabels[tournament.final_match_format]}
                </dd>
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
                    <strong>
                      <Link href={`/players/${participant.userId}`}>{participant.displayName}</Link>
                    </strong>
                    <p className="muted">
                      {participant.checkIn
                        ? `Checked in ${formatDateTime(participant.checkIn.checked_in_at)}`
                        : "Registered"}
                    </p>
                    {participant.manualSeed ? (
                      <p className="muted">Manual tournament seed {participant.manualSeed}</p>
                    ) : null}
                  </div>
                  <div className="role-actions">
                    {participant.manualSeed ? (
                      <span className="badge status-badge-gold">Seed {participant.manualSeed}</span>
                    ) : null}
                    <span className="badge">
                      {participant.checkIn ? "Checked In" : "Registered"}
                    </span>
                    {canManageTournament ? (
                      <label className="compact-control" htmlFor={`manual-seed-${participant.registrationId}`}>
                        Seed
                        <select
                          disabled={
                            !canEditManualSeeds ||
                            !isEligibleParticipant(participant) ||
                            savingAction === "manual-seed"
                          }
                          id={`manual-seed-${participant.registrationId}`}
                          value={participant.manualSeed ?? ""}
                          onChange={(event) =>
                            setTournamentRegistrationSeed(
                              participant,
                              event.target.value ? Number(event.target.value) : null,
                            )
                          }
                        >
                          <option value="">None</option>
                          {manualSeedOptions.map((seed) => {
                            const seedHolder = assignedManualSeeds.get(seed);
                            const isTakenByAnother =
                              Boolean(seedHolder) &&
                              seedHolder?.registrationId !== participant.registrationId;

                            return (
                              <option
                                disabled={isTakenByAnother}
                                key={seed}
                                value={seed}
                              >
                                {isTakenByAnother
                                  ? `${seed} - ${seedHolder?.displayName ?? "Assigned"}`
                                  : seed}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                    ) : null}
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

      {isGroupStageTournament ? (
        <TournamentPanel active={selectedTab === "groups"} id="groups">
          <section className="card">
            <div className="section-heading">
              <div>
                <h2>Groups</h2>
                <p className="muted">
                  {tournament.groups_count} groups of {tournament.group_size}. Top{" "}
                  {tournament.qualifiers_per_group} from each group advances to a{" "}
                  {configuredPlayoffBracketSize ?? totalGroupQualifiers}-player playoff bracket.
                </p>
                <p className="muted">
                  {getGroupStageFormatSummary({
                    groupsCount: tournament.groups_count ?? 0,
                    qualifiersPerGroup: tournament.qualifiers_per_group ?? 0,
                  })}
                  {configuredPlayoffByeCount > 0
                    ? `. Highest playoff seeds receive ${configuredPlayoffByeCount} BYE${configuredPlayoffByeCount === 1 ? "" : "s"}.`
                    : "."}
                </p>
              </div>
              {hasPlayoffBracket ? (
                <button className="button secondary-button" type="button" onClick={() => setActiveTab("bracket")}>
                  View Playoff Bracket
                </button>
              ) : null}
            </div>

            {!hasGroupDraw ? (
              <p className="muted">
                Group draw has not been created yet. Staff can start the tournament after check-in; empty group slots become BYE/no-match slots.
              </p>
            ) : null}

            {hasGroupDraw && !groupMatchesComplete ? (
              <p className="muted">Group standings update as finalized group matches report results.</p>
            ) : null}

            {hasGroupDraw && groupMatchesComplete && !hasPlayoffBracket ? (
              <p className={playoffBlockedReason ? "error" : "notice"}>
                {playoffBlockedReason ?? "Group stage is complete. Playoff bracket generation will start automatically."}
              </p>
            ) : null}
          </section>

          {groupsWithMembers.length === 0 ? null : (
            <div className="group-stage-grid">
              {groupsWithMembers.map((group) => {
                const standings = calculateGroupStandings(
                  group,
                  matches,
                  tournament.qualifiers_per_group ?? 0,
                );
                const groupMatches = groupStageMatches.filter((match) => match.group_id === group.id);
                const groupByeCount = group.members.filter(isGroupBye).length;
                const realMemberCount = group.members.length - groupByeCount;

                return (
                  <section className="card group-card" key={group.id}>
                    <div className="section-heading">
                      <div>
                        <h2>{group.name}</h2>
                        <p className="muted">
                          {realMemberCount} players, {groupMatches.length} matches
                          {groupByeCount > 0 ? `, ${groupByeCount} BYE/no-match slot${groupByeCount === 1 ? "" : "s"}` : ""}
                        </p>
                      </div>
                      <div className="role-actions">
                        <button
                          className="button secondary-button tiny-button"
                          type="button"
                          onClick={() => setHistoryGroupId(group.id)}
                        >
                          Match History
                        </button>
                        {canManageTournament ? (
                          <button
                            className="button secondary-button"
                            disabled={savingAction === "clear-qualifiers"}
                            type="button"
                            onClick={() => clearManualQualifiers(group)}
                          >
                            Clear Overrides
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <div className="table-scroll">
                      <table className="standings-table">
                        <thead>
                          <tr>
                            <th>Player</th>
                            <th>W-L</th>
                            <th>Games</th>
                            <th>Diff</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {standings.map((standing) => {
                            const member = group.members.find(
                              (candidate) => candidate.user_id === standing.userId,
                            );
                            const standingParticipant = participantsByUserId.get(standing.userId);

                            return (
                              <tr key={standing.userId}>
                                <td>
                                  <PlayerProfileLink userId={standing.userId}>
                                    {getProfileName(profileMap, standing.userId) ?? "Player"}
                                  </PlayerProfileLink>
                                  {standingParticipant?.manualSeed ? (
                                    <div className="inline-actions">
                                      <span className="badge status-badge-gold">
                                        Seed {standingParticipant.manualSeed}
                                      </span>
                                    </div>
                                  ) : null}
                                </td>
                                <td>
                                  {standing.matchWins}-{standing.matchLosses}
                                </td>
                                <td>
                                  {standing.gameWins}-{standing.gameLosses}
                                </td>
                                <td>{standing.gameDiff > 0 ? `+${standing.gameDiff}` : standing.gameDiff}</td>
                                <td>
                                  <span
                                    className={[
                                      "badge",
                                      standing.status === "qualified"
                                        ? "status-badge-gold"
                                        : standing.status === "tiebreaker"
                                          ? "status-badge-danger"
                                          : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" ")}
                                  >
                                    {standing.status === "qualified"
                                      ? standing.isManualQualifier
                                        ? "Qualified Override"
                                        : "Qualified"
                                      : standing.status === "tiebreaker"
                                        ? "Tiebreaker Needed"
                                        : "Eliminated"}
                                  </span>
                                  {canManageTournament && member ? (
                                    <div className="inline-actions">
                                      {Array.from(
                                        { length: tournament.qualifiers_per_group ?? 0 },
                                        (_, index) => index + 1,
                                      ).map((qualifierSeed) => (
                                        <button
                                          className="button secondary-button tiny-button"
                                          disabled={savingAction === "override-qualifier"}
                                          key={qualifierSeed}
                                          type="button"
                                          onClick={() => setManualQualifier(member, qualifierSeed)}
                                        >
                                          Q{qualifierSeed}
                                        </button>
                                      ))}
                                    </div>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {groupByeCount > 0 ? (
                      <div className="compact-list">
                        {group.members.filter(isGroupBye).map((member) => (
                          <span className="badge status-badge-muted" key={member.id}>
                            Slot {member.seed}: BYE/no-match
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </TournamentPanel>
      ) : null}

      <TournamentPanel active={selectedTab === "bracket"} id="bracket">
        <section className="card bracket-card-shell">
          {isGroupStageTournament && !hasPlayoffBracket ? (
            <div>
              <h2>Playoff Bracket</h2>
              <p className="muted">
                Playoff bracket has not been generated yet. Complete group matches; the playoff bracket will generate automatically.
              </p>
              <button className="button secondary-button" type="button" onClick={() => setActiveTab("groups")}>
                Go to Groups
              </button>
            </div>
          ) : (
            <TournamentBracket
              championName={championName}
              matchesByRound={matchesByRound}
              profiles={profileMap}
            />
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
            <h2>Round Formats</h2>
            <p>
              Pre-semis {matchFormatLabels[tournament.pre_semifinal_match_format]}, semis{" "}
              {matchFormatLabels[tournament.semifinal_match_format]}, final{" "}
              {matchFormatLabels[tournament.final_match_format]}
            </p>
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
              <p className="muted">Normal organizer flow is registration open, registration closed, check-in, then start tournament.</p>
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

          <div className="management-actions">
            <div>
              <h3>Manual Seeds</h3>
              <p className="muted">
                Assign optional tournament seeds from the Players tab before generating the draw. Seeded players are placed first; unseeded checked-in players are randomly drawn into remaining slots.
              </p>
              <p className="muted">
                {isGroupStageTournament
                  ? `${explainGroupSeedPlacement(tournament.groups_count ?? 0)} Empty group slots become BYE/no-match slots and do not count in standings.`
                  : `Seeds 1-${maxManualSeedForTournament} are available for the selected bracket size.`}
              </p>
            </div>
            <MatchStatusBadge tone={canEditManualSeeds ? "gold" : "muted"}>
              {canEditManualSeeds ? "Editable" : "Locked After Draw"}
            </MatchStatusBadge>
          </div>

          {roles.isAdmin && !isGroupStageTournament ? (
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

          {!isGroupStageTournament ? (
            <>
          <div className="management-actions">
            <div>
              <h3>Bracket Setup</h3>
              <p className={bracketWarning ? "muted" : undefined}>
                {bracketWarning ?? "Ready to start from checked-in players."}
              </p>
              <p className="muted">
                Bracket size: {selectedBracketSize} players. Round defaults: pre-semifinal{" "}
                {matchFormatLabels[tournament.pre_semifinal_match_format]}, semifinal{" "}
                {matchFormatLabels[tournament.semifinal_match_format]}, final{" "}
                {matchFormatLabels[tournament.final_match_format]}.
              </p>
            </div>
            <div className="status-control">
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

          <div className="management-actions">
            <div>
              <h3>Start Tournament</h3>
              <p className="muted">
                Starts the tournament, places manual seeds first, fills remaining bracket slots by random draw when seeds are assigned or {seedingMethodLabels[selectedSeedingMethod].toLowerCase()} otherwise, applies BYEs, and opens first-round matches.
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
                onClick={startTournament}
              >
                {savingAction === "generate" ? "Starting..." : "Start Tournament"}
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
            </>
          ) : (
            <>
              <div className="management-actions">
                <div>
                  <h3>Group Stage Setup</h3>
                  <p className={groupDrawWarning ? "error" : "muted"}>
                    {groupDrawWarning ??
                      (hasGroupDraw
                        ? "Group draw has been generated."
                        : "Ready to start from checked-in players.")}
                  </p>
                  <p className="muted">
                    {tournament.groups_count} groups of {tournament.group_size}, top{" "}
                    {tournament.qualifiers_per_group} advance. Group matches are{" "}
                    {tournament.group_stage_format
                      ? matchFormatLabels[tournament.group_stage_format]
                      : "not set"}
                    .
                  </p>
                  {checkedInParticipants.length < (tournament.groups_count ?? 0) * 2 ? (
                    <p className="muted">
                      Underfilled starts are allowed for testing; checked-in players are distributed evenly across groups and unused slots become BYE/no-match slots.
                    </p>
                  ) : null}
                </div>
                <div className="status-control">
                  <label htmlFor="group-draw-method">
                    Draw Method
                    <select
                      id="group-draw-method"
                      disabled={hasGroupDraw}
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

              <div className="management-actions">
                <div>
                  <h3>Start Tournament</h3>
                  <p className="muted">
                    Starts the tournament, places manual seeds first, draws unseeded checked-in players into balanced group slots, and creates player-vs-player group match rooms. With manual seeds, unseeded players are random-drawn. Empty group slots are labeled BYE/no-match and skipped.
                  </p>
                </div>
                <div className="role-actions">
                  <button
                    className="button"
                    disabled={
                      savingAction === "generate-groups" ||
                      hasGroupDraw ||
                      tournament.status !== "check_in" ||
                      Boolean(groupDrawWarning)
                    }
                    type="button"
                    onClick={startTournament}
                  >
                    {savingAction === "generate-groups" ? "Starting..." : "Start Tournament"}
                  </button>
                  <button
                    className="button danger-button"
                    disabled={savingAction === "reset-groups" || !hasGroupDraw || hasPlayoffBracket}
                    type="button"
                    onClick={resetGroupDraw}
                  >
                    {savingAction === "reset-groups" ? "Resetting..." : "Reset Group Draw"}
                  </button>
                </div>
              </div>

              <div className="management-actions">
                <div>
                  <h3>Playoff Handoff</h3>
                  <p className={playoffBlockedReason ? "error" : "muted"}>
                    {hasPlayoffBracket
                      ? "Playoff bracket has been generated."
                      : playoffBlockedReason ??
                        `The ${totalGroupQualifiers}-player single-elimination playoff bracket will generate automatically when all group matches are finalized.`}
                  </p>
                </div>
              </div>
            </>
          )}

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

      {historyGroup ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setHistoryGroupId(null)}
        >
          <section
            aria-labelledby="group-history-title"
            aria-modal="true"
            className="modal-card group-history-modal"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-heading">
              <div>
                <h2 id="group-history-title">{historyGroup.name} Match History</h2>
                <p className="muted">Real player matches only. BYE/no-match slots are hidden.</p>
              </div>
              <button
                className="button secondary-button"
                type="button"
                onClick={() => setHistoryGroupId(null)}
              >
                Close
              </button>
            </div>

            {historyMatchesByRound.length === 0 ? (
              <p className="muted">No player-vs-player group matches were created for this group.</p>
            ) : (
              <div className="match-history-list">
                {historyMatchesByRound.map((roundGroup) => (
                  <section key={roundGroup.roundNumber}>
                    <h3>Round {roundGroup.roundNumber}</h3>
                    <div className="match-list">
                      {roundGroup.matches.map((match) => {
                        const finalScoreLabel = formatMatchFinalScore(match);
                        const forfeitLabel = isForfeitResult(match) ? "Forfeit" : null;

                        return (
                          <article className="match-history-row" key={match.id}>
                            <div>
                              <h3>Match {match.match_number ?? match.bracket_position}</h3>
                              <p className="muted">
                                <PlayerProfileLink userId={match.player_one_id}>
                                  {describeMatchSlot(
                                    match.player_one_id,
                                    profileMap,
                                    match.player_one_seed,
                                    "TBD",
                                  )}
                                </PlayerProfileLink>{" "}
                                vs{" "}
                                <PlayerProfileLink userId={match.player_two_id}>
                                  {describeMatchSlot(
                                    match.player_two_id,
                                    profileMap,
                                    match.player_two_seed,
                                    "TBD",
                                  )}
                                </PlayerProfileLink>
                              </p>
                              {match.winner_id ? (
                                <p className="notice">
                                  Winner:{" "}
                                  <PlayerProfileLink userId={match.winner_id}>
                                    {getProfileName(profileMap, match.winner_id) ?? "Player"}
                                  </PlayerProfileLink>
                                  {finalScoreLabel ? ` ${finalScoreLabel}` : ""}
                                </p>
                              ) : (
                                <p className="muted">Winner pending.</p>
                              )}
                            </div>
                            <div className="match-history-meta">
                              <span className="badge">{matchFormatLabels[match.format]}</span>
                              {forfeitLabel ? (
                                <span className="badge status-badge-danger">{forfeitLabel}</span>
                              ) : null}
                              <MatchStatusBadge tone={getMatchStatusTone(match)}>
                                {matchStatusLabels[match.status]}
                              </MatchStatusBadge>
                              {isPlayableMatch(match) ? (
                                <Link
                                  className="button secondary-button button-link"
                                  href={`/matches/${match.id}`}
                                >
                                  Match Room
                                </Link>
                              ) : null}
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
        </div>
      ) : null}
    </>
  );
}
