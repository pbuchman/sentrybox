import type { MouseEvent } from "react";
import type { FacetValue, IssueListItem } from "../api/client.js";
import { TimeValue } from "./time-value.js";

interface IssueRowProps {
  readonly issue: IssueListItem;
  readonly facets: {
    readonly environment: readonly FacetValue[];
    readonly release: readonly FacetValue[];
    readonly service: readonly FacetValue[];
  } | null;
  readonly variant: "table" | "card";
  readonly onNavigate: (path: string) => void;
}

export function IssueRow({
  issue,
  facets,
  variant,
  onNavigate,
}: IssueRowProps) {
  const path = `/organizations/intexuraos/issues/${String(issue.id)}/`;
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
  const body = (
    <>
      <div className="issue-title-line">
        <a className="issue-title" href={path} onClick={navigate}>
          {issue.title}
        </a>
        <span className={`severity severity-${issue.highestLevel}`}>
          {severityLabel(issue.highestLevel)}
        </span>
      </div>
      <p className="issue-project">{issue.project.name}</p>
      {facets === null ? (
        <p className="issue-facets">Facet evidence unavailable</p>
      ) : (
        <p className="issue-facets" aria-label="Issue-wide facet evidence">
          <span className="facet-scope">Issue-wide: </span>
          <FacetSummary values={facets.environment} fallback="No environment" />
          <span aria-hidden="true"> · </span>
          <FacetSummary values={facets.release} fallback="Unknown version" />
          <span aria-hidden="true"> · </span>
          <FacetSummary values={facets.service} fallback="No service" />
        </p>
      )}
    </>
  );
  const count = (
    <span className="issue-count">
      {issue.matchingCount === issue.occurrenceCount
        ? `${String(issue.occurrenceCount)} events`
        : `${String(issue.matchingCount)} matching / ${String(issue.occurrenceCount)} total`}
    </span>
  );
  const spine = (
    <SignalSpine level={issue.highestLevel} count={issue.matchingCount} />
  );

  if (variant === "card") {
    return (
      <article className="issue-card" aria-label={issue.title}>
        {spine}
        <div className="issue-card-body">
          {body}
          {count}
          <dl className="issue-card-times">
            <div>
              <dt>First seen</dt>
              <dd>
                <TimeValue value={issue.firstSeen} />
              </dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>
                <TimeValue value={issue.lastSeen} />
              </dd>
            </div>
          </dl>
        </div>
      </article>
    );
  }

  return (
    <tr>
      <td className="signal-cell">{spine}</td>
      <td className="issue-main-cell">{body}</td>
      <td className="count-cell">{count}</td>
      <td className="time-cell">
        <TimeValue value={issue.firstSeen} />
      </td>
      <td className="time-cell">
        <TimeValue value={issue.lastSeen} />
      </td>
    </tr>
  );
}

function FacetSummary({
  values,
  fallback,
}: {
  readonly values: readonly FacetValue[];
  readonly fallback: string;
}) {
  if (values.length === 0) return <span>{fallback}</span>;
  return (
    <>
      {values.slice(0, 3).map((value, index) => (
        <span key={value.queryValue}>
          {index === 0 ? null : <span aria-hidden="true">, </span>}
          <span>{value.label ?? value.value ?? fallback}</span>
        </span>
      ))}
    </>
  );
}

function SignalSpine({
  level,
  count,
}: {
  readonly level: IssueListItem["highestLevel"];
  readonly count: number;
}) {
  const density = Math.min(4, Math.max(1, Math.ceil(Math.log10(count + 1))));
  return (
    <span
      className={`signal-spine signal-${level}`}
      aria-label={`${severityLabel(level)} severity, recurrence density ${String(density)} of 4`}
    >
      {[1, 2, 3, 4].map((segment) => (
        <span
          key={segment}
          className={
            segment <= density ? "signal-segment active" : "signal-segment"
          }
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function severityLabel(level: IssueListItem["highestLevel"]): string {
  if (level === "warn") return "Warning";
  if (level === "fatal") return "Fatal";
  return "Error";
}
