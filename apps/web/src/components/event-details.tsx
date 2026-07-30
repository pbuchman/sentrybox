import { useEffect, useState } from "react";
import type {
  EventDetail,
  EventSummary,
  IssueDetail,
  NormalizedFrame,
  OperatorApi,
  WebhookDelivery,
} from "../api/client.js";
import { Icon } from "./icons.js";
import { TimeValue } from "./time-value.js";

interface EventDetailsProps {
  readonly api: OperatorApi;
  readonly issue: IssueDetail;
  readonly event: EventDetail;
  readonly events: readonly EventSummary[];
  readonly selectedRowId: number;
  readonly onSelectEvent: (rowId: number) => void;
  readonly nextEventCursor: string | null;
  readonly loadingMoreEvents: boolean;
  readonly occurrenceError: boolean;
  readonly onLoadMoreEvents: () => void;
  readonly onRetryDelivery: (delivery: WebhookDelivery) => Promise<void>;
  readonly retryingDelivery: number | null;
  readonly readOnly?: boolean;
}

const BREADCRUMB_PREVIEW = 6;

export function EventDetails({
  api,
  issue,
  event,
  events,
  selectedRowId,
  onSelectEvent,
  nextEventCursor,
  loadingMoreEvents,
  occurrenceError,
  onLoadMoreEvents,
  onRetryDelivery,
  retryingDelivery,
  readOnly = false,
}: EventDetailsProps) {
  const exception = event.normalized.exception;
  const frames = exception?.frames ?? [];
  const applicationFrames = frames.filter((frame) => frame.in_app === true);
  const libraryFrames = frames.filter((frame) => frame.in_app !== true);
  const breadcrumbs = event.normalized.breadcrumbs ?? [];
  const [showAllBreadcrumbs, setShowAllBreadcrumbs] = useState(false);
  const [copyState, setCopyState] = useState<string | null>(null);

  useEffect(() => {
    setShowAllBreadcrumbs(false);
    setCopyState(null);
  }, [event.id]);

  const copyQuery = async (): Promise<void> => {
    if (event.logLocator.query === null) return;
    try {
      await navigator.clipboard.writeText(event.logLocator.query);
      setCopyState("Log query copied.");
    } catch {
      setCopyState(
        "Could not copy automatically. Select the query and copy it.",
      );
    }
  };

  return (
    <div className="evidence-workspace">
      <aside className="occurrence-rail" aria-labelledby="occurrences-heading">
        <div className="occurrence-rail-heading">
          <div>
            <p className="eyebrow">Evidence</p>
            <h2 id="occurrences-heading">Occurrences</h2>
          </div>
          <span>{String(events.length)}</span>
        </div>
        {events.length === 0 ? (
          <p className="empty-inline">No occurrence is retained.</p>
        ) : (
          <ol className="occurrence-list">
            {events.map((occurrence) => (
              <li
                key={occurrence.rowId}
                className={
                  occurrence.rowId === selectedRowId ? "is-selected" : undefined
                }
              >
                <button
                  type="button"
                  aria-pressed={occurrence.rowId === selectedRowId}
                  onClick={() => onSelectEvent(occurrence.rowId)}
                >
                  <span
                    className={`occurrence-level severity-${occurrence.level}`}
                    aria-hidden="true"
                  />
                  <span className="occurrence-copy">
                    <strong>
                      <TimeValue value={occurrence.occurredAt} compact />
                    </strong>
                    <span>
                      {shortRelease(occurrence.release)} ·{" "}
                      {occurrence.environment}
                    </span>
                  </span>
                  <Icon name="chevron" size={17} />
                </button>
                <a
                  className="occurrence-download"
                  href={api.eventDownloadUrl(occurrence.rowId)}
                  download
                  aria-label={`Download occurrence from ${occurrence.occurredAt}`}
                >
                  <Icon name="download" size={15} />
                </a>
              </li>
            ))}
          </ol>
        )}
        {occurrenceError ? (
          <div className="pagination-error" role="alert">
            <p>More occurrences could not be loaded.</p>
            <button className="button" type="button" onClick={onLoadMoreEvents}>
              Try again
            </button>
          </div>
        ) : nextEventCursor === null ? null : (
          <button
            className="button load-occurrences"
            type="button"
            disabled={loadingMoreEvents}
            onClick={onLoadMoreEvents}
          >
            {loadingMoreEvents ? "Loading…" : "Load more"}
          </button>
        )}
      </aside>

      <div className="evidence-main">
        <section
          className="evidence-card evidence-primary"
          aria-labelledby="exception-heading"
        >
          <div
            className="event-meta-strip"
            aria-label="Selected occurrence metadata"
          >
            <span>
              <strong>Occurred</strong>
              <TimeValue value={event.occurredAt} compact />
            </span>
            <span>
              <strong>Release</strong>
              {shortRelease(event.release)}
            </span>
            <span>
              <strong>Environment</strong>
              {event.environment}
            </span>
            <span>
              <strong>Service</strong>
              {event.service ?? "Not supplied"}
            </span>
          </div>
          <header className="evidence-heading">
            <p className="eyebrow">Stack evidence</p>
            <h2 id="exception-heading">
              {asText(exception?.type, event.exceptionType ?? "Exception")}
            </h2>
            <p>{asText(exception?.value, event.message ?? event.title)}</p>
          </header>
          {applicationFrames.length === 0 ? (
            <p className="empty-inline">
              The SDK did not mark an application frame.
            </p>
          ) : (
            <FrameList
              frames={applicationFrames}
              label="Application stack frames"
            />
          )}
          {libraryFrames.length === 0 ? null : (
            <details className="compact-disclosure">
              <summary>
                Library frames <span>{String(libraryFrames.length)}</span>
              </summary>
              <FrameList frames={libraryFrames} label="Library stack frames" />
            </details>
          )}
          {event.truncated ? (
            <p className="notice notice-warn">
              This event reached a retention limit. The raw record contains
              truncation details.
            </p>
          ) : null}
        </section>

        <section
          className="evidence-card log-evidence"
          aria-labelledby="logs-heading"
        >
          <header className="evidence-heading evidence-heading-inline">
            <div>
              <p className="eyebrow">
                {confidenceLabel(event.logLocator.confidence)}
              </p>
              <h2 id="logs-heading">Matching logs</h2>
            </div>
            <div className="inline-actions">
              {event.logLocator.grafanaUrl === null ? null : (
                <a
                  className="button button-primary"
                  href={event.logLocator.grafanaUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open logs <Icon name="external" size={16} />
                </a>
              )}
              {event.logLocator.query === null ? null : (
                <button
                  className="button"
                  type="button"
                  onClick={() => void copyQuery()}
                >
                  <Icon name="copy" size={16} /> Copy query
                </button>
              )}
            </div>
          </header>
          <p>{event.logLocator.explanation}</p>
          {event.logLocator.query === null ? (
            <p className="empty-inline">
              No server-log query is expected for this occurrence.
            </p>
          ) : (
            <details className="query-disclosure">
              <summary>View LogQL query</summary>
              <pre className="code-panel">
                <code>{event.logLocator.query}</code>
              </pre>
            </details>
          )}
          {copyState === null ? null : (
            <p className="action-feedback" role="status">
              {copyState}
            </p>
          )}
        </section>

        <section
          className="evidence-card"
          aria-labelledby="breadcrumbs-heading"
        >
          <header className="evidence-heading evidence-heading-inline">
            <div>
              <p className="eyebrow">Timeline</p>
              <h2 id="breadcrumbs-heading">Breadcrumbs</h2>
            </div>
            <span className="section-count">{String(breadcrumbs.length)}</span>
          </header>
          {breadcrumbs.length === 0 ? (
            <p className="empty-inline">The SDK retained no breadcrumbs.</p>
          ) : (
            <ol className="breadcrumb-list">
              {breadcrumbs
                .slice(0, showAllBreadcrumbs ? undefined : BREADCRUMB_PREVIEW)
                .map((breadcrumb, index) => {
                  const timestamp = breadcrumbTimestamp(breadcrumb.timestamp);
                  return (
                    <li key={`${timestamp ?? "untimed"}-${String(index)}`}>
                      <span className="breadcrumb-marker" aria-hidden="true" />
                      <div>
                        <strong>{asText(breadcrumb.category, "event")}</strong>
                        <span>{asText(breadcrumb.message, "Breadcrumb")}</span>
                      </div>
                      {timestamp === null ? (
                        <span className="time-missing">No timestamp</span>
                      ) : (
                        <TimeValue value={timestamp} compact />
                      )}
                    </li>
                  );
                })}
            </ol>
          )}
          {breadcrumbs.length <= BREADCRUMB_PREVIEW ? null : (
            <button
              className="button button-quiet show-more"
              type="button"
              onClick={() => setShowAllBreadcrumbs((value) => !value)}
            >
              {showAllBreadcrumbs
                ? "Show less"
                : `Show ${String(breadcrumbs.length - BREADCRUMB_PREVIEW)} more`}
            </button>
          )}
        </section>

        <details className="evidence-card evidence-disclosure">
          <summary>
            <span>
              <Icon name="chevron" size={18} />
              <strong>Context & extras</strong>
            </span>
            <span>Redacted</span>
          </summary>
          <div className="code-grid">
            <div>
              <h3>Contexts</h3>
              <pre className="code-panel">
                <code>{pretty(event.normalized.payload?.contexts ?? {})}</code>
              </pre>
            </div>
            <div>
              <h3>Extras</h3>
              <pre className="code-panel">
                <code>{pretty(event.normalized.payload?.extras ?? {})}</code>
              </pre>
            </div>
          </div>
        </details>

        <details className="evidence-card evidence-disclosure">
          <summary>
            <span>
              <Icon name="chevron" size={18} />
              <strong>Delivery</strong>
            </span>
            <span>{deliverySummary(issue.deliveries)}</span>
          </summary>
          <DeliveryList
            deliveries={issue.deliveries}
            retryingDelivery={retryingDelivery}
            onRetryDelivery={onRetryDelivery}
            readOnly={readOnly}
          />
        </details>

        <details className="evidence-card evidence-disclosure raw-event">
          <summary>
            <span>
              <Icon name="chevron" size={18} />
              <strong>Raw event data</strong>
            </span>
            <span>Normalized JSON</span>
          </summary>
          <pre className="code-panel">
            <code>{pretty(event.normalized)}</code>
          </pre>
        </details>
      </div>
    </div>
  );
}

function FrameList({
  frames,
  label,
}: {
  readonly frames: readonly NormalizedFrame[];
  readonly label: string;
}) {
  return (
    <ol className="frame-list" aria-label={label}>
      {frames
        .slice()
        .reverse()
        .map((frame, index) => (
          <li key={`${asText(frame.filename, "unknown")}-${String(index)}`}>
            <span className="frame-index">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="frame-function">
              {asText(frame.function, asText(frame.module, "anonymous"))}
            </span>
            <span className="frame-location">
              {asText(frame.filename, "Unknown source")}
              {typeof frame.lineno === "number"
                ? `:${String(frame.lineno)}`
                : ""}
              {typeof frame.colno === "number" ? `:${String(frame.colno)}` : ""}
            </span>
          </li>
        ))}
    </ol>
  );
}

function DeliveryList({
  deliveries,
  retryingDelivery,
  onRetryDelivery,
  readOnly,
}: {
  readonly deliveries: IssueDetail["deliveries"];
  readonly retryingDelivery: number | null;
  readonly onRetryDelivery: (delivery: WebhookDelivery) => Promise<void>;
  readonly readOnly: boolean;
}) {
  if (deliveries.length === 0)
    return (
      <p className="empty-inline">No delivery exists in the retained window.</p>
    );
  return (
    <ol className="delivery-list">
      {deliveries.map((delivery) => (
        <li key={delivery.id}>
          <div className="delivery-heading">
            <strong>
              Generation {String(delivery.generation)} ·{" "}
              {delivery.cause === "created" ? "Created" : "Regressed"}
            </strong>
            <span className={`delivery-state state-${delivery.state}`}>
              {deliveryStateLabel(delivery.state)}
            </span>
          </div>
          <p>
            {String(delivery.attempts)}{" "}
            {delivery.attempts === 1 ? "attempt" : "attempts"} ·{" "}
            <TimeValue value={delivery.createdAt} compact />
          </p>
          {delivery.lastError === null ? null : (
            <p className="notice notice-error">{delivery.lastError}</p>
          )}
          {delivery.state === "dead_letter" &&
          !delivery.redrives.some((redrive) => redrive.state === "pending") ? (
            <button
              className="button"
              type="button"
              disabled={readOnly || retryingDelivery === delivery.id}
              onClick={() => void onRetryDelivery(delivery)}
            >
              {retryingDelivery === delivery.id
                ? "Queueing…"
                : "Retry delivery"}
            </button>
          ) : null}
          {delivery.redrives.length === 0 ? null : (
            <p>
              {String(delivery.redrives.length)} redrive request
              {delivery.redrives.length === 1 ? "" : "s"}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function shortRelease(release: string | null): string {
  if (release === null || release.length === 0) return "Unknown";
  return release.length > 18
    ? `${release.slice(0, 8)}…${release.slice(-7)}`
    : release;
}

function confidenceLabel(
  confidence: EventDetail["logLocator"]["confidence"],
): string {
  if (confidence === "exact_identifier") return "Exact correlation";
  if (confidence === "time_message_fallback") return "Time and message match";
  return "No log correlation";
}

function deliverySummary(deliveries: IssueDetail["deliveries"]): string {
  if (deliveries.length === 0) return "No deliveries";
  const failures = deliveries.filter(
    (delivery) => delivery.state === "dead_letter",
  ).length;
  return failures === 0
    ? `${String(deliveries.length)} retained`
    : `${String(failures)} failed`;
}

function deliveryStateLabel(state: string): string {
  return state
    .split("_")
    .map((part, index) =>
      index === 0 ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part,
    )
    .join(" ");
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function breadcrumbTimestamp(value: unknown): string | null {
  const milliseconds =
    typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}
