import { useEffect, useState } from "react";
import type {
  Facets,
  IssueDetail,
  IssueListItem,
  OperatorApi,
  SystemStatus,
} from "../api/client.js";
import { FilterBar } from "../components/filter-bar.js";
import { IssueRow } from "../components/issue-row.js";
import { useMedia } from "../components/use-media.js";

interface IssueListProps {
  readonly api: OperatorApi;
  readonly onNavigate: (path: string) => void;
}

interface ListState {
  readonly items: readonly IssueListItem[];
  readonly facets: Facets;
  readonly nextCursor: string | null;
  readonly system: SystemStatus | null;
  readonly details: Readonly<Record<number, IssueDetail>>;
}

const EMPTY_FACETS: Facets = {
  project: [],
  release: [],
  environment: [],
  service: [],
  level: [],
  status: [],
};

export function IssueList({ api, onNavigate }: IssueListProps) {
  const mobile = useMedia("(max-width: 700px)");
  const [filters, setFilters] = useState(defaultFilters);
  const [state, setState] = useState<ListState | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);

  useEffect(() => {
    let active = true;
    setError(false);
    void Promise.allSettled([
      api.listIssues(filters),
      api.getSystemStatus(),
      api.getFacets(facetCatalogScope(filters)),
    ])
      .then(async ([issuesResult, systemResult, facetsResult]) => {
        if (issuesResult.status === "rejected") {
          if (active) setError(true);
          return;
        }
        const response = issuesResult.value;
        const detailResults = await Promise.allSettled(
          response.items.map(async (issue) => api.getIssue(issue.id)),
        );
        const details: Record<number, IssueDetail> = {};
        for (const result of detailResults) {
          if (result.status === "fulfilled") {
            details[result.value.id] = result.value;
          }
        }
        if (!active) return;
        setState({
          items: response.items,
          facets:
            facetsResult.status === "fulfilled"
              ? facetsResult.value
              : response.facets,
          nextCursor: response.nextCursor,
          system:
            systemResult.status === "fulfilled" ? systemResult.value : null,
          details,
        });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [api, filters, retry]);

  const applyFilters = (next: URLSearchParams): void => {
    if (!next.has("status")) next.set("status", "unresolved");
    updateQuery(next);
    setState(null);
    setLoadMoreError(false);
    setFilters(new URLSearchParams(next));
  };

  const clearFilters = (): void => {
    applyFilters(new URLSearchParams([["status", "unresolved"]]));
  };

  const loadMore = async (): Promise<void> => {
    if (state?.nextCursor === null || state === null) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    const next = new URLSearchParams(filters);
    next.set("cursor", state.nextCursor);
    try {
      const page = await api.listIssues(next);
      const detailResults = await Promise.allSettled(
        page.items.map(async (issue) => api.getIssue(issue.id)),
      );
      const details = { ...state.details };
      for (const result of detailResults) {
        if (result.status === "fulfilled") {
          details[result.value.id] = result.value;
        }
      }
      setState({
        ...state,
        items: [...state.items, ...page.items],
        nextCursor: page.nextCursor,
        details,
      });
    } catch {
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="app-shell">
      <OperatorHeader state={state} />
      <main id="main-content" className="page-content">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Private operator view</p>
            <h1>Issues</h1>
            <p>Failures ordered by the most recent retained occurrence.</p>
          </div>
          <FilterBar
            facets={state?.facets ?? EMPTY_FACETS}
            filters={filters}
            onApply={applyFilters}
            onClear={clearFilters}
          />
        </div>
        {state === null && !error ? (
          <div className="state-panel" role="status" aria-live="polite">
            <span className="loading-mark" aria-hidden="true" />
            Loading current issues…
          </div>
        ) : null}
        {error ? (
          <div className="state-panel state-error" role="alert">
            <h2>Issues could not be loaded</h2>
            <p>
              Issues could not be loaded. Check the private connection and try
              again.
            </p>
            <button
              className="button button-primary"
              type="button"
              onClick={() => {
                setState(null);
                setRetry((value) => value + 1);
              }}
            >
              Try again
            </button>
          </div>
        ) : null}
        {state !== null && state.items.length === 0 ? (
          <div className="state-panel">
            <h2>No issues match these filters</h2>
            <p>
              The retained window has no events in this scope. Clear filters to
              return to unresolved issues.
            </p>
            <button
              className="button button-primary"
              type="button"
              onClick={clearFilters}
            >
              Clear filters
            </button>
          </div>
        ) : null}
        {state !== null && state.items.length > 0 && !mobile ? (
          <div className="table-surface">
            <table aria-label="Issues">
              <thead>
                <tr>
                  <th className="signal-cell">
                    <span className="sr-only">Signal</span>
                  </th>
                  <th>Issue</th>
                  <th>Events</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    facets={rowFacets(state, issue.id)}
                    variant="table"
                    onNavigate={onNavigate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {state !== null && state.items.length > 0 && mobile ? (
          <div className="issue-card-list" aria-label="Issues">
            {state.items.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                facets={rowFacets(state, issue.id)}
                variant="card"
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ) : null}
        {loadMoreError ? (
          <div className="pagination-error" role="alert">
            <p>
              More issues could not be loaded. The current results are still
              available.
            </p>
            <button
              className="button"
              type="button"
              onClick={() => void loadMore()}
            >
              Retry more issues
            </button>
          </div>
        ) : state?.nextCursor !== null && state?.nextCursor !== undefined ? (
          <div className="pagination">
            <button
              className="button"
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading more…" : "Load more issues"}
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function OperatorHeader({ state }: { readonly state: ListState | null }) {
  const unresolved =
    state?.items.filter((issue) => issue.status === "unresolved").length ??
    null;
  return (
    <header className="operator-header">
      <a className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">
          SB
        </span>
        <span>SentryBox</span>
      </a>
      <div className="header-evidence" aria-live="polite">
        <span>
          {unresolved === null
            ? "Shown —"
            : `Shown ${String(state?.items.length ?? 0)} · Unresolved shown ${String(unresolved)}`}
        </span>
        <span>{storageLabel(state?.system?.storage)}</span>
      </div>
    </header>
  );
}

function rowFacets(
  state: ListState,
  issueId: number,
): Pick<Facets, "environment" | "release" | "service"> | null {
  const detail = state.details[issueId];
  if (detail === undefined) return null;
  return {
    environment: detail.facets.environment,
    release: detail.facets.release,
    service: detail.facets.service,
  };
}

function storageLabel(
  storage: SystemStatus["storage"] | null | undefined,
): string {
  if (storage == null || storage.physicalBytes === null) {
    return "Storage unavailable";
  }
  return `Storage ${gib(storage.physicalBytes)} / ${gib(storage.budgetBytes)} GiB`;
}

function gib(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function defaultFilters(): URLSearchParams {
  const filters = new URLSearchParams(window.location.search);
  if (!filters.has("status")) {
    filters.set("status", "unresolved");
    updateQuery(filters);
  }
  return filters;
}

function facetCatalogScope(filters: URLSearchParams): URLSearchParams {
  const scope = new URLSearchParams();
  for (const status of filters.getAll("status")) scope.append("status", status);
  return scope;
}

function updateQuery(filters: URLSearchParams): void {
  const query = filters.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query.length === 0 ? "" : `?${query}`}`,
  );
}
