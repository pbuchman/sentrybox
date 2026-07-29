import { useState } from "react";
import type {
  EventDetail,
  EventSummary,
  IssueDetail,
  NormalizedFrame,
  OperatorApi,
  WebhookDelivery,
} from "../api/client.js";
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
}

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
}: EventDetailsProps) {
  const exception = event.normalized.exception;
  const frames = exception?.frames ?? [];
  const applicationFrames = frames.filter((frame) => frame.in_app === true);
  const libraryFrames = frames.filter((frame) => frame.in_app !== true);
  const breadcrumbs = event.normalized.breadcrumbs ?? [];
  const contexts = event.normalized.payload?.contexts ?? {};
  const extras = event.normalized.payload?.extras ?? {};
  const [copyState, setCopyState] = useState<string | null>(null);

  const copyQuery = async (): Promise<void> => {
    if (event.logLocator.query === null) return;
    try {
      await navigator.clipboard.writeText(event.logLocator.query);
      setCopyState("LogQL copied.");
    } catch {
      setCopyState("LogQL could not be copied. Select the query and copy it.");
    }
  };

  return (
    <div className="detail-sections">
      <section className="evidence-section" aria-labelledby="exception-heading">
        <SectionHeading
          id="exception-heading"
          eyebrow="Selected occurrence"
          title="Exception and application frames"
        />
        {exception === null || exception === undefined ? (
          <p className="empty-inline">
            This event has no exception interface. The retained message is shown
            instead.
          </p>
        ) : (
          <div className="exception-summary">
            <p className="exception-type">
              {asText(exception.type, "Exception")}
            </p>
            <p>{asText(exception.value, event.message ?? event.title)}</p>
          </div>
        )}
        {applicationFrames.length > 0 ? (
          <FrameList
            frames={applicationFrames}
            label="Application stack frames"
          />
        ) : (
          <p className="empty-inline">
            No application frame was marked by the SDK. Library evidence remains
            available below.
          </p>
        )}
        {libraryFrames.length > 0 ? (
          <details className="secondary-disclosure">
            <summary>
              Additional library frames ({String(libraryFrames.length)})
            </summary>
            <FrameList frames={libraryFrames} label="Library stack frames" />
          </details>
        ) : null}
        {event.truncated ? (
          <p className="notice notice-warn">
            This normalized event reached a configured limit. Truncation
            reasons:{" "}
            {Array.isArray(event.normalized.truncationReasons)
              ? event.normalized.truncationReasons.join(", ")
              : "recorded in normalized JSON"}
            .
          </p>
        ) : null}
      </section>

      <section className="evidence-section" aria-labelledby="facets-heading">
        <SectionHeading
          id="facets-heading"
          eyebrow="Retained scope"
          title="Facets"
        />
        <div className="facet-groups">
          <FacetGroup
            name="Project"
            values={[
              {
                label: issue.project.name,
                queryValue: issue.project.slug,
                count: issue.occurrenceCount,
              },
            ]}
            parameter="project"
          />
          <FacetGroup
            name="Version"
            values={issue.facets.release}
            parameter="release"
          />
          <FacetGroup
            name="Environment"
            values={issue.facets.environment}
            parameter="environment"
          />
          <FacetGroup
            name="Service"
            values={issue.facets.service}
            parameter="service"
          />
          <FacetGroup
            name="Level"
            values={issue.facets.level}
            parameter="level"
          />
        </div>
      </section>

      <section className="evidence-section" aria-labelledby="logs-heading">
        <SectionHeading
          id="logs-heading"
          eyebrow={confidenceLabel(event.logLocator.confidence)}
          title="Log locator"
        />
        <p>{event.logLocator.explanation}</p>
        <dl className="evidence-list">
          <div>
            <dt>Time range from</dt>
            <dd>
              <TimeValue value={event.logLocator.from} />
            </dd>
          </div>
          <div>
            <dt>Time range to</dt>
            <dd>
              <TimeValue value={event.logLocator.to} />
            </dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{event.logLocator.criteria.environment}</dd>
          </div>
          <div>
            <dt>Service</dt>
            <dd>{event.logLocator.criteria.service ?? "Not supplied"}</dd>
          </div>
          {event.logLocator.criteria.identifier !== null ? (
            <div>
              <dt>{event.logLocator.criteria.identifier.kind}</dt>
              <dd className="mono">
                {event.logLocator.criteria.identifier.value}
              </dd>
            </div>
          ) : null}
        </dl>
        {event.logLocator.query === null ? (
          <p className="empty-inline">
            No server-log query is expected for this occurrence.
          </p>
        ) : (
          <>
            <pre className="code-panel">
              <code>{event.logLocator.query}</code>
            </pre>
            <div className="inline-actions">
              {event.logLocator.grafanaUrl !== null ? (
                <a
                  className="button button-primary"
                  href={event.logLocator.grafanaUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open matching logs
                </a>
              ) : null}
              <button
                className="button"
                type="button"
                onClick={() => void copyQuery()}
              >
                Copy LogQL query
              </button>
            </div>
            {copyState === null ? null : (
              <p className="action-feedback" role="status">
                {copyState}
              </p>
            )}
          </>
        )}
      </section>

      <section
        className="evidence-section"
        aria-labelledby="breadcrumbs-heading"
      >
        <SectionHeading
          id="breadcrumbs-heading"
          eyebrow="Chronological evidence"
          title="Breadcrumbs"
        />
        {breadcrumbs.length === 0 ? (
          <p className="empty-inline">The SDK retained no breadcrumbs.</p>
        ) : (
          <ol className="breadcrumb-list">
            {breadcrumbs.map((breadcrumb, index) => {
              const timestamp = breadcrumbTimestamp(breadcrumb.timestamp);
              return (
                <li key={`${timestamp ?? "untimed"}-${String(index)}`}>
                  <div>
                    <span className="breadcrumb-category">
                      {asText(breadcrumb.category, "event")}
                    </span>
                    <span>{asText(breadcrumb.message, "Breadcrumb")}</span>
                  </div>
                  {timestamp === null ? (
                    <span className="time-missing">
                      Timestamp unavailable in retained SDK data
                    </span>
                  ) : (
                    <TimeValue value={timestamp} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="evidence-section" aria-labelledby="context-heading">
        <SectionHeading
          id="context-heading"
          eyebrow="Stored after server redaction"
          title="Redacted contexts and extras"
        />
        <div className="code-grid">
          <div>
            <h3>Contexts</h3>
            <pre className="code-panel">
              <code>{pretty(contexts)}</code>
            </pre>
          </div>
          <div>
            <h3>Extras</h3>
            <pre className="code-panel">
              <code>{pretty(extras)}</code>
            </pre>
          </div>
        </div>
      </section>

      <section
        className="evidence-section"
        aria-labelledby="occurrences-heading"
      >
        <SectionHeading
          id="occurrences-heading"
          eyebrow={`${String(events.length)} retained on this page`}
          title="Occurrences"
        />
        {events.length === 0 ? (
          <p className="empty-inline">
            Retention removed every occurrence from this issue.
          </p>
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
                  <span>
                    <strong>
                      {occurrence.exceptionType ?? occurrence.title}
                    </strong>
                    <span className="occurrence-facets">
                      {occurrence.release ?? "Unknown version"} ·{" "}
                      {occurrence.environment} ·{" "}
                      {occurrence.service ?? "No service"}
                    </span>
                  </span>
                  <TimeValue value={occurrence.occurredAt} />
                </button>
                <a
                  className="text-link"
                  href={api.eventDownloadUrl(occurrence.rowId)}
                >
                  Download event
                </a>
              </li>
            ))}
          </ol>
        )}
        {occurrenceError ? (
          <div className="pagination-error" role="alert">
            <p>
              More occurrences could not be loaded. The current evidence is
              still available.
            </p>
            <button className="button" type="button" onClick={onLoadMoreEvents}>
              Retry more occurrences
            </button>
          </div>
        ) : nextEventCursor === null ? null : (
          <div className="pagination">
            <button
              className="button"
              type="button"
              disabled={loadingMoreEvents}
              onClick={onLoadMoreEvents}
            >
              {loadingMoreEvents
                ? "Loading more occurrences…"
                : "Load more occurrences"}
            </button>
          </div>
        )}
      </section>

      <section className="evidence-section" aria-labelledby="delivery-heading">
        <SectionHeading
          id="delivery-heading"
          eyebrow="Code Agent transition audit"
          title="Delivery state"
        />
        {issue.deliveries.length === 0 ? (
          <p className="empty-inline">
            No created or regressed delivery exists in the retained window.
          </p>
        ) : (
          <ol className="delivery-list">
            {issue.deliveries.map((delivery) => (
              <li key={delivery.id}>
                <div className="delivery-heading">
                  <div>
                    <strong>
                      Generation {String(delivery.generation)} ·{" "}
                      {delivery.cause === "created" ? "Created" : "Regressed"}
                    </strong>
                    <span className={`delivery-state state-${delivery.state}`}>
                      {deliveryStateLabel(delivery.state)}
                    </span>
                  </div>
                  <TimeValue value={delivery.createdAt} />
                </div>
                <p>
                  {String(delivery.attempts)} delivery{" "}
                  {delivery.attempts === 1 ? "attempt" : "attempts"}
                </p>
                {delivery.lastError === null ? null : (
                  <p className="notice notice-error">{delivery.lastError}</p>
                )}
                {delivery.nextAttempt === null ? null : (
                  <p>
                    Next attempt: <TimeValue value={delivery.nextAttempt} />
                  </p>
                )}
                {delivery.deliveredAt === null ? null : (
                  <p>
                    Delivered: <TimeValue value={delivery.deliveredAt} />
                  </p>
                )}
                {delivery.state === "dead_letter" &&
                !delivery.redrives.some(
                  (redrive) => redrive.state === "pending",
                ) ? (
                  <button
                    className="button"
                    type="button"
                    disabled={retryingDelivery === delivery.id}
                    onClick={() => void onRetryDelivery(delivery)}
                  >
                    {retryingDelivery === delivery.id
                      ? "Queueing redrive…"
                      : "Retry delivery"}
                  </button>
                ) : null}
                {delivery.redrives.length === 0 ? null : (
                  <ul className="redrive-list">
                    {delivery.redrives.map((redrive) => (
                      <li key={redrive.id}>
                        Redrive {deliveryStateLabel(redrive.state)} · requested{" "}
                        <TimeValue value={redrive.requestedAt} />
                        {redrive.attemptedAt === null ? null : (
                          <>
                            {" "}
                            · attempted{" "}
                            <TimeValue value={redrive.attemptedAt} />
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <details className="evidence-section normalized-json">
        <summary>
          <span className="eyebrow">Redacted stored record</span>
          <h2>Normalized JSON</h2>
        </summary>
        <pre className="code-panel">
          <code>{pretty(event.normalized)}</code>
        </pre>
      </details>
    </div>
  );
}

function SectionHeading({
  id,
  eyebrow,
  title,
}: {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
}) {
  return (
    <header className="section-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id}>{title}</h2>
    </header>
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

function FacetGroup({
  name,
  values,
  parameter,
}: {
  readonly name: string;
  readonly values: readonly {
    readonly label: string | null;
    readonly queryValue: string;
    readonly count: number;
  }[];
  readonly parameter: string;
}) {
  return (
    <div>
      <h3>{name}</h3>
      <ul className="facet-chip-list">
        {values.map((value) => (
          <li key={value.queryValue}>
            <a
              href={`/?status=unresolved&${parameter}=${encodeURIComponent(value.queryValue)}`}
            >
              {value.label ?? "Unknown"} <span>{String(value.count)}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function confidenceLabel(
  confidence: EventDetail["logLocator"]["confidence"],
): string {
  if (confidence === "exact_identifier") return "Exact identifier";
  if (confidence === "time_message_fallback") {
    return "Time and message fallback";
  }
  return "Not applicable to server logs";
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
