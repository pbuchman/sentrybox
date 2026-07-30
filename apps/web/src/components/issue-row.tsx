import type { MouseEvent } from "react";
import type { IssueListItem } from "../api/client.js";
import { Icon } from "./icons.js";
import { TimeValue } from "./time-value.js";

interface IssueRowProps {
  readonly issue: IssueListItem;
  readonly variant: "table" | "card";
  readonly onNavigate: (path: string) => void;
}

export function IssueRow({ issue, variant, onNavigate }: IssueRowProps) {
  const path = `/?${new URLSearchParams({ issue: String(issue.id) }).toString()}`;
  const navigate = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onNavigate(path);
  };
  const severity = severityLabel(issue.highestLevel);

  if (variant === "card") {
    return (
      <article className="issue-card" aria-label={issue.title}>
        <a href={path} aria-label={issue.title} onClick={navigate}>
          <span className="issue-card-main">
            <Severity issue={issue} label={severity} />
            <span className="issue-copy">
              <Title issue={issue} />
              <span className="issue-secondary">
                {matchLabel(issue, severity)}
              </span>
            </span>
          </span>
          <span className="issue-card-meta">
            <span>{eventCount(issue)}</span>
            <TimeValue value={issue.lastSeen} compact />
          </span>
          <span className="issue-card-chevron" aria-hidden="true">
            <Icon name="chevron" size={18} />
          </span>
        </a>
      </article>
    );
  }

  return (
    <tr>
      <td className="severity-cell">
        <Severity issue={issue} label={severity} />
      </td>
      <td>
        <a
          className="issue-table-link"
          href={path}
          aria-label={issue.title}
          onClick={navigate}
        >
          <Title issue={issue} />
          <span className="issue-secondary">{matchLabel(issue, severity)}</span>
        </a>
      </td>
      <td className="count-cell">{eventCount(issue)}</td>
      <td className="time-cell">
        <TimeValue value={issue.lastSeen} compact />
      </td>
      <td className="row-action-cell" aria-hidden="true">
        <Icon name="chevron" size={18} />
      </td>
    </tr>
  );
}

function Severity({
  issue,
  label,
}: {
  readonly issue: IssueListItem;
  readonly label: string;
}) {
  return (
    <span
      className={`severity-icon severity-${issue.highestLevel}`}
      title={label}
    >
      <Icon name={issue.highestLevel === "warn" ? "warning" : "error"} />
    </span>
  );
}

function Title({ issue }: { readonly issue: IssueListItem }) {
  return (
    <span className="issue-title-line">
      <span className="issue-title">{issue.title}</span>
      {issue.status === "resolved" ? (
        <span className="status status-resolved">Resolved</span>
      ) : null}
    </span>
  );
}

function eventCount(issue: IssueListItem): string {
  const count = issue.matchingCount;
  return `${String(count)} ${count === 1 ? "event" : "events"}`;
}

function matchLabel(issue: IssueListItem, severity: string): string {
  if (issue.matchingCount === issue.occurrenceCount) return severity;
  return `${severity} · ${String(issue.matchingCount)} of ${String(issue.occurrenceCount)} events match`;
}

function severityLabel(level: IssueListItem["highestLevel"]): string {
  if (level === "warn") return "Warning";
  if (level === "fatal") return "Fatal";
  return "Error";
}
