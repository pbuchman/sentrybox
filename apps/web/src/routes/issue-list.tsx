import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Facets,
  IssueListItem,
  OperatorApi,
  SystemStatus,
} from "../api/client.js";
import { AppShell } from "../components/app-shell.js";
import { FilterBar } from "../components/filter-bar.js";
import { Icon } from "../components/icons.js";
import { IssueRow } from "../components/issue-row.js";
import { useMedia } from "../components/use-media.js";
import { issueSort, type IssueSort } from "../issue-sort.js";

interface IssueListProps {
  readonly api: OperatorApi;
  readonly onNavigate: (path: string) => void;
}

interface CatalogState {
  readonly projects: Facets["project"];
  readonly system: SystemStatus | null;
}

interface ListState {
  readonly items: readonly IssueListItem[];
  readonly facets: Facets;
  readonly nextCursor: string | null;
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
  const mobile = useMedia("(max-width: 760px)");
  const [filters, setFilters] = useState(defaultFilters);
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [state, setState] = useState<ListState | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const activeProjectSlug = filters.get("project");
  const activeProject = catalog?.projects.find(
    (project) => project.queryValue === activeProjectSlug,
  );

  useEffect(() => {
    let active = true;
    setCatalogError(false);
    void Promise.allSettled([
      api.getFacets(new URLSearchParams()),
      api.getSystemStatus(),
    ]).then(([facetsResult, systemResult]) => {
      if (!active) return;
      if (facetsResult.status === "rejected") {
        setCatalogError(true);
        return;
      }
      setCatalog({
        projects: facetsResult.value.project,
        system: systemResult.status === "fulfilled" ? systemResult.value : null,
      });
    });
    return () => {
      active = false;
    };
  }, [api, retry]);

  const selectProject = useCallback((slug: string): void => {
    const next = new URLSearchParams();
    next.set("project", slug);
    next.set("status", "unresolved");
    updateQuery(next);
    setFilters(next);
    setState(null);
    setLoadMoreError(false);
  }, []);

  useEffect(() => {
    if (
      catalog?.projects.length === 1 &&
      activeProjectSlug === null &&
      catalog.projects[0] !== undefined
    ) {
      selectProject(catalog.projects[0].queryValue);
    }
  }, [activeProjectSlug, catalog, selectProject]);

  useEffect(() => {
    if (activeProjectSlug === null || catalog === null) {
      setState(null);
      return;
    }
    let active = true;
    setError(false);
    setState(null);
    const sort = issueSort(filters.get("sort"));
    const apiFilters = apiFiltersFor(filters);
    const facetsRequest = api.getFacets(facetCatalogScope(filters));
    void Promise.all([listForSort(api, apiFilters, sort), facetsRequest])
      .then(([page, facets]) => {
        if (!active) return;
        setState({
          items: sortIssues(page.items, sort),
          facets,
          nextCursor: page.nextCursor,
        });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [activeProjectSlug, api, catalog, filters, retry]);

  const applyFilters = useCallback((next: URLSearchParams): void => {
    updateQuery(next);
    setState(null);
    setLoadMoreError(false);
    setFilters(new URLSearchParams(next));
  }, []);

  const clearFilters = useCallback((): void => {
    if (activeProjectSlug === null) return;
    const next = new URLSearchParams([
      ["project", activeProjectSlug],
      ["status", "unresolved"],
    ]);
    applyFilters(next);
  }, [activeProjectSlug, applyFilters]);

  const loadMore = async (): Promise<void> => {
    if (state?.nextCursor === null || state === null) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    const next = apiFiltersFor(filters);
    next.set("cursor", state.nextCursor);
    try {
      const page = await api.listIssues(next);
      setState((current) => {
        if (current === null) return null;
        return {
          ...current,
          items: [...current.items, ...page.items],
          nextCursor: page.nextCursor,
        };
      });
    } catch {
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const projectName = activeProject?.label ?? activeProject?.value ?? null;
  const resultLabel = useMemo(() => {
    if (state === null) return "";
    return `${String(state.items.length)} issue${state.items.length === 1 ? "" : "s"}${state.nextCursor === null ? "" : "+"}`;
  }, [state]);

  if (catalog === null && !catalogError) {
    return <LoadingScreen label="Loading projects…" />;
  }
  if (catalogError || catalog === null) {
    return (
      <ErrorScreen
        title="Projects could not be loaded"
        message="SentryBox could not reach the private project catalog."
        onRetry={() => setRetry((value) => value + 1)}
      />
    );
  }

  return (
    <AppShell
      projects={catalog.projects}
      activeProjectSlug={activeProjectSlug}
      system={catalog.system}
      onSelectProject={selectProject}
    >
      <main id="main-content" className="issues-page">
        {activeProject === undefined ? (
          <ProjectChooser
            projects={catalog.projects}
            onSelectProject={selectProject}
          />
        ) : (
          <>
            <header className="issues-heading">
              <p className="project-context">{projectName}</p>
              <h1>Issues</h1>
            </header>
            <FilterBar
              facets={state?.facets ?? EMPTY_FACETS}
              filters={filters}
              onApply={applyFilters}
              onClear={clearFilters}
            />
            {state === null && !error ? (
              <IssueSkeleton
                label={
                  filters.has("sort")
                    ? "Loading and sorting this project…"
                    : "Loading current issues…"
                }
              />
            ) : null}
            {error ? (
              <ErrorPanel
                title="Issues could not be loaded"
                message="Check the private deployment connection and try again."
                onRetry={() => setRetry((value) => value + 1)}
              />
            ) : null}
            {state !== null && state.items.length === 0 ? (
              <div className="empty-state">
                <h2>No issues match these filters</h2>
                <p>
                  Clear the current filters to return to open issues in this
                  project.
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
            {state !== null && state.items.length > 0 ? (
              <section className="issue-results" aria-labelledby="result-count">
                <p id="result-count" className="result-count">
                  {resultLabel}
                </p>
                {!mobile ? (
                  <table aria-label="Issues">
                    <thead>
                      <tr>
                        <th className="severity-cell">
                          <span className="sr-only">Severity</span>
                        </th>
                        <th>Issue</th>
                        <th>Events</th>
                        <th>Last activity</th>
                        <th className="row-action-cell">
                          <span className="sr-only">Open</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.items.map((issue) => (
                        <IssueRow
                          key={issue.id}
                          issue={issue}
                          variant="table"
                          onNavigate={onNavigate}
                        />
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="issue-card-list" aria-label="Issues">
                    {state.items.map((issue) => (
                      <IssueRow
                        key={issue.id}
                        issue={issue}
                        variant="card"
                        onNavigate={onNavigate}
                      />
                    ))}
                  </div>
                )}
              </section>
            ) : null}
            {loadMoreError ? (
              <div className="pagination-error" role="alert">
                <p>
                  More issues could not be loaded. Current results remain
                  available.
                </p>
                <button
                  className="button"
                  type="button"
                  onClick={() => void loadMore()}
                >
                  Try again
                </button>
              </div>
            ) : state?.nextCursor === null ||
              state?.nextCursor === undefined ? null : (
              <div className="pagination">
                <button
                  className="button"
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </AppShell>
  );
}

function ProjectChooser({
  projects,
  onSelectProject,
}: {
  readonly projects: Facets["project"];
  readonly onSelectProject: (slug: string) => void;
}) {
  return (
    <section className="project-chooser">
      <Icon name="box" size={42} />
      <h1>Choose a project</h1>
      <p>Issues, filters and releases are always scoped to one project.</p>
      {projects.length === 0 ? (
        <div className="empty-state">
          <h2>No project activity yet</h2>
          <p>Projects appear here after SentryBox retains their first event.</p>
        </div>
      ) : (
        <div className="project-choice-list">
          {projects.map((project) => (
            <button
              key={project.queryValue}
              type="button"
              onClick={() => onSelectProject(project.queryValue)}
            >
              <span className="project-avatar" aria-hidden="true">
                {(project.label ?? project.value ?? "P")
                  .slice(0, 1)
                  .toUpperCase()}
              </span>
              <span>{project.label ?? project.value ?? "Unknown"}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function IssueSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="issue-skeleton" role="status" aria-live="polite">
      <span>{label}</span>
      {[1, 2, 3, 4].map((row) => (
        <span key={row} className="skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

function LoadingScreen({ label }: { readonly label: string }) {
  return (
    <main id="main-content" className="standalone-state" role="status">
      <Icon name="box" size={38} />
      <p>{label}</p>
    </main>
  );
}

function ErrorScreen({
  title,
  message,
  onRetry,
}: {
  readonly title: string;
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <main id="main-content" className="standalone-state" role="alert">
      <h1>{title}</h1>
      <p>{message}</p>
      <button className="button button-primary" type="button" onClick={onRetry}>
        Try again
      </button>
    </main>
  );
}

function ErrorPanel({
  title,
  message,
  onRetry,
}: {
  readonly title: string;
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="empty-state state-error" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      <button className="button button-primary" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

async function listForSort(
  api: OperatorApi,
  filters: URLSearchParams,
  sort: IssueSort,
) {
  const first = await api.listIssues(filters);
  if (sort === "last-desc" || first.nextCursor === null) return first;
  const items = [...first.items];
  let cursor: string | null = first.nextCursor;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const next = new URLSearchParams(filters);
    next.set("cursor", cursor);
    const page = await api.listIssues(next);
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  return { ...first, items, nextCursor: null };
}

function sortIssues(items: readonly IssueListItem[], sort: IssueSort) {
  if (sort === "last-desc") return items;
  const severity = { warn: 1, error: 2, fatal: 3 } as const;
  return items.toSorted((left, right) => {
    if (sort === "last-asc") return left.lastSeen.localeCompare(right.lastSeen);
    if (sort === "first-desc")
      return right.firstSeen.localeCompare(left.firstSeen);
    if (sort === "first-asc")
      return left.firstSeen.localeCompare(right.firstSeen);
    if (sort === "events-desc") return right.matchingCount - left.matchingCount;
    if (sort === "events-asc") return left.matchingCount - right.matchingCount;
    if (sort === "severity-desc") {
      return (
        severity[right.highestLevel] - severity[left.highestLevel] ||
        right.lastSeen.localeCompare(left.lastSeen)
      );
    }
    return 0;
  });
}

function defaultFilters(): URLSearchParams {
  const filters = new URLSearchParams(window.location.search);
  if (!isIssueStatus(filters.get("status"))) {
    filters.set("status", "unresolved");
  }
  const sort = filters.get("sort");
  if (sort === "last-desc" || issueSort(sort) === "last-desc") {
    filters.delete("sort");
  }
  filters.delete("cursor");
  filters.delete("issue");
  filters.delete("event");
  updateQuery(filters);
  return filters;
}

function apiFiltersFor(filters: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(filters);
  next.delete("sort");
  next.delete("cursor");
  if (next.get("status") === "all") next.delete("status");
  if (issueSort(filters.get("sort")) !== "last-desc") next.set("limit", "100");
  return next;
}

function isIssueStatus(value: string | null): boolean {
  return value === "all" || value === "unresolved" || value === "resolved";
}

function facetCatalogScope(filters: URLSearchParams): URLSearchParams {
  const scope = new URLSearchParams();
  const project = filters.get("project");
  const status = filters.get("status");
  if (project !== null) scope.set("project", project);
  if (status !== null && status !== "all") scope.set("status", status);
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
