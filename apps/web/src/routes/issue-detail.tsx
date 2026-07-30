import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EventDetail,
  EventSummary,
  FacetValue,
  IssueDetail as IssueDetailModel,
  OperatorApi,
  SystemStatus,
  WebhookDelivery,
} from "../api/client.js";
import { AppShell } from "../components/app-shell.js";
import { ConfirmDeleteDialog } from "../components/confirm-delete-dialog.js";
import { EventDetails } from "../components/event-details.js";
import { Icon } from "../components/icons.js";
import { TimeValue } from "../components/time-value.js";

interface IssueDetailProps {
  readonly api: OperatorApi;
  readonly issueId: number;
  readonly requestedEventId: string | undefined;
  readonly onNavigate: (path: string) => void;
  readonly readOnly?: boolean;
}

interface DetailState {
  readonly issue: IssueDetailModel;
  readonly events: readonly EventSummary[];
  readonly event: EventDetail | null;
  readonly nextEventCursor: string | null;
  readonly requestedEventMissing: boolean;
  readonly projects: readonly FacetValue[];
  readonly system: SystemStatus | null;
}

export function IssueDetail({
  api,
  issueId,
  requestedEventId,
  onNavigate,
  readOnly = false,
}: IssueDetailProps) {
  const [state, setState] = useState<DetailState | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const [retryingDelivery, setRetryingDelivery] = useState<number | null>(null);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const [occurrenceError, setOccurrenceError] = useState(false);
  const selectionRequest = useRef(0);

  useEffect(() => {
    let active = true;
    selectionRequest.current += 1;
    setError(false);
    setState(null);
    void Promise.all([
      api.getIssue(issueId),
      api.listIssueEvents(issueId),
      safeRead(() => api.getFacets(new URLSearchParams())),
      safeRead(() => api.getSystemStatus()),
    ])
      .then(async ([issue, firstPage, facets, system]) => {
        const events = [...firstPage.items];
        let nextEventCursor = firstPage.nextCursor;
        let selected =
          requestedEventId === undefined
            ? events[0]
            : events.find((item) => item.id === requestedEventId);
        const seenCursors = new Set<string>();
        while (
          requestedEventId !== undefined &&
          selected === undefined &&
          nextEventCursor !== null &&
          !seenCursors.has(nextEventCursor)
        ) {
          seenCursors.add(nextEventCursor);
          const page = await api.listIssueEvents(issueId, nextEventCursor);
          events.push(...page.items);
          selected = page.items.find((item) => item.id === requestedEventId);
          nextEventCursor = page.nextCursor;
        }
        const event =
          selected === undefined ? null : await api.getEvent(selected.rowId);
        if (!active) return;
        const fallbackProject: FacetValue = {
          value: issue.project.slug,
          queryValue: issue.project.slug,
          label: issue.project.name,
          count: issue.occurrenceCount,
        };
        setState({
          issue,
          events,
          event,
          nextEventCursor,
          requestedEventMissing:
            requestedEventId !== undefined && selected === undefined,
          projects: facets?.project.length ? facets.project : [fallbackProject],
          system,
        });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [api, issueId, requestedEventId, retry]);

  const mutateStatus = async (
    target: "resolved" | "unresolved",
  ): Promise<void> => {
    if (readOnly) return;
    setPendingAction(target);
    setActionError(null);
    setFeedback(null);
    try {
      const issue =
        target === "resolved"
          ? await api.resolveIssue(issueId)
          : await api.reopenIssue(issueId);
      setState((current) => (current === null ? null : { ...current, issue }));
      setFeedback(
        target === "resolved" ? "Issue resolved." : "Issue reopened.",
      );
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The status could not be changed.",
      );
    } finally {
      setPendingAction(null);
    }
  };

  const selectEvent = async (rowId: number): Promise<void> => {
    const request = selectionRequest.current + 1;
    selectionRequest.current = request;
    setPendingAction(`event-${String(rowId)}`);
    setActionError(null);
    try {
      const event = await api.getEvent(rowId);
      if (selectionRequest.current !== request) return;
      setState((current) =>
        current === null
          ? null
          : { ...current, event, requestedEventMissing: false },
      );
      window.history.replaceState(
        {},
        "",
        `/?${new URLSearchParams({ issue: String(issueId), event: event.eventId }).toString()}`,
      );
    } catch {
      if (selectionRequest.current === request)
        setActionError("Occurrence details could not be loaded. Try again.");
    } finally {
      if (selectionRequest.current === request) setPendingAction(null);
    }
  };

  const loadMoreEvents = async (): Promise<void> => {
    const cursor = state?.nextEventCursor;
    if (state === null || cursor === null) return;
    setLoadingMoreEvents(true);
    setOccurrenceError(false);
    try {
      const page = await api.listIssueEvents(issueId, cursor);
      setState((current) =>
        current === null
          ? null
          : {
              ...current,
              events: [...current.events, ...page.items],
              nextEventCursor: page.nextCursor,
            },
      );
    } catch {
      setOccurrenceError(true);
    } finally {
      setLoadingMoreEvents(false);
    }
  };

  const retryDelivery = async (delivery: WebhookDelivery): Promise<void> => {
    if (readOnly) return;
    setRetryingDelivery(delivery.id);
    setActionError(null);
    try {
      const redrive = await api.retryDelivery(delivery.id);
      setState((current) =>
        current === null
          ? null
          : {
              ...current,
              issue: {
                ...current.issue,
                deliveries: current.issue.deliveries.map((item) =>
                  item.id === delivery.id
                    ? { ...item, redrives: [...item.redrives, redrive] }
                    : item,
                ),
              },
            },
      );
      setFeedback("Delivery retry queued.");
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Delivery retry failed.",
      );
    } finally {
      setRetryingDelivery(null);
    }
  };

  const cancelDelete = useCallback((): void => {
    setDeleteOpen(false);
    window.setTimeout(() => deleteButton.current?.focus(), 0);
  }, []);

  const deleteIssue = async (): Promise<void> => {
    if (readOnly || state === null) return;
    setPendingAction("delete");
    setActionError(null);
    try {
      await api.deleteIssue(issueId);
      onNavigate(
        `/?${new URLSearchParams({ project: state.issue.project.slug, status: "unresolved" }).toString()}`,
      );
    } catch (cause) {
      setDeleteOpen(false);
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Delete failed. No data was removed.",
      );
      window.setTimeout(() => deleteButton.current?.focus(), 0);
    } finally {
      setPendingAction(null);
    }
  };

  if (state === null && !error)
    return <StandaloneState label="Loading issue evidence…" />;
  if (error) {
    return (
      <main id="main-content" className="standalone-state" role="alert">
        <Icon name="error" size={34} />
        <h1>Issue details could not be loaded</h1>
        <p>Check the private deployment connection and try again.</p>
        <button
          className="button button-primary"
          type="button"
          onClick={() => setRetry((value) => value + 1)}
        >
          Try again
        </button>
      </main>
    );
  }
  if (state === null) return null;

  const projectQuery = new URLSearchParams({
    project: state.issue.project.slug,
    status: "unresolved",
  });
  const listPath = `/?${projectQuery.toString()}`;
  const navigateList = (): void => onNavigate(listPath);
  const selectedRowId = state.event?.id ?? -1;

  return (
    <AppShell
      projects={state.projects}
      activeProjectSlug={state.issue.project.slug}
      system={state.system}
      onSelectProject={(slug) =>
        onNavigate(
          `/?${new URLSearchParams({ project: slug, status: "unresolved" }).toString()}`,
        )
      }
    >
      <main id="main-content" className="detail-page">
        {readOnly ? (
          <p className="read-only-note" role="status">
            Live deployment preview · destructive actions are disabled locally.
          </p>
        ) : null}
        <nav className="detail-breadcrumbs" aria-label="Breadcrumb">
          <button type="button" onClick={navigateList}>
            <Icon name="back" size={18} /> Issues
          </button>
          <span aria-hidden="true">/</span>
          <span>{state.issue.project.name}</span>
          <span aria-hidden="true">/</span>
          <span>Issue #{String(state.issue.id)}</span>
        </nav>
        <header className="issue-detail-header">
          <div className="detail-title-block">
            <div className="detail-state-line">
              <span className={`status status-${state.issue.status}`}>
                {state.issue.status === "resolved" ? "Resolved" : "Open"}
              </span>
              <span className={`severity severity-${state.issue.highestLevel}`}>
                {severityLabel(state.issue.highestLevel)}
              </span>
            </div>
            <h1>{state.issue.title}</h1>
            <dl className="detail-summary">
              <div>
                <dt>Events</dt>
                <dd>{String(state.issue.occurrenceCount)}</dd>
              </div>
              <div>
                <dt>First seen</dt>
                <dd>
                  <TimeValue value={state.issue.firstSeen} compact />
                </dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>
                  <TimeValue value={state.issue.lastSeen} compact />
                </dd>
              </div>
            </dl>
          </div>
          <div className="detail-actions" aria-label="Issue actions">
            <button
              className="button button-primary"
              type="button"
              disabled={pendingAction !== null || readOnly}
              onClick={() =>
                void mutateStatus(
                  state.issue.status === "unresolved"
                    ? "resolved"
                    : "unresolved",
                )
              }
            >
              {pendingAction === "resolved"
                ? "Resolving…"
                : pendingAction === "unresolved"
                  ? "Reopening…"
                  : state.issue.status === "unresolved"
                    ? "Resolve"
                    : "Reopen"}
            </button>
            <details className="action-menu">
              <summary className="icon-button" aria-label="More issue actions">
                <Icon name="more" size={20} />
              </summary>
              <div className="action-menu-panel">
                <a href={api.issueDownloadUrl(issueId)} download>
                  <Icon name="download" size={17} /> Download issue
                </a>
                <button
                  ref={deleteButton}
                  type="button"
                  disabled={readOnly}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Icon name="error" size={17} /> Delete permanently
                </button>
              </div>
            </details>
          </div>
        </header>
        {feedback === null ? null : (
          <p className="action-feedback" role="status">
            {feedback}
          </p>
        )}
        {actionError === null ? null : (
          <p className="notice notice-error" role="alert">
            {actionError}
          </p>
        )}
        {state.requestedEventMissing ? (
          <div className="state-panel state-error" role="alert">
            <h2>Occurrence no longer retained</h2>
            <p>
              The issue is available, but this event is outside the retention
              window.
            </p>
          </div>
        ) : state.event === null ? (
          <div className="state-panel">
            <h2>No retained evidence</h2>
            <p>
              Issue metadata remains available, but every occurrence has
              expired.
            </p>
          </div>
        ) : (
          <EventDetails
            api={api}
            issue={state.issue}
            event={state.event}
            events={state.events}
            selectedRowId={selectedRowId}
            onSelectEvent={(rowId) => void selectEvent(rowId)}
            nextEventCursor={state.nextEventCursor}
            loadingMoreEvents={loadingMoreEvents}
            occurrenceError={occurrenceError}
            onLoadMoreEvents={() => void loadMoreEvents()}
            onRetryDelivery={retryDelivery}
            retryingDelivery={retryingDelivery}
            readOnly={readOnly}
          />
        )}
      </main>
      {deleteOpen ? (
        <ConfirmDeleteDialog
          eventCount={state.issue.occurrenceCount}
          pending={pendingAction === "delete"}
          onCancel={cancelDelete}
          onConfirm={() => void deleteIssue()}
        />
      ) : null}
    </AppShell>
  );
}

function StandaloneState({ label }: { readonly label: string }) {
  return (
    <main id="main-content" className="standalone-state" role="status">
      <Icon name="box" size={38} />
      <p>{label}</p>
    </main>
  );
}

function severityLabel(level: IssueDetailModel["highestLevel"]): string {
  if (level === "warn") return "Warning";
  if (level === "fatal") return "Fatal";
  return "Error";
}

async function safeRead<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}
