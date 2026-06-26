import Link from "next/link";
import type { ReactNode } from "react";
import {
  formatDateTime,
  tournamentStatusLabels,
  type TournamentRow,
  type TournamentStatus,
} from "@/lib/tournaments";

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
};

type SectionCardProps = {
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
};

type StateProps = {
  title?: string;
  message: string;
};

type TournamentCardProps = {
  tournament: TournamentRow;
  registrationCount?: number;
  winnerName?: string | null;
  note?: string;
  compact?: boolean;
};

const statusTone: Partial<Record<TournamentStatus, string>> = {
  active: "status-badge-active",
  cancelled: "status-badge-danger",
  check_in: "status-badge-action",
  completed: "status-badge-gold",
  draft: "status-badge-muted",
  registration_closed: "status-badge-muted",
  registration_open: "status-badge-action",
};

export function PageHeader({ eyebrow, title, description, action }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  action,
  className,
  children,
}: SectionCardProps) {
  return (
    <section className={["card", className].filter(Boolean).join(" ")}>
      {title || description || action ? (
        <div className="section-heading compact-heading">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p className="muted">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { status: TournamentStatus }) {
  return (
    <span className={["badge", "status-badge", statusTone[status]].filter(Boolean).join(" ")}>
      {tournamentStatusLabels[status]}
    </span>
  );
}

export function MatchStatusBadge({ children, tone }: { children: ReactNode; tone?: "action" | "danger" | "gold" | "muted" }) {
  const toneClass = tone ? `status-badge-${tone}` : undefined;

  return (
    <span className={["badge", "status-badge", toneClass].filter(Boolean).join(" ")}>
      {children}
    </span>
  );
}

export function EmptyState({ title = "Nothing to show yet", message }: StateProps) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p className="muted">{message}</p>
    </div>
  );
}

export function LoadingState({ message }: { message: string }) {
  return <p className="muted loading-state">{message}</p>;
}

export function ErrorState({ message }: { message: string }) {
  return <p className="error error-state">{message}</p>;
}

export function TournamentCard({
  tournament,
  registrationCount = 0,
  winnerName,
  note,
  compact = false,
}: TournamentCardProps) {
  const capacity = tournament.max_players
    ? `${registrationCount}/${tournament.max_players}`
    : `${registrationCount}`;

  return (
    <Link
      className={["tournament-summary-card", compact ? "compact" : ""].filter(Boolean).join(" ")}
      href={`/tournaments/${tournament.id}`}
    >
      <div className="tournament-summary-main">
        <span className="time-label">{formatDateTime(tournament.starts_at)}</span>
        <strong>{tournament.name}</strong>
        {note ? <span className="muted">{note}</span> : null}
        {winnerName ? (
          <span className="winner-line">
            <span className="winner-medal" aria-hidden="true" />
            Winner: {winnerName}
          </span>
        ) : null}
      </div>
      <div className="tournament-summary-meta">
        <StatusBadge status={tournament.status} />
        <span className="muted">{capacity} players</span>
      </div>
    </Link>
  );
}
