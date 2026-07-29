import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type {
  EventDetail,
  EventSummary,
  IssueDetail as IssueDetailModel,
  OperatorApi,
  WebhookDelivery,
} from "../api/client.js";
import { ConfirmDeleteDialog } from "../components/confirm-delete-dialog.js";
import { EventDetails } from "../components/event-details.js";
import { TimeValue } from "../components/time-value.js";

interface IssueDetailProps {
  readonly api: OperatorApi;
  readonly issueId: number;
  readonly requestedEventId: string | undefined;
  readonly onNavigate: (path: string) => void;
}

interface DetailState {
  readonly issue: IssueDetailModel;
  readonly events: readonly EventSummary[];
  readonly event: EventDetail | null;
  readonly nextEventCursor: string | null;
  readonly requestedEventMissing: boolean;
}

export function IssueDetail({
  api,
  issueId,
  requestedEventId,
  onNavigate,
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
    void Promise.all([api.getIssue(issueId), api.listIssueEvents(issueId)])
      .then(async ([issue, firstPage]) => {
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
        if (active) {
          setState({
            issue,
            events,
            event,
            nextEventCursor,
            requestedEventMissing:
              requestedEventId !== undefined && selected === undefined,
          });
        }
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
    } catch {
      setActionError(
        target === "resolved"
          ? "Resolve failed. The issue remains unresolved; try again."
          : "Reopen failed. The issue remains resolved; try again.",
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
      if (selectionRequest.current === request) {
        setState((current) =>
          current === null
            ? null
            : { ...current, event, requestedEventMissing: false },
        );
      }
    } catch {
      if (selectionRequest.current === request) {
        setActionError(
          "Occurrence details could not be loaded. Choose the occurrence and try again.",
        );
      }
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
    setRetryingDelivery(delivery.id);
    setActionError(null);
    setFeedback(null);
    try {
      const redrive = await api.retryDelivery(delivery.id);
      setState((current) => {
        if (current === null) return null;
        return {
          ...current,
          issue: {
            ...current.issue,
            deliveries: current.issue.deliveries.map((item) =>
              item.id === delivery.id
                ? { ...item, redrives: [...item.redrives, redrive] }
                : item,
            ),
          },
        };
      });
      setFeedback("Redrive queued.");
    } catch {
      setActionError(
        "Delivery retry failed. Correct the destination configuration, then try again.",
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
    setPendingAction("delete");
    setActionError(null);
    setFeedback(null);
    try {
      await api.deleteIssue(issueId);
      onNavigate("/");
    } catch {
      setDeleteOpen(false);
      setActionError(
        "Delete failed. No data was removed; check the private connection and try again.",
      );
      window.setTimeout(() => deleteButton.current?.focus(), 0);
    } finally {
      setPendingAction(null);
    }
  };

  const back = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    onNavigate("/");
  };

  if (state === null && !error) {
    return (
      <main id="main-content" className="page-content">
        <div className="state-panel" role="status">
          <span className="loading-mark" aria-hidden="true" />
          Loading issue evidence…
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main id="main-content" className="page-content">
        <div className="state-panel state-error" role="alert">
          <h1>Issue details could not be loaded</h1>
          <p>
            Issue details could not be loaded. Check the private connection and
            try again.
          </p>
          <button
            className="button button-primary"
            type="button"
            onClick={() => {
              setError(false);
              setRetry((value) => value + 1);
            }}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (state === null) return null;
  const selectedRowId = state.event?.id ?? -1;
  return (
    <div className="app-shell">
      <header className="detail-nav">
        <a href="/" onClick={back}>
          <span aria-hidden="true">←</span> All issues
        </a>
        <span className="detail-identity">
          {state.issue.project.slug} / {String(state.issue.id)}
        </span>
      </header>
      <main id="main-content" className="page-content detail-page">
        <header className="issue-detail-header">
          <div className="detail-title-block">
            <div className="detail-state-line">
              <span className={`status status-${state.issue.status}`}>
                {state.issue.status === "resolved" ? "Resolved" : "Unresolved"}
              </span>
              <span className={`severity severity-${state.issue.highestLevel}`}>
                {state.issue.highestLevel === "warn"
                  ? "Warning"
                  : state.issue.highestLevel === "fatal"
                    ? "Fatal"
                    : "Error"}
              </span>
            </div>
            <p className="eyebrow">{state.issue.project.name}</p>
            <h1>{state.issue.title}</h1>
            <dl className="detail-summary">
              <div>
                <dt>Events</dt>
                <dd>{String(state.issue.occurrenceCount)}</dd>
              </div>
              <div>
                <dt>First seen</dt>
                <dd>
                  <TimeValue value={state.issue.firstSeen} />
                </dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>
                  <TimeValue value={state.issue.lastSeen} />
                </dd>
              </div>
            </dl>
          </div>
          <div className="detail-actions" aria-label="Issue actions">
            {state.issue.status === "unresolved" ? (
              <button
                className="button button-primary"
                type="button"
                disabled={pendingAction !== null}
                onClick={() => void mutateStatus("resolved")}
              >
                {pendingAction === "resolved" ? "Resolving…" : "Resolve"}
              </button>
            ) : (
              <button
                className="button button-primary"
                type="button"
                disabled={pendingAction !== null}
                onClick={() => void mutateStatus("unresolved")}
              >
                {pendingAction === "unresolved" ? "Reopening…" : "Reopen"}
              </button>
            )}
            <a className="button" href={api.issueDownloadUrl(issueId)} download>
              Download
            </a>
            <button
              ref={deleteButton}
              className="button button-danger-quiet"
              type="button"
              onClick={() => setDeleteOpen(true)}
            >
              Delete permanently
            </button>
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
            <h2>Requested occurrence is no longer retained</h2>
            <p>
              This permalink identifies an occurrence outside the retained
              window. The issue summary remains available above.
            </p>
          </div>
        ) : state.event === null ? (
          <div className="state-panel">
            <h2>No retained occurrence evidence</h2>
            <p>
              Retention removed every event. Issue metadata remains until the
              next cleanup removes the empty issue.
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
    </div>
  );
}
