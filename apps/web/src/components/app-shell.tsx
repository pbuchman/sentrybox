import type { ReactNode } from "react";
import type { FacetValue, SystemStatus } from "../api/client.js";
import { Icon } from "./icons.js";
import { useMedia } from "./use-media.js";

interface AppShellProps {
  readonly projects: readonly FacetValue[];
  readonly activeProjectSlug: string | null;
  readonly system: SystemStatus | null;
  readonly onSelectProject: (slug: string) => void;
  readonly children: ReactNode;
}

export function AppShell({
  projects,
  activeProjectSlug,
  system,
  onSelectProject,
  children,
}: AppShellProps) {
  const mobile = useMedia("(max-width: 760px)");
  const active = projects.find(
    (project) => project.queryValue === activeProjectSlug,
  );
  const healthy =
    system?.status === "ok" &&
    system.ingest.accepting &&
    system.outbox.deadLetter === 0;

  return (
    <div className="product-shell">
      {mobile ? null : (
        <aside className="project-rail" aria-label="Project navigation">
          <a className="brand" href="/">
            <Icon name="box" className="brand-icon" size={30} />
            <span>SentryBox</span>
          </a>
          <nav className="project-navigation" aria-label="Projects">
            <h2>Projects</h2>
            {projects.length === 0 ? (
              <p className="rail-empty">No retained project activity</p>
            ) : (
              <ul>
                {projects.map((project) => (
                  <li key={project.queryValue}>
                    <button
                      className={
                        project.queryValue === activeProjectSlug
                          ? "project-link is-active"
                          : "project-link"
                      }
                      type="button"
                      aria-current={
                        project.queryValue === activeProjectSlug
                          ? "page"
                          : undefined
                      }
                      onClick={() => onSelectProject(project.queryValue)}
                    >
                      <span className="project-avatar" aria-hidden="true">
                        {(project.label ?? project.value ?? "P")
                          .slice(0, 1)
                          .toUpperCase()}
                      </span>
                      <span>{project.label ?? project.value ?? "Unknown"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <div
            className={healthy ? "system-state is-healthy" : "system-state"}
            aria-live="polite"
          >
            {healthy ? (
              <Icon name="check-circle" size={20} />
            ) : (
              <Icon name="error" size={20} />
            )}
            <span>
              {system === null ? "System unavailable" : systemLabel(system)}
            </span>
          </div>
        </aside>
      )}
      {mobile ? (
        <div className="mobile-app-header">
          <a className="brand" href="/">
            <Icon name="box" className="brand-icon" size={28} />
            <span>SentryBox</span>
          </a>
        </div>
      ) : null}
      <div className="product-main">
        {mobile ? (
          <label className="mobile-project-picker">
            <span className="sr-only">Active project</span>
            <span className="project-avatar" aria-hidden="true">
              {(active?.label ?? active?.value ?? "P")
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <select
              aria-label="Active project"
              value={activeProjectSlug ?? ""}
              onChange={(event) => onSelectProject(event.target.value)}
            >
              <option value="" disabled>
                Select a project
              </option>
              {projects.map((project) => (
                <option key={project.queryValue} value={project.queryValue}>
                  {project.label ?? project.value ?? "Unknown"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function systemLabel(system: SystemStatus): string {
  if (system.status === "critical") return "System needs attention";
  if (!system.ingest.accepting) return "Ingest paused";
  if (system.outbox.deadLetter > 0) {
    return `${String(system.outbox.deadLetter)} failed deliveries`;
  }
  if (system.status === "not_ready") return "System starting";
  return "System healthy";
}
