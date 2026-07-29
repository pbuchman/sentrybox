import { useEffect, useMemo, useState } from "react";
import { createApiClient, type OperatorApi } from "./api/client.js";
import { IssueDetail } from "./routes/issue-detail.js";
import { IssueList } from "./routes/issue-list.js";
import "./styles/tokens.css";
import "./styles/app.css";

interface AppProps {
  readonly api?: OperatorApi;
}

const ISSUE_PATH =
  /^\/organizations\/intexuraos\/issues\/([1-9]\d*)\/(?:events\/([^/]+)\/)?$/u;

export function App({ api: suppliedApi }: AppProps) {
  const api = useMemo(() => suppliedApi ?? createApiClient(), [suppliedApi]);
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const navigate = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);

  const navigate = (next: string): void => {
    window.history.pushState({}, "", next);
    setPath(window.location.pathname);
    if (!navigator.userAgent.includes("jsdom")) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  };

  const match = path.match(ISSUE_PATH);
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to issue evidence
      </a>
      {match?.[1] === undefined ? (
        <IssueList api={api} onNavigate={navigate} />
      ) : (
        <IssueDetail
          api={api}
          issueId={Number(match[1])}
          requestedEventId={decodePathSegment(match[2])}
          onNavigate={navigate}
        />
      )}
    </>
  );
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
