"use client";

import Link from "next/link";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  formatLiveControlBlockerReason,
  formatTimerOutcomeSummary,
  getCheckInExpirySummary,
  getBracketReadiness,
  getBracketTimingRows,
  getDisputeSummary,
  getExpiredTimingActions,
  getGroupDrawReadiness,
  getGroupStageProgress,
  getGroupTimingMatrix,
  getManualSeedSummary,
  getMatchAttentionBuckets,
  getReplacementWindowSummary,
  getRoundExpirySummary,
  getPlayoffReadiness,
  getRegistrationCheckInSummary,
  getTournamentCompletionReadiness,
  getTournamentLiveSummary,
  getTournamentNextAction,
  type MatchAttentionBucketKey,
  type MatchAttentionItem,
} from "@/lib/live-control";
import { ensureProfile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  automationModeLabels,
  buildAutomationPolicyPayload,
  formatAutomationEvent,
  getAutomationPolicyWarnings,
  getEnabledAutomationToggleLabels,
  isAutomationActionEnabled,
  neitherCheckedInTimeoutPolicyLabels,
  normalizeAutomationPolicy,
  oneCheckedInTimeoutPolicyLabels,
  shouldRunAutomaticAutomation,
  type AutomationActionKind,
  type TournamentAutomationEventRow,
} from "@/lib/tournament-automation";
import { updateTournamentRegistrationSeed } from "@/lib/tournament-registration-seeds";
import {
  canExtendTournamentWindow,
  canPauseTournamentTimers,
  createDeadlinePatch,
  extendTournamentWindow,
  forceCloseTournamentWindow,
  generateTournamentTimingRulesText,
  getCountdownLabel,
  getCurrentTournamentTimingState,
  getRoundDurationForFormat,
  getStatusTimingPatch,
  getTimingWindowLabel,
  normalizeTournamentTimingSettings,
  pauseTournamentTimers,
  resumeTournamentTimers,
  type TournamentTimingControlPatch,
  type TournamentTimingWindow,
} from "@/lib/tournament-timing";
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
  tournamentTierLabels,
  type MatchFormat,
  type MatchEvidenceRow,
  type MatchCheckInRow,
  type MatchReportRow,
  type MatchRow,
  type TournamentCheckInRow,
  type DisputeRow,
  type TournamentGroupMemberRow,
  type TournamentGroupRow,
  type TournamentRegistrationRow,
  type TournamentRoundRow,
  type TournamentRow,
  type TournamentStageRow,
  type TournamentStatus,
} from "@/lib/tournaments";
import type { Json } from "@/types/database.generated";

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
  isReplacement: boolean;
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
  | "replacement-claim"
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
  | "timing"
  | "timer-expiry"
  | "open-ready"
  | "automation"
  | "reset"
  | "activate"
  | null;

type ActiveSavingAction = Exclude<SavingAction, null>;
type TournamentTabKey = "overview" | "players" | "groups" | "bracket" | "rules" | "live" | "admin";

type MatchRoundGroup = {
  round: TournamentRoundRow;
  matches: MatchRow[];
};

type ShareStatus = "idle" | "copied" | "failed";

function buildTournamentShareUrl(tournamentId: string) {
  const path = `/tournaments/${tournamentId}#registration`;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return `${origin}${path}`;
}

function copyTextFallback(text: string) {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function TournamentShareButton({
  isCopied,
  onShare,
}: {
  isCopied: boolean;
  onShare: () => void;
}) {
  return (
    <button className="button secondary-button" type="button" onClick={onShare}>
      {isCopied ? "Link copied" : "Share Tournament"}
    </button>
  );
}

function TournamentShareFeedback({
  fallbackUrl,
  status,
}: {
  fallbackUrl: string;
  status: ShareStatus;
}) {
  if (status === "copied") {
    return (
      <p className="notice" aria-live="polite">
        Tournament link copied
      </p>
    );
  }

  if (status !== "failed") {
    return null;
  }

  return (
    <div className="share-link-fallback" aria-live="polite">
      <p className="error">Copy failed - select and copy this link</p>
      <input
        aria-label="Tournament share link"
        readOnly
        type="url"
        value={fallbackUrl}
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}

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
      !["withdrawn", "rejected", "missed_check_in", "excluded"].includes(registration.status),
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

type GroupRoundRobinPairing = {
  playerOne: TournamentGroupMemberRow;
  playerTwo: TournamentGroupMemberRow;
  roundNumber: number;
};

function createRoundRobinPairings(members: TournamentGroupMemberRow[]) {
  const orderedMembers = members
    .filter((member) => !isGroupBye(member) && member.user_id)
    .slice()
    .sort((first, second) => first.seed - second.seed);

  if (orderedMembers.length < 2) {
    return [];
  }

  const rotation: (TournamentGroupMemberRow | null)[] =
    orderedMembers.length % 2 === 0 ? orderedMembers : [...orderedMembers, null];
  const rounds: GroupRoundRobinPairing[] = [];
  const playerCount = rotation.length;

  for (let roundIndex = 0; roundIndex < playerCount - 1; roundIndex += 1) {
    for (let pairIndex = 0; pairIndex < playerCount / 2; pairIndex += 1) {
      const first = rotation[pairIndex];
      const second = rotation[playerCount - 1 - pairIndex];

      if (first && second) {
        rounds.push({
          playerOne: roundIndex % 2 === 0 ? first : second,
          playerTwo: roundIndex % 2 === 0 ? second : first,
          roundNumber: roundIndex + 1,
        });
      }
    }

    const fixed = rotation[0] ?? null;
    const rotating = rotation.slice(1);
    const last = rotating.pop() ?? null;
    rotation.splice(0, rotation.length, fixed, last, ...rotating);
  }

  return rounds;
}

function isEligibleParticipant(participant: Participant) {
  return !["withdrawn", "rejected", "missed_check_in", "excluded"].includes(
    participant.registrationStatus,
  );
}

function formatRegistrationStatus(status: TournamentRegistrationRow["status"]) {
  const labels: Record<TournamentRegistrationRow["status"], string> = {
    accepted: "Accepted",
    active: "Active",
    checked_in: "Checked In",
    excluded: "Excluded",
    missed_check_in: "Missed Check-In",
    pending: "Registered",
    rejected: "Rejected",
    replaced: "Replacement",
    withdrawn: "Withdrawn",
  };

  return labels[status];
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

function formatTimingCellState(state: string) {
  const labels: Record<string, string> = {
    active: "Timer active",
    blocked: "Review",
    complete: "Complete",
    empty: "No match",
    expired: "Expired",
    open: "Open, timer pending",
    waiting: "Waiting",
  };

  return labels[state] ?? state;
}

function getTimingCellClassName(state: string) {
  return ["timing-cell", `timing-cell-${state}`].join(" ");
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
    tabs.push({ key: "live", label: "Live Control" });
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

function LiveMetricCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="live-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TimingDeadline({
  deadline,
  now,
  paused,
}: {
  deadline: Date | null;
  now: Date;
  paused: boolean;
}) {
  return (
    <>
      <strong>{getCountdownLabel(deadline, paused, now)}</strong>
      <span className="muted">{deadline ? formatDateTime(deadline.toISOString()) : "No deadline set"}</span>
    </>
  );
}

function LiveAttentionRows({
  emptyMessage,
  items,
}: {
  emptyMessage: string;
  items: MatchAttentionItem[];
}) {
  if (items.length === 0) {
    return <p className="muted">{emptyMessage}</p>;
  }

  return (
    <div className="live-attention-list">
      {items.map((item) => (
        <article className="live-attention-row" key={item.id}>
          <div>
            <h3>{item.label}</h3>
            <p className="muted">{item.players}</p>
            <p className="muted">
              Host: {item.hostName ?? "Not assigned"}
              {item.score ? ` · Score ${item.score}` : ""}
            </p>
          </div>
          <div className="live-attention-meta">
            <MatchStatusBadge tone={item.bucket === "needsReview" ? "danger" : item.bucket === "completed" ? "gold" : "muted"}>
              {matchStatusLabels[item.status]}
            </MatchStatusBadge>
            {item.bucket !== "nonPlayable" ? (
              <Link className="button secondary-button button-link" href={`/matches/${item.id}`}>
                Match Room
              </Link>
            ) : null}
          </div>
        </article>
      ))}
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
  const [matchCheckIns, setMatchCheckIns] = useState<MatchCheckInRow[]>([]);
  const [matchReports, setMatchReports] = useState<MatchReportRow[]>([]);
  const [matchEvidence, setMatchEvidence] = useState<MatchEvidenceRow[]>([]);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [automationEvents, setAutomationEvents] = useState<TournamentAutomationEventRow[]>([]);
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
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [shareFallbackUrl, setShareFallbackUrl] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [clockNow, setClockNow] = useState(() => new Date());
  const lastAutomaticAutomationSignatureRef = useRef("");
  const generateBracketActionRef = useRef<(() => Promise<void>) | null>(null);
  const generateGroupDrawActionRef = useRef<(() => Promise<void>) | null>(null);
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
        setMatchCheckIns([]);
        setMatchReports([]);
        setMatchEvidence([]);
        setDisputes([]);
        setAutomationEvents([]);
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
        automationEventsResult,
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
          .from("tournament_automation_events")
          .select("*")
          .eq("tournament_id", loadedTournament.id)
          .order("created_at", { ascending: false })
          .limit(8),
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
      if (automationEventsResult.error) throw automationEventsResult.error;
      if (groupsResult.error) throw groupsResult.error;
      if (groupMembersResult.error) throw groupMembersResult.error;

      const countRow = countResult.data as RegistrationCountRow | null;
      const checkIns = (checkInResult.data ?? []) as TournamentCheckInRow[];
      const canLoadStaffReviewData = Boolean(
        currentUser &&
          (loadedRoles.isAdmin ||
            loadedTournament.created_by === currentUser.id ||
            organizerAccessResult.data),
      );
      const matchIds = matchesResult.data.map((match) => match.id);
      const [
        matchCheckInsResult,
        matchReportsResult,
        matchEvidenceResult,
        disputesResult,
      ] = canLoadStaffReviewData && matchIds.length > 0
        ? await Promise.all([
            supabase
              .from("match_check_ins")
              .select("*")
              .in("match_id", matchIds)
              .order("checked_in_at", { ascending: true }),
            supabase
              .from("match_reports")
              .select("*")
              .in("match_id", matchIds)
              .order("created_at", { ascending: true }),
            supabase
              .from("match_evidence")
              .select("*")
              .in("match_id", matchIds)
              .order("created_at", { ascending: true }),
            supabase
              .from("disputes")
              .select("*")
              .in("match_id", matchIds)
              .order("created_at", { ascending: false }),
          ])
        : [
            { data: [], error: null },
            { data: [], error: null },
            { data: [], error: null },
            { data: [], error: null },
          ];

      if (matchCheckInsResult.error) throw matchCheckInsResult.error;
      if (matchReportsResult.error) throw matchReportsResult.error;
      if (matchEvidenceResult.error) throw matchEvidenceResult.error;
      if (disputesResult.error) throw disputesResult.error;

      const loadedMatchCheckIns = (matchCheckInsResult.data ?? []) as MatchCheckInRow[];
      const loadedMatchReports = (matchReportsResult.data ?? []) as MatchReportRow[];
      const loadedMatchEvidence = (matchEvidenceResult.data ?? []) as MatchEvidenceRow[];
      const loadedDisputes = (disputesResult.data ?? []) as DisputeRow[];
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
            match.host_user_id,
            match.player_one_id,
            match.player_two_id,
            match.winner_id,
          ]),
          ...loadedMatchReports.flatMap((report) => [
            report.reporter_id,
            report.reported_winner_id,
          ]),
          ...loadedMatchEvidence.map((item) => item.uploaded_by),
          ...loadedDisputes.flatMap((dispute) => [
            dispute.opened_by,
            dispute.assigned_to,
            dispute.resolved_by,
            dispute.resolution_winner_id,
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
        isReplacement: row.is_replacement,
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
      setMatchCheckIns(loadedMatchCheckIns);
      setMatchReports(loadedMatchReports);
      setMatchEvidence(loadedMatchEvidence);
      setDisputes(loadedDisputes);
      setAutomationEvents((automationEventsResult.data ?? []) as TournamentAutomationEventRow[]);
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
        setSelectedSeedingMethod(loadedTournament.draw_seeding_method);
        setRoundFormats(getTournamentRoundFormats(loadedTournament, loadedTournament.max_players));
      } else {
        setSelectedSeedingMethod(loadedTournament.draw_seeding_method);
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

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClockNow(new Date());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const canManageTournament = useMemo(() => {
    if (!user || !tournament) {
      return false;
    }

    return roles.isAdmin || tournament.created_by === user.id || isManagedByUser;
  }, [isManagedByUser, roles.isAdmin, tournament, user]);
  const canControlTiming = Boolean(
    tournament &&
      canPauseTournamentTimers(tournament, roles, user?.id ?? null, isManagedByUser),
  );
  const canExtendTiming = Boolean(
    tournament &&
      canExtendTournamentWindow(tournament, roles, user?.id ?? null, isManagedByUser),
  );

  const registeredParticipants = useMemo(() => {
    return participants.filter(isEligibleParticipant);
  }, [participants]);

  const checkedInParticipants = useMemo(() => {
    return registeredParticipants.filter((participant) => Boolean(participant.checkIn));
  }, [registeredParticipants]);

  const isGroupStageTournament = tournament?.tournament_format === "group_stage_playoff";
  const timingSettings = tournament ? normalizeTournamentTimingSettings(tournament) : null;
  const automationPolicy = tournament ? normalizeAutomationPolicy(tournament) : null;
  const automationWarnings = automationPolicy ? getAutomationPolicyWarnings(automationPolicy) : [];
  const enabledAutomationToggleLabels = automationPolicy
    ? getEnabledAutomationToggleLabels(automationPolicy)
    : [];
  const timingState = tournament
    ? getCurrentTournamentTimingState(tournament, Boolean(isGroupStageTournament), clockNow)
    : null;
  const checkInExpirySummary = tournament
    ? getCheckInExpirySummary(tournament, participants, clockNow)
    : null;
  const replacementWindowSummary = tournament
    ? getReplacementWindowSummary(tournament, participants, clockNow)
    : null;
  const generatedTimingRules = tournament
    ? generateTournamentTimingRulesText(tournament)
    : "";
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
  const groupStageRounds = useMemo(
    () => (groupStage ? rounds.filter((round) => round.stage_id === groupStage.id) : []),
    [groupStage, rounds],
  );
  const playoffStageRounds = useMemo(
    () => (playoffStage ? rounds.filter((round) => round.stage_id === playoffStage.id) : []),
    [playoffStage, rounds],
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
      !ownCheckIn &&
      !checkInExpirySummary?.expired,
  );
  const canClaimReplacement = Boolean(
    user &&
      tournament?.status === "check_in" &&
      replacementWindowSummary?.active &&
      !isActiveRegistration(registration),
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
  const liveRegistrationSummary = tournament
    ? getRegistrationCheckInSummary(tournament, participants, selectedBracketSize)
    : null;
  const liveManualSeedSummary = getManualSeedSummary(participants);
  const liveGroupDrawReadiness =
    tournament && liveRegistrationSummary
      ? getGroupDrawReadiness(tournament, liveRegistrationSummary.checkedInCount, hasGroupDraw)
      : null;
  const liveBracketReadiness =
    tournament && liveRegistrationSummary
      ? getBracketReadiness(
          tournament,
          liveRegistrationSummary.checkedInCount,
          selectedBracketSize,
          hasGeneratedBracket,
        )
      : null;
  const liveDisputeSummary = useMemo(
    () => getDisputeSummary(disputes, matchReports, matchEvidence),
    [disputes, matchEvidence, matchReports],
  );
  const liveMatchAttentionBuckets = useMemo(
    () =>
      getMatchAttentionBuckets(
        matches,
        groupsWithMembers,
        profileMap,
        liveDisputeSummary.mismatchMatchIds,
      ),
    [groupsWithMembers, liveDisputeSummary.mismatchMatchIds, matches, profileMap],
  );
  const liveGroupStageProgress = useMemo(
    () =>
      tournament
        ? getGroupStageProgress(groupsWithMembers, matches, tournament, profileMap)
        : [],
    [groupsWithMembers, matches, profileMap, tournament],
  );
  const liveCompletionReadiness = tournament
    ? getTournamentCompletionReadiness(tournament, matches, playoffMatches, profileMap)
    : null;
  const livePlayoffReadiness = tournament
    ? getPlayoffReadiness(groupsWithMembers, matches, tournament, hasPlayoffBracket)
    : null;
  const liveGroupTimingMatrix = tournament
    ? getGroupTimingMatrix({
        groups: groupsWithMembers,
        matches: groupStageMatches,
        rounds: groupStageRounds,
        tournament,
      })
    : null;
  const liveBracketTimingRows = tournament
    ? getBracketTimingRows({
        matches: playoffMatches.length > 0 ? playoffMatches : matches.filter((match) => !match.group_id),
        rounds: playoffStageRounds.length > 0 ? playoffStageRounds : rounds.filter((round) => {
          const stage = stages.find((item) => item.id === round.stage_id);
          return stage?.bracket_type === "single_elimination";
        }),
        tournament,
      })
    : [];
  const liveRoundExpirySummary = tournament
    ? getRoundExpirySummary({
        checkIns: matchCheckIns,
        groups: groupsWithMembers,
        matches,
        phase: isGroupStageTournament && !hasPlayoffBracket ? "group" : "bracket",
        reports: matchReports,
        tournament,
      })
    : null;
  const liveSummary =
    tournament && liveRegistrationSummary
      ? getTournamentLiveSummary({
          disputes,
          hasGroupDraw,
          hasPlayoffBracket,
          matches,
          participants,
          reports: matchReports,
          selectedBracketSize,
          tournament,
        })
      : null;
  const expiredTimingActions = tournament
    ? getExpiredTimingActions({
        bracketReadiness: liveBracketReadiness,
        canManageTournament,
        checkInSummary: checkInExpirySummary,
        groupDrawReadiness: liveGroupDrawReadiness,
        hasGeneratedBracket,
        replacementSummary: replacementWindowSummary,
        roundSummary: liveRoundExpirySummary,
        tournament,
      })
    : [];
  const eligibleAutomaticActions: {
    detail: string;
    enabled: boolean;
    kind: AutomationActionKind;
    label: string;
  }[] = automationPolicy && tournament
    ? [
        ...(tournament.status === "registration_open" &&
        tournament.registration_closes_at &&
        new Date(tournament.registration_closes_at).getTime() <= clockNow.getTime()
          ? [
              {
                detail: "Registration deadline has passed.",
                enabled: isAutomationActionEnabled("close_registration", automationPolicy),
                kind: "close_registration" as const,
                label: "Close registration",
              },
            ]
          : []),
        ...(tournament.status === "registration_closed" &&
        tournament.starts_at &&
        new Date(tournament.starts_at).getTime() <= clockNow.getTime()
          ? [
              {
                detail: "Scheduled start time has arrived.",
                enabled: isAutomationActionEnabled("open_check_in", automationPolicy),
                kind: "open_check_in" as const,
                label: "Open check-in",
              },
            ]
          : []),
        ...expiredTimingActions.map((action) => ({
          detail: action.detail,
          enabled:
            action.enabled &&
            isAutomationActionEnabled(action.kind as AutomationActionKind, automationPolicy),
          kind: action.kind as AutomationActionKind,
          label: action.label,
        })),
        ...(tournament.status === "active" &&
        matches.some(
          (match) =>
            match.player_one_id &&
            match.player_two_id &&
            (match.status === "pending" || match.status === "blocked"),
        )
          ? [
              {
                detail: "Known-player matches are waiting to open or sync round timers.",
                enabled: isAutomationActionEnabled("open_ready_matches", automationPolicy),
                kind: "open_ready_matches" as const,
                label: "Open ready matches",
              },
            ]
          : []),
        ...(livePlayoffReadiness?.ready
          ? [
              {
                detail: "Groups are resolved and playoff generation is safe.",
                enabled: isAutomationActionEnabled("generate_group_playoff", automationPolicy),
                kind: "generate_group_playoff" as const,
                label: "Generate playoff",
              },
            ]
          : []),
      ]
    : [];
  const runnableAutomaticActions =
    automationPolicy?.automationMode === "automatic"
      ? eligibleAutomaticActions.filter((action) => action.enabled)
      : [];
  const automaticAutomationSignature = runnableAutomaticActions
    .map((action) => action.kind)
    .join("|");

  const liveNextAction =
    tournament &&
    liveRegistrationSummary &&
    liveGroupDrawReadiness &&
    liveBracketReadiness &&
    liveCompletionReadiness
      ? getTournamentNextAction({
          bracketReadiness: liveBracketReadiness,
          completionReadiness: liveCompletionReadiness,
          disputeSummary: liveDisputeSummary,
          groupDrawReadiness: liveGroupDrawReadiness,
          groupStageMatches,
          groups: groupsWithMembers,
          hasGeneratedBracket,
          hasGroupDraw,
          hasPlayoffBracket,
          matches,
          playoffBlockedReason,
          playoffMatches,
          registrationSummary: liveRegistrationSummary,
          tournament,
        })
      : null;
  const urgentLiveAttentionItems = [
    ...liveMatchAttentionBuckets.needsReview,
    ...liveMatchAttentionBuckets.resultNeeded,
    ...liveMatchAttentionBuckets.hostSetup,
    ...liveMatchAttentionBuckets.inGame,
  ];

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

  async function claimReplacementSpot() {
    if (!user || !tournament || !canClaimReplacement) {
      return;
    }

    setSavingAction("replacement-claim");
    setNotice(null);
    setError(null);

    try {
      await ensureProfile(supabase, user);

      const { error: claimError } = await supabase.rpc("claim_replacement_spot", {
        target_tournament: tournament.id,
      });

      if (claimError) {
        throw claimError;
      }

      setNotice("Replacement spot claimed and checked in.");
      await loadTournament();
    } catch (caughtError) {
      logError("Replacement claim failed.", caughtError);
      setError(formatError(caughtError, "Unable to claim a replacement spot."));
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
          ...getStatusTimingPatch(tournament, status),
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

  async function updateTournamentTiming(
    patch: TournamentTimingControlPatch,
    successMessage: string,
  ) {
    if (!tournament || !canControlTiming) {
      return;
    }

    setSavingAction("timing");
    setNotice(null);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from("tournaments")
        .update({
          ...patch,
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
      logError("Tournament timing update failed.", caughtError);
      setError(formatError(caughtError, "Unable to update tournament timing."));
    } finally {
      setSavingAction(null);
    }
  }

  async function pauseTimers() {
    if (!tournament || tournament.timers_paused_at) {
      return;
    }

    await updateTournamentTiming(pauseTournamentTimers(), "Tournament timers paused.");
  }

  async function resumeTimers() {
    if (!tournament || !tournament.timers_paused_at) {
      return;
    }

    await updateTournamentTiming(resumeTournamentTimers(tournament), "Tournament timers resumed.");
  }

  async function extendTimingWindow(timingWindow: TournamentTimingWindow, minutes: number) {
    if (!tournament || !canExtendTiming) {
      return;
    }

    await updateTournamentTiming(
      extendTournamentWindow(tournament, timingWindow, minutes),
      `${getTimingWindowLabel(timingWindow)} extended by ${minutes} minutes.`,
    );
  }

  async function forceCloseTimingWindow(timingWindow: TournamentTimingWindow) {
    if (!tournament || !canExtendTiming) {
      return;
    }

    const confirmed = window.confirm(
      `Force close the ${getTimingWindowLabel(timingWindow).toLowerCase()} timer? This only marks the timer expired; it will not resolve matches automatically.`,
    );

    if (!confirmed) {
      return;
    }

    await updateTournamentTiming(
      forceCloseTournamentWindow(timingWindow),
      `${getTimingWindowLabel(timingWindow)} marked expired.`,
    );
  }

  async function logAutomationEvent(
    eventType: string,
    source: TournamentAutomationEventRow["source"],
    details: Record<string, unknown> = {},
  ) {
    if (!tournament || !user || !canManageTournament) {
      return;
    }

    const { error: insertError } = await supabase.from("tournament_automation_events").insert({
      actor_id: user.id,
      actor_type: roles.isAdmin ? "admin" : "organizer",
      details: details as Json,
      event_type: eventType,
      source,
      tournament_id: tournament.id,
    });

    if (insertError) {
      logError("Automation event logging failed.", insertError);
    }
  }

  async function applyExpiredTimingAction(
    actionKind: (typeof expiredTimingActions)[number]["kind"],
    options: { confirm?: boolean; source?: TournamentAutomationEventRow["source"] } = {},
  ) {
    if (!tournament || !canManageTournament) {
      return;
    }

    if (actionKind === "generate_group_draw") {
      if (!generateGroupDrawActionRef.current) {
        setError("Group draw generation is unavailable right now.");
        return;
      }

      await generateGroupDrawActionRef.current();
      return;
    }

    if (actionKind === "generate_bracket") {
      if (!generateBracketActionRef.current) {
        setError("Bracket generation is unavailable right now.");
        return;
      }

      await generateBracketActionRef.current();
      return;
    }

    const confirmed =
      options.confirm === false
        ? true
        : window.confirm(
            "Apply this expired timer action now? This may update registration statuses or unresolved match outcomes according to the timing rules.",
          );

    if (!confirmed) {
      return;
    }

    setSavingAction("timer-expiry");
    setNotice(null);
    setError(null);

    try {
      if (actionKind === "apply_check_in_expiry") {
        const { error: rpcError } = await supabase.rpc("apply_expired_check_in_window", {
          target_tournament: tournament.id,
        });

        if (rpcError) {
          throw rpcError;
        }

        await logAutomationEvent("apply_check_in_expiry", options.source ?? "manual_button");
        setNotice("Expired check-in window applied.");
      } else if (actionKind === "apply_replacement_expiry") {
        const { error: rpcError } = await supabase.rpc("apply_expired_replacement_window", {
          target_tournament: tournament.id,
        });

        if (rpcError) {
          throw rpcError;
        }

        await logAutomationEvent("apply_replacement_expiry", options.source ?? "manual_button");
        setNotice("Expired replacement window applied.");
      } else if (actionKind === "apply_group_round_expiry") {
        const payload: {
          target_group?: string;
          target_phase: "group" | "bracket";
          target_round?: number;
          target_tournament: string;
        } = {
          target_phase: "group",
          target_tournament: tournament.id,
        };
        const { error: rpcError } = await supabase.rpc("apply_expired_round_outcomes", payload);

        if (rpcError) {
          throw rpcError;
        }

        await logAutomationEvent("apply_group_round_expiry", options.source ?? "manual_button");
        setNotice("Expired group round outcomes applied.");
      } else if (actionKind === "apply_bracket_round_expiry") {
        const payload: {
          target_group?: string;
          target_phase: "group" | "bracket";
          target_round?: number;
          target_tournament: string;
        } = {
          target_phase: "bracket",
          target_tournament: tournament.id,
        };
        const { error: rpcError } = await supabase.rpc("apply_expired_round_outcomes", payload);

        if (rpcError) {
          throw rpcError;
        }

        await logAutomationEvent("apply_bracket_round_expiry", options.source ?? "manual_button");
        setNotice("Expired bracket round outcomes applied.");
      }

      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      logError("Expired timing action failed.", caughtError);
      setError(formatError(caughtError, "Unable to apply expired timing action."));
    } finally {
      setSavingAction(null);
    }
  }

  async function openReadyMatchesAndTimers(
    source: TournamentAutomationEventRow["source"] = "manual_button",
  ) {
    if (!tournament || !canManageTournament) {
      return;
    }

    setSavingAction("open-ready");
    setNotice(null);
    setError(null);

    try {
      const { error: rpcError } = await supabase.rpc("apply_ready_match_openings", {
        target_tournament: tournament.id,
      });

      if (rpcError) {
        throw rpcError;
      }

      setNotice("Ready matches opened and round timers synced.");
      await logAutomationEvent("open_ready_matches", source);
      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      logError("Ready match opening failed.", caughtError);
      setError(formatError(caughtError, "Unable to open ready matches."));
    } finally {
      setSavingAction(null);
    }
  }

  async function updateAutomationPolicy(
    patch: Partial<ReturnType<typeof buildAutomationPolicyPayload>>,
    successMessage: string,
  ) {
    if (!tournament || !automationPolicy || !canManageTournament) {
      return;
    }

    setSavingAction("automation");
    setNotice(null);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from("tournaments")
        .update({
          ...patch,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tournament.id);

      if (updateError) {
        throw updateError;
      }

      await logAutomationEvent("policy_updated", "live_control", patch);
      setNotice(successMessage);
      await loadTournament();
      router.refresh();
    } catch (caughtError) {
      logError("Automation policy update failed.", caughtError);
      setError(formatError(caughtError, "Unable to update automation policy."));
    } finally {
      setSavingAction(null);
    }
  }

  async function pauseAutomation() {
    await updateAutomationPolicy(
      { automation_paused_at: new Date().toISOString() },
      "Automation paused.",
    );
  }

  async function resumeAutomation() {
    await updateAutomationPolicy({ automation_paused_at: null }, "Automation resumed.");
  }

  async function switchAutomationToManual() {
    await updateAutomationPolicy(
      { automation_mode: "manual", automation_paused_at: new Date().toISOString() },
      "Automation switched to Manual and paused.",
    );
  }

  async function applyAutomationAction(
    actionKind: AutomationActionKind,
    source: TournamentAutomationEventRow["source"],
    confirmAction = false,
  ) {
    if (!tournament || !canManageTournament) {
      return;
    }

    if (confirmAction) {
      const confirmed = window.confirm(
        "Apply eligible automatic actions now? Only currently eligible actions enabled by this tournament policy will run.",
      );

      if (!confirmed) {
        return;
      }
    }

    if (actionKind === "close_registration") {
      await updateTournamentStatusTo("registration_closed", "Registration closed.", "automation");
      await logAutomationEvent("close_registration", source);
    } else if (actionKind === "open_check_in") {
      await updateTournamentStatusTo("check_in", "Check-in opened.", "automation");
      await logAutomationEvent("open_check_in", source);
    } else if (
      actionKind === "apply_check_in_expiry" ||
      actionKind === "apply_replacement_expiry" ||
      actionKind === "apply_group_round_expiry" ||
      actionKind === "apply_bracket_round_expiry"
    ) {
      await applyExpiredTimingAction(actionKind, { confirm: false, source });
    } else if (actionKind === "generate_group_draw") {
      if (!generateGroupDrawActionRef.current) {
        setError("Group draw generation is unavailable right now.");
        return;
      }

      await generateGroupDrawActionRef.current();
      await logAutomationEvent("generate_group_draw", source);
    } else if (actionKind === "generate_bracket") {
      if (!generateBracketActionRef.current) {
        setError("Bracket generation is unavailable right now.");
        return;
      }

      await generateBracketActionRef.current();
      await logAutomationEvent("generate_bracket", source);
    } else if (actionKind === "open_ready_matches") {
      await openReadyMatchesAndTimers(source);
    } else if (actionKind === "generate_group_playoff" && user) {
      setSavingAction("automation");
      setNotice(null);
      setError(null);

      try {
        const { error: rpcError } = await supabase.rpc("auto_generate_group_playoff", {
          actor: user.id,
          target_tournament: tournament.id,
        });

        if (rpcError) {
          throw rpcError;
        }

        await logAutomationEvent("generate_group_playoff", source);
        setNotice("Playoff generated.");
        await loadTournament();
        router.refresh();
      } catch (caughtError) {
        logError("Automatic playoff generation failed.", caughtError);
        setError(formatError(caughtError, "Unable to generate playoff bracket."));
      } finally {
        setSavingAction(null);
      }
    }
  }

  async function applyEligibleAutomationActions(
    source: TournamentAutomationEventRow["source"] = "manual_button",
    confirmAction = true,
  ) {
    if (!tournament || !automationPolicy || !canManageTournament || tournament.timers_paused_at) {
      return;
    }

    if (automationPolicy.automationMode !== "automatic") {
      setNotice("Manual mode is active. Use the individual Live Control buttons to apply actions.");
      return;
    }

    if (automationPolicy.automationPausedAt) {
      setError("Automation is paused. Resume automation before running eligible actions.");
      return;
    }

    const actions = runnableAutomaticActions;

    if (actions.length === 0) {
      setNotice("No eligible automatic actions are currently enabled.");
      return;
    }

    if (confirmAction) {
      const confirmed = window.confirm(
        `Run ${actions.length} eligible automatic action${actions.length === 1 ? "" : "s"} now?`,
      );

      if (!confirmed) {
        return;
      }
    }

    for (const action of actions) {
      await applyAutomationAction(action.kind, source, false);
    }

    if (tournament) {
      await supabase
        .from("tournaments")
        .update({
          last_automation_run_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", tournament.id);
    }
  }

  useEffect(() => {
    if (
      !automationPolicy ||
      !shouldRunAutomaticAutomation(automationPolicy) ||
      !canManageTournament ||
      !automaticAutomationSignature ||
      automaticAutomationSignature === lastAutomaticAutomationSignatureRef.current ||
      savingAction ||
      tournament?.timers_paused_at
    ) {
      return;
    }

    lastAutomaticAutomationSignatureRef.current = automaticAutomationSignature;
    void applyEligibleAutomationActions("page_poll", false);
    // The runner is intentionally keyed by automaticAutomationSignature and guarded by a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    automationPolicy,
    canManageTournament,
    automaticAutomationSignature,
    savingAction,
    tournament?.timers_paused_at,
  ]);

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
      const { error: rpcError } = await updateTournamentRegistrationSeed(supabase, {
        seedValue: manualSeed,
        targetRegistration: participant.registrationId,
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

  async function updateSelectedSeedingMethod(method: SeedingMethod) {
    setSelectedSeedingMethod(method);

    if (!tournament || !canManageTournament || hasGeneratedBracket) {
      return;
    }

    setError(null);

    try {
      const updatedAt = new Date().toISOString();
      const { error: updateError } = await supabase
        .from("tournaments")
        .update({
          draw_seeding_method: method,
          updated_at: updatedAt,
        })
        .eq("id", tournament.id);

      if (updateError) {
        throw updateError;
      }

      setTournament({
        ...tournament,
        draw_seeding_method: method,
        updated_at: updatedAt,
      });
    } catch (caughtError) {
      logError("Draw method update failed.", caughtError);
      setSelectedSeedingMethod(tournament.draw_seeding_method);
      setError(formatError(caughtError, "Unable to save draw method."));
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
      const bracketTimerStartedAt = new Date();
      const firstBracketRoundDeadline = new Date(
        bracketTimerStartedAt.getTime() +
          getRoundDurationForFormat(roundFormats[0] ?? tournament.pre_semifinal_match_format, "bracket", tournament) *
            60_000,
      ).toISOString();

      const { data: createdRounds, error: roundsError } = await supabase
        .from("tournament_rounds")
        .insert(
          roundFormats.map((format, index) => ({
            deadline_at: index === 0 ? firstBracketRoundDeadline : null,
            tournament_id: tournament.id,
            stage_id: stage.id,
            round_number: index + 1,
            name: getRoundName(selectedBracketSize, index + 1),
            match_format: format,
            timer_started_at: index === 0 ? bracketTimerStartedAt.toISOString() : null,
            timing_state: index === 0 ? "active" : "idle",
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
          ...getStatusTimingPatch(tournament, "active"),
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
              ...getStatusTimingPatch(tournament, "check_in"),
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

      const groupPairings = createdGroups.flatMap((group) => {
        const members = createdMembers.filter((member) => member.group_id === group.id);

        return createRoundRobinPairings(members).map((pairing, index) => ({
          group,
          pairing,
          position: index + 1,
        }));
      });
      const maxGroupRoundNumber = groupPairings.reduce(
        (maxRound, item) => Math.max(maxRound, item.pairing.roundNumber),
        0,
      );
      const groupTimerStartedAt = new Date();
      const groupRoundDeadline = new Date(
        groupTimerStartedAt.getTime() +
          getRoundDurationForFormat(tournament.group_stage_format ?? "bo1", "group", tournament) *
            60_000,
      ).toISOString();
      const { data: createdRounds, error: roundError } =
        maxGroupRoundNumber > 0
          ? await supabase
              .from("tournament_rounds")
              .insert(
                Array.from({ length: maxGroupRoundNumber }, (_, index) => ({
                  deadline_at: index === 0 ? groupRoundDeadline : null,
                  tournament_id: tournament.id,
                  stage_id: stage.id,
                  round_number: index + 1,
                  name: `Group Round ${index + 1}`,
                  match_format: tournament.group_stage_format!,
                  timer_started_at: index === 0 ? groupTimerStartedAt.toISOString() : null,
                  timing_state: index === 0 ? "active" : "idle",
                })),
              )
              .select()
          : { data: [], error: null };

      if (roundError) {
        throw roundError;
      }

      const groupRoundByNumber = new Map(
        (createdRounds ?? []).map((round) => [round.round_number, round]),
      );
      let matchNumber = 1;
      const matchInserts = groupPairings.map(({ group, pairing, position }) => ({
          tournament_id: tournament.id,
          stage_id: stage.id,
          round_id: groupRoundByNumber.get(pairing.roundNumber)?.id ?? null,
          group_id: group.id,
          round_number: pairing.roundNumber,
          match_number: matchNumber++,
          bracket_position: position,
          player_one_id: pairing.playerOne.user_id!,
          player_two_id: pairing.playerTwo.user_id!,
          player_one_seed: pairing.playerOne.seed,
          player_two_seed: pairing.playerTwo.seed,
          player_one_slot: pairing.playerOne.draw_position,
          player_two_slot: pairing.playerTwo.draw_position,
          format: tournament.group_stage_format!,
          status: pairing.roundNumber === 1 ? "assigned" as const : "pending" as const,
          result_type: "played" as const,
        }));

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
          const playoffTimerStartedAt = new Date();
          const firstPlayoffRoundDeadline = new Date(
            playoffTimerStartedAt.getTime() +
              getRoundDurationForFormat(
                playoffRoundFormats[0] ?? tournament.pre_semifinal_match_format,
                "bracket",
                tournament,
              ) *
                60_000,
          ).toISOString();

          const { data: createdPlayoffRounds, error: playoffRoundsError } = await supabase
            .from("tournament_rounds")
            .insert(
              playoffRoundFormats.map((format, index) => ({
                deadline_at: index === 0 ? firstPlayoffRoundDeadline : null,
                tournament_id: tournament.id,
                stage_id: playoffStage.id,
                round_number: index + 1,
                name: getRoundName(playoffBracketSize, index + 1),
                match_format: format,
                timer_started_at: index === 0 ? playoffTimerStartedAt.toISOString() : null,
                timing_state: index === 0 ? "active" : "idle",
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
          ...createDeadlinePatch(
            tournament,
            noMatchPlayoffGenerated ? "bracket_round" : "group_round",
            noMatchPlayoffGenerated
              ? getRoundDurationForFormat(tournament.pre_semifinal_match_format, "bracket", tournament)
              : getRoundDurationForFormat(tournament.group_stage_format ?? "bo1", "group", tournament),
          ),
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

  generateBracketActionRef.current = generateBracket;
  generateGroupDrawActionRef.current = generateGroupDraw;

  async function resetGroupDraw() {
    if (!tournament || !canManageTournament || !groupStage) {
      return;
    }

    if (hasPlayoffBracket) {
      setError("Reset the group draw before generating playoffs.");
      return;
    }

    if (groupStageMatches.some((match) => !["assigned", "pending"].includes(match.status))) {
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

  async function shareTournament() {
    if (!tournament) {
      return;
    }

    const shareUrl = buildTournamentShareUrl(tournament.id);
    setShareFallbackUrl(shareUrl);
    setShareStatus("idle");

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        setShareStatus("copied");
        return;
      }

      if (copyTextFallback(shareUrl)) {
        setShareStatus("copied");
        return;
      }

      setShareStatus("failed");
    } catch {
      setShareStatus(copyTextFallback(shareUrl) ? "copied" : "failed");
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
    (activeTab === "admin" || activeTab === "live") && !canManageTournament
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
  const matchBucketSections: {
    emptyMessage: string;
    key: MatchAttentionBucketKey;
    title: string;
  }[] = [
    { key: "needsReview", title: "Disputed / Needs Review", emptyMessage: "No disputes or mismatches need review." },
    { key: "hostSetup", title: "Waiting For Host Setup", emptyMessage: "No matches are waiting on host setup." },
    { key: "inGame", title: "In Game / Reported", emptyMessage: "No matches are currently in game or waiting on report confirmation." },
    { key: "resultNeeded", title: "Result Needed", emptyMessage: "No assigned matches are waiting for results." },
    { key: "completed", title: "Completed", emptyMessage: "No completed matches yet." },
    { key: "nonPlayable", title: "BYE / No-Match", emptyMessage: "No BYE or no-match rows." },
  ];

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
        <section className="card" id="registration">
          <div className="section-heading">
            <div>
              <h2>Next Action</h2>
              {!user ? (
                <p className="muted">Sign in to register, check in, or open assigned match rooms.</p>
              ) : currentUserMatch ? (
                <p className="notice">You have an active match room.</p>
              ) : canCheckIn ? (
                <p className="notice">Tournament check-in is open for you.</p>
              ) : canClaimReplacement ? (
                <p className="notice">Replacement spots are open for this tournament.</p>
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
              ) : canClaimReplacement ? (
                <button
                  className="button"
                  disabled={savingAction === "replacement-claim"}
                  type="button"
                  onClick={claimReplacementSpot}
                >
                  {savingAction === "replacement-claim" ? "Claiming..." : "Claim Replacement Spot"}
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
              <TournamentShareButton
                isCopied={shareStatus === "copied"}
                onShare={() => {
                  void shareTournament();
                }}
              />
            </div>
          </div>
          <TournamentShareFeedback fallbackUrl={shareFallbackUrl} status={shareStatus} />
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

          {timingState && timingSettings ? (
            <div className="card">
              <h2>Timing</h2>
              <p className={timingState.isExpired ? "error" : timingState.isPaused ? "notice" : undefined}>
                {timingState.label}
              </p>
              <p className="countdown-line">
                <TimingDeadline deadline={timingState.deadline} now={clockNow} paused={timingState.isPaused} />
              </p>
              <p className="muted">{timingState.nextAction}</p>
              <p className="muted">
                Check-in {timingSettings.checkInWindowMinutes}m
                {timingSettings.replacementWindowEnabled
                  ? `, replacement ${timingSettings.replacementWindowMinutes}m`
                  : ", replacements off"}
              </p>
            </div>
          ) : null}
        </section>

        {tournament.description ? (
          <section className="card">
            <h2>Description</h2>
            <p>{tournament.description}</p>
          </section>
        ) : null}
      </TournamentPanel>

      {canManageTournament && liveSummary && liveRegistrationSummary && liveNextAction ? (
        <TournamentPanel active={selectedTab === "live"} id="live">
          <section className="card live-control-priority">
            <div className="section-heading compact-heading">
              <div>
                <h2>Next Recommended Action</h2>
                <p className={liveNextAction.tone === "attention" || liveNextAction.tone === "blocked" ? "error" : "notice"}>
                  {liveNextAction.label}
                </p>
                <p className="muted">{liveNextAction.detail}</p>
              </div>
              {liveNextAction.target ? (
                <button
                  className="button secondary-button"
                  type="button"
                  onClick={() => setActiveTab(liveNextAction.target!)}
                >
                  Open {liveNextAction.target === "admin" ? "Organizer/Admin" : liveNextAction.target}
                </button>
              ) : null}
            </div>
          </section>

          <section className="card">
            <div className="section-heading compact-heading">
              <div>
                <h2>Tournament Status Summary</h2>
                <p className="muted">Operational counters for the current live state.</p>
              </div>
              {liveDisputeSummary.openDisputeCount > 0 || liveDisputeSummary.resultMismatchCount > 0 ? (
                <MatchStatusBadge tone="danger">Needs Attention</MatchStatusBadge>
              ) : (
                <MatchStatusBadge tone="gold">No Review Blockers</MatchStatusBadge>
              )}
            </div>
            <div className="live-metric-grid">
              <LiveMetricCard label="Status" value={tournamentStatusLabels[tournament.status]} />
              <LiveMetricCard label="Format" value={tournamentFormatLabels[tournament.tournament_format]} />
              <LiveMetricCard label="Tier" value={tournamentTierLabels[tournament.tournament_tier]} />
              <LiveMetricCard label="Registered" value={liveSummary.registrationCount} />
              <LiveMetricCard label="Checked In" value={liveSummary.checkedInCount} />
              <LiveMetricCard
                label={isGroupStageTournament ? "Group Capacity" : "Capacity"}
                value={liveSummary.totalCapacity ? `${liveSummary.registrationCount}/${liveSummary.totalCapacity}` : liveSummary.registrationCount}
              />
              <LiveMetricCard label="Manual Seeds" value={liveSummary.manualSeedCount} />
              <LiveMetricCard label="Group Draw" value={liveSummary.groupDrawStatus} />
              <LiveMetricCard label="Bracket / Playoff" value={liveSummary.bracketPlayoffStatus} />
              <LiveMetricCard label="Active Matches" value={liveSummary.activeMatchCount} />
              <LiveMetricCard label="Completed Matches" value={liveSummary.completedMatchCount} />
              <LiveMetricCard label="Disputes" value={liveSummary.disputeCount} />
              <LiveMetricCard label="Mismatches" value={liveSummary.resultMismatchCount} />
              {timingState ? (
                <LiveMetricCard
                  label="Timer"
                  value={
                    timingState.isPaused
                      ? "Paused"
                      : timingState.isExpired
                        ? "Expired"
                        : timingState.activeWindow
                          ? getTimingWindowLabel(timingState.activeWindow)
                          : "Idle"
                  }
                />
              ) : null}
              {automationPolicy ? (
                <LiveMetricCard
                  label="Automation"
                  value={automationModeLabels[automationPolicy.automationMode]}
                />
              ) : null}
            </div>
          </section>

          {automationPolicy ? (
            <section className="card">
              <div className="section-heading compact-heading">
                <div>
                  <h2>Automation Policy</h2>
                  <p
                    className={
                      automationPolicy.automationMode === "automatic"
                        ? "error"
                        : automationPolicy.automationPausedAt
                          ? "notice"
                          : "muted"
                    }
                  >
                    {automationPolicy.automationPausedAt
                      ? "Automation is paused."
                      : automationPolicy.automationMode === "automatic"
                        ? "Automatic mode is enabled for selected actions."
                        : "Manual mode is showing recommendations only."}
                  </p>
                </div>
                <MatchStatusBadge
                  tone={
                    automationPolicy.automationMode === "automatic"
                      ? "danger"
                      : automationPolicy.automationPausedAt
                        ? "gold"
                        : "muted"
                  }
                >
                  {automationModeLabels[automationPolicy.automationMode]}
                </MatchStatusBadge>
              </div>

              {automationWarnings.length > 0 ? (
                <div className="stack">
                  {automationWarnings.map((warning) => (
                    <p className="error" key={warning}>
                      {warning}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="live-chip-list" aria-label="Enabled automation toggles">
                {enabledAutomationToggleLabels.length > 0 ? (
                  enabledAutomationToggleLabels.map((label) => (
                    <span className="badge" key={label}>
                      {label}
                    </span>
                  ))
                ) : (
                  <span className="badge status-badge-muted">No automatic toggles enabled</span>
                )}
              </div>

              <dl className="meta-grid">
                <div>
                  <dt>One checked in</dt>
                  <dd>{oneCheckedInTimeoutPolicyLabels[automationPolicy.oneCheckedInTimeoutPolicy]}</dd>
                </div>
                <div>
                  <dt>Neither checked in: groups</dt>
                  <dd>{neitherCheckedInTimeoutPolicyLabels[automationPolicy.neitherCheckedInGroupPolicy]}</dd>
                </div>
                <div>
                  <dt>Neither checked in: bracket</dt>
                  <dd>{neitherCheckedInTimeoutPolicyLabels[automationPolicy.neitherCheckedInBracketPolicy]}</dd>
                </div>
                <div>
                  <dt>Automatic eligible now</dt>
                  <dd>{runnableAutomaticActions.length}</dd>
                </div>
              </dl>

              {eligibleAutomaticActions.length > 0 ? (
                <div className="stack">
                  <h3>Automatic Policy Actions</h3>
                  {eligibleAutomaticActions.map((action) => (
                    <p
                      className={
                        action.enabled && automationPolicy.automationMode === "automatic"
                          ? "notice"
                          : "muted"
                      }
                      key={action.kind}
                    >
                      <strong>{action.label}:</strong>{" "}
                      {action.enabled
                        ? automationPolicy.automationMode === "automatic"
                          ? action.detail
                          : `${action.detail} Manual mode requires staff to use the individual Live Control button.`
                        : `${action.detail} Automatic toggle is off.`}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="muted">No automatic action is pending.</p>
              )}

              <div className="management-actions">
                <div>
                  <h3>Automation Controls</h3>
                  <p className="muted">
                    Run applies only in Automatic mode and only for currently eligible actions enabled by this policy.
                  </p>
                </div>
                <div className="role-actions">
                  <button
                    className="button"
                    disabled={
                      savingAction === "automation" ||
                      runnableAutomaticActions.length === 0 ||
                      Boolean(tournament.timers_paused_at) ||
                      Boolean(automationPolicy.automationPausedAt)
                    }
                    type="button"
                    onClick={() => applyEligibleAutomationActions("live_control", true)}
                  >
                    {savingAction === "automation" ? "Running..." : "Run Automation Now"}
                  </button>
                  <button
                    className="button secondary-button"
                    disabled={savingAction === "automation" || Boolean(automationPolicy.automationPausedAt)}
                    type="button"
                    onClick={pauseAutomation}
                  >
                    Pause Automation
                  </button>
                  <button
                    className="button"
                    disabled={savingAction === "automation" || !automationPolicy.automationPausedAt}
                    type="button"
                    onClick={resumeAutomation}
                  >
                    Resume Automation
                  </button>
                  <button
                    className="button danger-button"
                    disabled={savingAction === "automation" || automationPolicy.automationMode === "manual"}
                    type="button"
                    onClick={switchAutomationToManual}
                  >
                    Switch To Manual
                  </button>
                </div>
              </div>

              <div className="stack">
                <h3>Recent Automation Events</h3>
                {automationEvents.length > 0 ? (
                  automationEvents.slice(0, 5).map((event) => (
                    <p className="muted" key={event.id}>
                      <strong>{formatAutomationEvent(event)}:</strong>{" "}
                      {formatDateTime(event.created_at)}
                    </p>
                  ))
                ) : (
                  <p className="muted">No automation events logged yet.</p>
                )}
              </div>
            </section>
          ) : null}

          {timingState && timingSettings ? (
            <section className="card">
              <div className="section-heading compact-heading">
                <div>
                  <h2>Timing Control</h2>
                  <p className={timingState.isExpired ? "error" : timingState.isPaused ? "notice" : "muted"}>
                    {timingState.nextAction}
                  </p>
                </div>
                <MatchStatusBadge tone={timingState.isExpired ? "danger" : timingState.isPaused ? "gold" : "muted"}>
                  {timingState.isPaused ? "Paused" : timingState.isExpired ? "Action Needed" : "Running"}
                </MatchStatusBadge>
              </div>

              <div className="live-metric-grid">
                <LiveMetricCard label="Current Window" value={timingState.label} />
                <LiveMetricCard
                  label="Deadline"
                  value={<TimingDeadline deadline={timingState.deadline} now={clockNow} paused={timingState.isPaused} />}
                />
                <LiveMetricCard label="Check-In" value={`${timingSettings.checkInWindowMinutes}m`} />
                <LiveMetricCard
                  label="Replacement"
                  value={
                    timingSettings.replacementWindowEnabled
                      ? `${timingSettings.replacementWindowMinutes}m`
                      : "Off"
                  }
                />
                {isGroupStageTournament ? (
                  <>
                    <LiveMetricCard label="Group BO1" value={`${timingSettings.groupBo1RoundMinutes}m`} />
                    <LiveMetricCard label="Group BO3" value={`${timingSettings.groupBo3RoundMinutes}m`} />
                  </>
                ) : null}
                <LiveMetricCard label="Bracket BO1" value={`${timingSettings.bracketBo1RoundMinutes}m`} />
                <LiveMetricCard label="Bracket BO3" value={`${timingSettings.bracketBo3RoundMinutes}m`} />
                <LiveMetricCard label="Bracket BO5" value={`${timingSettings.bracketBo5RoundMinutes}m`} />
              </div>

              <div className="management-actions">
                <div>
                  <h3>Expired Actions</h3>
                  <p className="muted">
                    {tournament.timers_paused_at
                      ? "Timers are paused. Resume before applying expired timing actions."
                      : expiredTimingActions.length > 0
                        ? "Review the summary before applying any expired timing action."
                        : "No expired timing action is currently available."}
                  </p>
                  {checkInExpirySummary ? <p className="muted">{checkInExpirySummary.summary}</p> : null}
                  {replacementWindowSummary ? <p className="muted">{replacementWindowSummary.summary}</p> : null}
                  {liveRoundExpirySummary?.expired ? (
                    <p className="muted">
                      {liveRoundExpirySummary.phase === "group" ? "Group" : "Bracket"} round expired:{" "}
                      {liveRoundExpirySummary.unresolvedCount} unresolved,{" "}
                      {liveRoundExpirySummary.forfeitCount} FF,{" "}
                      {liveRoundExpirySummary.noContestCount} no contest,{" "}
                      {liveRoundExpirySummary.needsReviewCount} review.
                    </p>
                  ) : null}
                </div>
                {expiredTimingActions.length > 0 ? (
                  <div className="role-actions">
                    {expiredTimingActions.map((action) => (
                      <button
                        className={action.enabled ? "button" : "button secondary-button"}
                        disabled={!action.enabled || savingAction === "timer-expiry" || savingAction === "generate" || savingAction === "generate-groups"}
                        key={action.kind}
                        title={action.blocker ?? action.detail}
                        type="button"
                        onClick={() => applyExpiredTimingAction(action.kind)}
                      >
                        {savingAction === "timer-expiry" ? "Applying..." : action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {expiredTimingActions.length > 0 ? (
                <div className="stack">
                  {expiredTimingActions.map((action) => (
                    <p className={action.blocker ? "error" : "muted"} key={`${action.kind}-detail`}>
                      <strong>{action.label}:</strong> {action.blocker ?? action.detail}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="management-actions">
                <div>
                  <h3>Round Timing Map</h3>
                  <p className="muted">
                    Group matches can open ahead by group. Group round timers start only when every group reaches that round.
                  </p>
                </div>
                <div className="role-actions">
                  <button
                    className="button secondary-button"
                    disabled={!canManageTournament || savingAction === "open-ready"}
                    type="button"
                    onClick={() => openReadyMatchesAndTimers()}
                  >
                    {savingAction === "open-ready" ? "Syncing..." : "Open Ready Matches"}
                  </button>
                </div>
              </div>

              {isGroupStageTournament && liveGroupTimingMatrix && liveGroupTimingMatrix.roundNumbers.length > 0 ? (
                <div className="timing-map" aria-label="Group round timing map">
                  <div
                    className="timing-grid"
                    style={{ "--timing-round-columns": liveGroupTimingMatrix.roundNumbers.length } as CSSProperties}
                  >
                    <div className="timing-heading">Group</div>
                    {liveGroupTimingMatrix.roundNumbers.map((roundNumber) => (
                      <div className="timing-heading" key={`round-${roundNumber}`}>
                        R{roundNumber}
                      </div>
                    ))}
                    {liveGroupTimingMatrix.groups.map((group) => (
                      <Fragment key={group.id}>
                        <div className="timing-group-name">{group.name}</div>
                        {liveGroupTimingMatrix.roundNumbers.map((roundNumber) => {
                          const cell = liveGroupTimingMatrix.cells.find(
                            (item) => item.groupId === group.id && item.roundNumber === roundNumber,
                          );

                          return (
                            <div
                              className={getTimingCellClassName(cell?.state ?? "empty")}
                              key={`${group.id}-${roundNumber}`}
                              title={cell?.detail}
                            >
                              <strong>{formatTimingCellState(cell?.state ?? "empty")}</strong>
                              <span>{cell ? `${cell.resolvedCount}/${cell.matchCount}` : "0/0"}</span>
                              {cell?.deadline ? <span>{getCountdownLabel(cell.deadline, Boolean(tournament.timers_paused_at), clockNow)}</span> : null}
                            </div>
                          );
                        })}
                      </Fragment>
                    ))}
                  </div>
                  <div className="timing-wave-list">
                    {liveGroupTimingMatrix.waves.map((wave) => (
                      <p className={wave.expired ? "error" : "muted"} key={wave.roundNumber}>
                        <strong>Round {wave.roundNumber} timer:</strong>{" "}
                        {wave.complete
                          ? "Complete"
                          : wave.started
                            ? wave.deadline
                              ? getCountdownLabel(wave.deadline, Boolean(tournament.timers_paused_at), clockNow)
                              : "Active"
                            : wave.waitingOnGroups.length > 0
                              ? `Not started, waiting for ${wave.waitingOnGroups.join(", ")}`
                              : "Ready to start when matches open"}
                        {wave.blockedGroups.length > 0 ? `; review needed in ${wave.blockedGroups.join(", ")}` : ""}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}

              {liveBracketTimingRows.length > 0 ? (
                <div className="timing-wave-list">
                  {liveBracketTimingRows.map((row) => (
                    <p className={row.state === "expired" || row.state === "blocked" ? "error" : "muted"} key={row.roundNumber}>
                      <strong>{row.roundName}:</strong> {formatTimingCellState(row.state)} · {row.detail}
                      {row.deadline ? ` · ${getCountdownLabel(row.deadline, Boolean(tournament.timers_paused_at), clockNow)}` : ""}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="management-actions">
                <div>
                  <h3>Pause / Resume</h3>
                  <p className="muted">
                    Pausing stops displayed expiry and resume shifts stored deadlines by the paused duration.
                  </p>
                  {tournament.timing_note ? <p className="muted">Last note: {tournament.timing_note}</p> : null}
                </div>
                <div className="role-actions">
                  <button
                    className="button secondary-button"
                    disabled={!canControlTiming || savingAction === "timing" || Boolean(tournament.timers_paused_at)}
                    type="button"
                    onClick={pauseTimers}
                  >
                    Pause Timers
                  </button>
                  <button
                    className="button"
                    disabled={!canControlTiming || savingAction === "timing" || !tournament.timers_paused_at}
                    type="button"
                    onClick={resumeTimers}
                  >
                    Resume Timers
                  </button>
                </div>
              </div>

              {timingState.activeWindow ? (
                <div className="management-actions">
                  <div>
                    <h3>{getTimingWindowLabel(timingState.activeWindow)} Controls</h3>
                    <p className="muted">
                      Extensions update the current deadline only. Force close marks the timer expired without resolving matches or advancing players.
                    </p>
                  </div>
                  <div className="role-actions">
                    {[5, 10, 15].map((minutes) => (
                      <button
                        className="button secondary-button"
                        disabled={!canExtendTiming || savingAction === "timing"}
                        key={minutes}
                        type="button"
                        onClick={() => extendTimingWindow(timingState.activeWindow!, minutes)}
                      >
                        +{minutes}m
                      </button>
                    ))}
                    <button
                      className="button danger-button"
                      disabled={!canExtendTiming || savingAction === "timing"}
                      type="button"
                      onClick={() => forceCloseTimingWindow(timingState.activeWindow!)}
                    >
                      Force Close
                    </button>
                  </div>
                </div>
              ) : null}

              <p className="muted">
                Match timeout automation is {automationPolicy?.autoApplyMatchTimeoutOutcomes ? "enabled" : "off"}.
                {automationPolicy?.automationMode === "automatic"
                  ? " Automatic mode may apply enabled timeout outcomes when eligible."
                  : " Manual mode still requires organizer/admin confirmation."}
              </p>
            </section>
          ) : null}

          <section className="grid live-control-grid">
            <div className="card">
              <div className="section-heading compact-heading">
                <div>
                  <h2>Registration and Check-In</h2>
                  <p className="muted">
                    {liveRegistrationSummary.checkedInCount}/{liveRegistrationSummary.registeredCount} players checked in.
                  </p>
                </div>
                <button className="button secondary-button" type="button" onClick={() => setActiveTab("players")}>
                  Players
                </button>
              </div>
              <dl className="meta-grid">
                <div>
                  <dt>Not Checked In</dt>
                  <dd>{liveRegistrationSummary.notCheckedInParticipants.length}</dd>
                </div>
                <div>
                  <dt>Manual Seeds</dt>
                  <dd>{liveManualSeedSummary.count}</dd>
                </div>
                <div>
                  <dt>Seed Warnings</dt>
                  <dd>
                    {liveManualSeedSummary.duplicateSeeds.length > 0
                      ? `Duplicate seeds: ${liveManualSeedSummary.duplicateSeeds.join(", ")}`
                      : "None"}
                  </dd>
                </div>
              </dl>
              {isGroupStageTournament ? (
                <p className="muted">
                  {liveGroupDrawReadiness?.detail ?? "Group readiness unavailable."}
                </p>
              ) : (
                <p className="muted">
                  {liveBracketReadiness?.detail ?? "Bracket readiness unavailable."}
                </p>
              )}
              {liveRegistrationSummary.notCheckedInParticipants.length > 0 ? (
                <div className="live-chip-list" aria-label="Not checked-in players">
                  {liveRegistrationSummary.notCheckedInParticipants.slice(0, 12).map((participant) => (
                    <span className="badge status-badge-muted" key={participant.userId}>
                      {participant.displayName}
                    </span>
                  ))}
                  {liveRegistrationSummary.notCheckedInParticipants.length > 12 ? (
                    <span className="badge">+{liveRegistrationSummary.notCheckedInParticipants.length - 12} more</span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="card">
              <div className="section-heading compact-heading">
                <div>
                  <h2>{isGroupStageTournament ? "Draw / Playoff" : "Bracket"}</h2>
                  <p className="muted">
                    {isGroupStageTournament
                      ? liveGroupDrawReadiness?.detail
                      : liveBracketReadiness?.detail}
                  </p>
                </div>
              </div>
              {isGroupStageTournament ? (
                <>
                  <dl className="meta-grid">
                    <div>
                      <dt>Groups</dt>
                      <dd>{tournament.groups_count} × {tournament.group_size}</dd>
                    </div>
                    <div>
                      <dt>Qualifiers</dt>
                      <dd>{tournament.qualifiers_per_group} per group</dd>
                    </div>
                    <div>
                      <dt>Playoff Size</dt>
                      <dd>{livePlayoffReadiness?.bracketSize ?? "Pending"}</dd>
                    </div>
                    <div>
                      <dt>Playoff BYEs</dt>
                      <dd>{livePlayoffReadiness?.byeCount ?? 0}</dd>
                    </div>
                  </dl>
                  <p className={livePlayoffReadiness?.blocker ? "error" : "muted"}>
                    {hasPlayoffBracket
                      ? "Playoff bracket has been generated."
                      : formatLiveControlBlockerReason(livePlayoffReadiness?.blocker)}
                  </p>
                  <div className="role-actions">
                    <button
                      className="button"
                      disabled={
                        savingAction === "generate-groups" ||
                        hasGroupDraw ||
                        tournament.status !== "check_in" ||
                        !liveGroupDrawReadiness?.allowed
                      }
                      type="button"
                      onClick={startTournament}
                    >
                      {savingAction === "generate-groups" ? "Starting..." : "Generate Group Draw"}
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
                </>
              ) : (
                <>
                  <p className={liveBracketReadiness?.blocker && !liveBracketReadiness.allowed ? "error" : "muted"}>
                    {liveBracketReadiness?.blocker ?? "Ready to generate from checked-in players."}
                  </p>
                  {liveManualSeedSummary.count > 0 ? (
                    <p className="muted">Manual seeds are assigned and will be placed before unseeded players.</p>
                  ) : null}
                  <div className="role-actions">
                    <button
                      className="button"
                      disabled={
                        savingAction === "generate" ||
                        hasGeneratedBracket ||
                        tournament.status !== "check_in" ||
                        !liveBracketReadiness?.allowed
                      }
                      type="button"
                      onClick={startTournament}
                    >
                      {savingAction === "generate" ? "Starting..." : "Generate Bracket"}
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
                </>
              )}
            </div>
          </section>

          <section className="card">
            <div className="section-heading compact-heading">
              <div>
                <h2>Match Attention</h2>
                <p className="muted">
                  {urgentLiveAttentionItems.length} match{urgentLiveAttentionItems.length === 1 ? "" : "es"} currently need operational attention.
                </p>
              </div>
            </div>
            {matchBucketSections.map((section) => (
              <details
                className="live-bucket"
                key={section.key}
                open={section.key === "needsReview" || section.key === "resultNeeded"}
              >
                <summary>
                  <span>{section.title}</span>
                  <span className="badge">{liveMatchAttentionBuckets[section.key].length}</span>
                </summary>
                <LiveAttentionRows
                  emptyMessage={section.emptyMessage}
                  items={liveMatchAttentionBuckets[section.key]}
                />
              </details>
            ))}
            {liveRoundExpirySummary?.expired && liveRoundExpirySummary.candidates.length > 0 ? (
              <div className="stack">
                <h3>Expired Round Outcome Candidates</h3>
                {liveRoundExpirySummary.candidates.slice(0, 8).map((candidate) => {
                  const match = matches.find((item) => item.id === candidate.matchId);
                  const players = match
                    ? `${getProfileName(profileMap, match.player_one_id) ?? "TBD"} vs ${getProfileName(profileMap, match.player_two_id) ?? "TBD"}`
                    : "Match";

                  return (
                    <p className="muted" key={candidate.matchId}>
                      <strong>{players}:</strong> {formatTimerOutcomeSummary(candidate)}. {candidate.detail}
                    </p>
                  );
                })}
                {liveRoundExpirySummary.candidates.length > 8 ? (
                  <p className="muted">+{liveRoundExpirySummary.candidates.length - 8} more overdue match candidates.</p>
                ) : null}
              </div>
            ) : null}
          </section>

          {isGroupStageTournament ? (
            <section className="card">
              <div className="section-heading compact-heading">
                <div>
                  <h2>Group Stage Progress</h2>
                  <p className={playoffBlockedReason ? "muted" : "notice"}>
                    {playoffBlockedReason ?? "Ready for playoff generation."}
                  </p>
                </div>
                <button className="button secondary-button" type="button" onClick={() => setActiveTab("groups")}>
                  Groups
                </button>
              </div>
              <div className="live-group-progress-grid">
                {liveGroupStageProgress.length === 0 ? (
                  <p className="muted">Group draw has not been generated yet.</p>
                ) : (
                  liveGroupStageProgress.map((group) => (
                    <article className="live-group-progress-card" key={group.id}>
                      <div className="section-heading compact-heading">
                        <h3>{group.name}</h3>
                        <MatchStatusBadge tone={group.completedMatches === group.totalRealMatches ? "gold" : "muted"}>
                          {group.completedMatches}/{group.totalRealMatches}
                        </MatchStatusBadge>
                      </div>
                      <p className="muted">
                        {group.unresolvedTieCount > 0
                          ? `${group.unresolvedTieCount} unresolved tiebreaker flag${group.unresolvedTieCount === 1 ? "" : "s"}.`
                          : "No unresolved tiebreaker flags."}
                      </p>
                      <p className="muted">
                        FF {group.forfeitCount}
                      </p>
                      <p className="muted">
                        Qualified: {group.qualifiedPlayers.length > 0 ? group.qualifiedPlayers.join(", ") : "Pending"}
                      </p>
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : null}

          <section className="card">
            <div className="section-heading compact-heading">
              <div>
                <h2>Disputes and Mismatches</h2>
                <p className={liveDisputeSummary.openDisputeCount || liveDisputeSummary.resultMismatchCount ? "error" : "muted"}>
                  {liveDisputeSummary.openDisputeCount} open disputes · {liveDisputeSummary.resultMismatchCount} result mismatches · {liveDisputeSummary.evidenceCount} evidence uploads
                </p>
              </div>
            </div>
            {liveMatchAttentionBuckets.needsReview.length > 0 ? (
              <LiveAttentionRows
                emptyMessage="No matches need organizer review."
                items={liveMatchAttentionBuckets.needsReview}
              />
            ) : (
              <p className="muted">No open disputes or mismatched reports.</p>
            )}
          </section>

          {liveCompletionReadiness ? (
            <section className="card">
              <div className="section-heading compact-heading">
                <div>
                  <h2>Completion</h2>
                  <p className={liveCompletionReadiness.ready ? "notice" : "muted"}>
                    {liveCompletionReadiness.championName
                      ? `Champion known: ${liveCompletionReadiness.championName}.`
                      : "Champion pending."}
                  </p>
                </div>
                {roles.isAdmin && liveCompletionReadiness.ready ? (
                  <button
                    className="button"
                    disabled={savingAction === "status"}
                    type="button"
                    onClick={() =>
                      updateTournamentStatusTo(
                        "completed",
                        "Tournament marked complete.",
                        "status",
                      )
                    }
                  >
                    {savingAction === "status" ? "Completing..." : "Mark Complete"}
                  </button>
                ) : null}
              </div>
              {liveCompletionReadiness.blockers.length > 0 ? (
                <ul className="live-blocker-list">
                  {liveCompletionReadiness.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : tournament.status === "completed" ? (
                <p className="muted">Tournament is already marked completed.</p>
              ) : roles.isAdmin ? (
                <p className="muted">Final match is complete. Admin status completion is available.</p>
              ) : (
                <p className="muted">Final match is complete. Ask an admin to mark the tournament complete.</p>
              )}
            </section>
          ) : null}
        </TournamentPanel>
      ) : null}

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
            <TournamentShareButton
              isCopied={shareStatus === "copied"}
              onShare={() => {
                void shareTournament();
              }}
            />
          </div>
          <TournamentShareFeedback fallbackUrl={shareFallbackUrl} status={shareStatus} />
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
          ) : canClaimReplacement ? (
            <div className="stack">
              <p className="notice">{replacementWindowSummary?.summary}</p>
              <button
                className="button"
                disabled={savingAction === "replacement-claim"}
                type="button"
                onClick={claimReplacementSpot}
              >
                {savingAction === "replacement-claim" ? "Claiming..." : "Claim Replacement Spot"}
              </button>
            </div>
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
                        : formatRegistrationStatus(participant.registrationStatus)}
                    </p>
                    {participant.isReplacement ? (
                      <p className="muted">Replacement entry</p>
                    ) : null}
                    {participant.manualSeed ? (
                      <p className="muted">Manual tournament seed {participant.manualSeed}</p>
                    ) : null}
                  </div>
                  <div className="role-actions">
                    {participant.manualSeed ? (
                      <span className="badge status-badge-gold">Seed {participant.manualSeed}</span>
                    ) : null}
                    <span className="badge">
                      {participant.isReplacement
                        ? "Replacement"
                        : participant.checkIn
                          ? "Checked In"
                          : formatRegistrationStatus(participant.registrationStatus)}
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
        <section className="card">
          <h2>Generated Timing Rules</h2>
          <p className="pre-line">{generatedTimingRules}</p>
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
                  onChange={(event) => {
                    void updateSelectedSeedingMethod(event.target.value as SeedingMethod);
                  }}
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
                      onChange={(event) => {
                        void updateSelectedSeedingMethod(event.target.value as SeedingMethod);
                      }}
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
