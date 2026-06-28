export type HelpTopic = {
  slug: string;
  title: string;
  summary: string;
  sections: {
    title: string;
    items: string[];
  }[];
  related: string[];
};

export const helpTopics: HelpTopic[] = [
  {
    slug: "how-it-works",
    title: "How It Works",
    summary: "Follow the normal tournament flow from registration through records.",
    sections: [
      {
        title: "Tournament Flow",
        items: [
          "Organizers create free-entry community tournaments, then players register while registration is open.",
          "Registered players check in near the start time so staff knows who is present.",
          "If spots remain, staff may open a replacement window before the draw or bracket is generated.",
          "Single-elimination events generate a bracket. Group-stage events generate groups first, then playoffs after group play.",
          "Players open match rooms for host setup, match status, and result reporting.",
          "Disputes or report mismatches go to organizer/admin review with evidence when needed.",
          "Completed eligible matches update player records according to tournament tier and record rules.",
        ],
      },
    ],
    related: ["check-in", "matches", "records"],
  },
  {
    slug: "rules",
    title: "Platform Rules",
    summary: "General expectations for this unofficial Teamfight Manager 2 community hub.",
    sections: [
      {
        title: "Community Scope",
        items: [
          "Tournaments on this site are free-entry community events.",
          "TFM2 Tournament Realm is unofficial and is not operated by the Teamfight Manager 2 developers.",
          "The app does not support paid entry, app-managed money features, or paid organizer access.",
        ],
      },
      {
        title: "Fair Play",
        items: [
          "Players should follow the tournament page rules and organizer instructions.",
          "Use the assigned match room so both players have the same host, side, score, and status information.",
          "Organizers have final authority for event operations, disputes, no-contests, forfeits, and replay decisions.",
          "Evidence is used only when a report is disputed or staff review is needed.",
        ],
      },
    ],
    related: ["matches", "organizers", "records"],
  },
  {
    slug: "check-in",
    title: "Check-In",
    summary: "What players should do before the event starts.",
    sections: [
      {
        title: "Before Start Time",
        items: [
          "Watch the tournament start time and be signed in before check-in opens.",
          "Review the tournament rules, round format, and community link if one is provided.",
          "Keep the tournament page open near start time so you can react to check-in and match-room actions.",
        ],
      },
      {
        title: "Check-In and Replacements",
        items: [
          "During the check-in window, registered players must confirm attendance from the tournament page.",
          "Players who miss check-in may be left out of the generated field.",
          "If staff opens a replacement window, eligible replacement players can claim open spots before generation.",
          "Replacement players are unseeded, even when manual seeds are used for the original field.",
        ],
      },
    ],
    related: ["how-it-works", "timing", "organizers"],
  },
  {
    slug: "matches",
    title: "Matches",
    summary: "Match-room setup, sides, and result reporting.",
    sections: [
      {
        title: "Room Setup",
        items: [
          "Open your match room from the tournament page, dashboard action banner, or notification.",
          "Both players should check in inside the match room when required.",
          "The assigned host creates the Teamfight Manager 2 lobby and marks Match Created after setup.",
          "The current rule is host on Blue side and guest on Red side.",
          "Use the lobby name and instructions shown in the match room so both players join the same match.",
        ],
      },
      {
        title: "Reporting",
        items: [
          "After playing, report the winner and final series score in the match room.",
          "BO1 expects 1-0. BO3 expects 2-0 or 2-1. BO5 expects 3-0, 3-1, or 3-2.",
          "If both players submit matching reports, the result finalizes and the winner advances where applicable.",
          "If reports do not match, players can correct the report or confirm the mismatch for organizer/admin review.",
        ],
      },
    ],
    related: ["rules", "timing", "records"],
  },
  {
    slug: "groups",
    title: "Group Stage",
    summary: "How group-stage playoff tournaments progress.",
    sections: [
      {
        title: "Groups and Rounds",
        items: [
          "Group-stage tournaments use groups of 4 or 8 players, then send top qualifiers into playoffs.",
          "Group matches are organized into group round waves.",
          "Only current group-round matches should be played; future group matches may stay pending until their wave opens.",
          "Standings use match wins, head-to-head where available, game differential, and games won.",
        ],
      },
      {
        title: "Special Outcomes",
        items: [
          "Forfeits can affect group standings but do not count toward public player records.",
          "No-contest results do not count as played public record matches.",
          "Group BYE/off-slots are empty schedule slots. They do not count as wins, losses, games, or public match history.",
          "Unresolved qualifier ties require organizer/admin action before playoffs can be generated.",
        ],
      },
    ],
    related: ["matches", "timing", "records"],
  },
  {
    slug: "timing",
    title: "Timing and Automation",
    summary: "Timers, pauses, extensions, and automation modes.",
    sections: [
      {
        title: "Player Timers",
        items: [
          "Countdown bars show active timing windows, such as check-in, replacement, group round, and bracket round timers.",
          "Paused timers are clearly shown and should not be treated as active countdowns.",
          "If a timer looks wrong, follow organizer instructions and refresh the page before taking action.",
        ],
      },
      {
        title: "Organizer Timers",
        items: [
          "Organizer Live Control shows operational timers and allows staff to pause, resume, or extend timing windows.",
          "Manual automation mode shows recommendations, but staff must confirm actions.",
          "Automatic automation mode can run eligible enabled actions from staff page activity.",
          "Organizers can emergency-switch back to Manual mode when live handling is safer.",
        ],
      },
    ],
    related: ["check-in", "groups", "organizers"],
  },
  {
    slug: "records",
    title: "Player Records",
    summary: "What counts toward public player records.",
    sections: [
      {
        title: "Record Types",
        items: [
          "Official Record counts eligible completed matches from official and championship tournaments.",
          "Overall Record counts eligible completed matches from community, official, and championship tournaments.",
          "Test tournaments and stat-excluded tournaments do not count toward public records.",
          "Played group-stage matches and playoff matches use the same tournament-tier rules.",
        ],
      },
      {
        title: "Excluded Outcomes",
        items: [
          "Only played player-vs-player matches with finalized scores count.",
          "Forfeits, random advancement, no-contests, BYEs, TBD placeholders, unresolved disputes, and replay-required matches do not count.",
          "Game records use the finalized series score from the player's perspective.",
          "Admin corrections should fix the source match or tournament data rather than manually editing W-L totals.",
        ],
      },
    ],
    related: ["rules", "groups", "matches"],
  },
  {
    slug: "organizers",
    title: "Organizer Basics",
    summary: "A practical starting point for running free-entry events.",
    sections: [
      {
        title: "Setup",
        items: [
          "Create a tournament with clear rules, start time, registration close time, capacity, format, and timing settings.",
          "Use manual seeds only when you have a clear reason, and assign them before bracket or group generation.",
          "For a first public test, run a small 4-player single-elimination event and a small group-stage event with test accounts.",
        ],
      },
      {
        title: "Live Operations",
        items: [
          "Use Live Control to monitor check-in, replacement, group round, bracket round, and match-room timers.",
          "Run automation manually unless you have verified the event settings and timing windows.",
          "Resolve disputes from the organizer/admin review panels using reports, scores, and evidence.",
          "Use pause or extend when players need clear extra time during a live event.",
        ],
      },
    ],
    related: ["timing", "rules", "groups"],
  },
];

export const helpTopicMap = new Map(helpTopics.map((topic) => [topic.slug, topic]));

