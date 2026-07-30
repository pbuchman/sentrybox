import { useEffect, useMemo, useState } from "react";
import { createApiClient, type OperatorApi } from "./api/client.js";
import { IssueDetail } from "./routes/issue-detail.js";
import { IssueList } from "./routes/issue-list.js";
import "./styles/tokens.css";
import "./styles/app.css";

interface AppProps {
  readonly api?: OperatorApi;
  readonly readOnly?: boolean;
}

const SENTRY_ISSUE_PATH =
  /^\/organizations\/[^/]+\/issues\/([1-9]\d*)\/(?:events\/([^/]+)\/)?$/u;

interface LocationState {
  readonly pathname: string;
  readonly search: string;
}

interface IssueRoute {
  readonly issueId: number;
  readonly eventId: string | undefined;
}

export function App({ api: suppliedApi, readOnly = false }: AppProps) {
  const api = useMemo(() => suppliedApi ?? createApiClient(), [suppliedApi]);
  const [location, setLocation] = useState(readLocation);

  useEffect(() => {
    const navigate = (): void => setLocation(readLocation());
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);

  const navigate = (next: string): void => {
    window.history.pushState({}, "", next);
    setLocation(readLocation());
    if (!navigator.userAgent.includes("jsdom")) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  };

  const route = issueRoute(location);
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      {route === null ? (
        <IssueList api={api} onNavigate={navigate} />
      ) : (
        <IssueDetail
          api={api}
          issueId={route.issueId}
          requestedEventId={route.eventId}
          readOnly={readOnly}
          onNavigate={navigate}
        />
      )}
    </>
  );
}

function readLocation(): LocationState {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

function issueRoute(location: LocationState): IssueRoute | null {
  const sentryMatch = location.pathname.match(SENTRY_ISSUE_PATH);
  if (sentryMatch?.[1] !== undefined) {
    return {
      issueId: Number(sentryMatch[1]),
      eventId: decodePathSegment(sentryMatch[2]),
    };
  }
  if (location.pathname !== "/") return null;
  const query = new URLSearchParams(location.search);
  const issueId = query.get("issue");
  if (issueId === null || !/^[1-9]\d*$/u.test(issueId)) return null;
  return {
    issueId: Number(issueId),
    eventId: query.get("event") ?? undefined,
  };
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
