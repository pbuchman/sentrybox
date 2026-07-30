import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Facets, FacetValue } from "../api/client.js";
import { ISSUE_SORT_OPTIONS, issueSort } from "../issue-sort.js";
import { Icon } from "./icons.js";
import { useMedia } from "./use-media.js";

interface FilterBarProps {
  readonly facets: Facets;
  readonly filters: URLSearchParams;
  readonly onApply: (filters: URLSearchParams) => void;
  readonly onClear: () => void;
}

type MultiFilter = "release" | "environment" | "service" | "level";

const FILTER_GROUPS: readonly {
  readonly key: MultiFilter;
  readonly label: string;
  readonly facet: MultiFilter;
}[] = [
  { key: "release", label: "Release", facet: "release" },
  { key: "environment", label: "Environment", facet: "environment" },
  { key: "service", label: "Service", facet: "service" },
  { key: "level", label: "Level", facet: "level" },
];

export function FilterBar({
  facets,
  filters,
  onApply,
  onClear,
}: FilterBarProps) {
  const mobile = useMedia("(max-width: 760px)");
  const [open, setOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState(
    () => new URLSearchParams(filters),
  );
  const [query, setQuery] = useState(filters.get("query") ?? "");
  const openButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();

  const appliedQuery = filters.get("query") ?? "";

  useEffect(() => {
    setQuery(appliedQuery);
  }, [appliedQuery]);

  useEffect(() => {
    const current = filters.get("query") ?? "";
    if (query.trim() === current) return;
    const timeout = window.setTimeout(() => {
      const next = cleanCursor(new URLSearchParams(filters));
      const value = query.trim();
      if (value.length === 0) next.delete("query");
      else next.set("query", value);
      onApply(next);
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [filters, onApply, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        window.setTimeout(() => openButton.current?.focus(), 0);
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[data-filter-close]")?.focus();
    if (!mobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobile, open]);

  const update = (change: (next: URLSearchParams) => void): void => {
    const next = cleanCursor(new URLSearchParams(filters));
    change(next);
    onApply(next);
  };

  const updateDraft = (change: (next: URLSearchParams) => void): void => {
    setDraftFilters((current) => {
      const next = cleanCursor(new URLSearchParams(current));
      change(next);
      return next;
    });
  };

  const closeFilters = (): void => {
    setOpen(false);
    window.setTimeout(() => openButton.current?.focus(), 0);
  };

  const status = filters.get("status") ?? "unresolved";
  const sort = issueSort(filters.get("sort"));
  const activeFilters = activeFilterChips(filters, facets);

  return (
    <div className="issue-controls">
      <label className="issue-search">
        <Icon name="search" size={22} />
        <span className="sr-only">Search issues</span>
        <input
          aria-label="Search issues"
          type="search"
          placeholder="Search issues"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="control-toolbar">
        <div className="status-tabs" aria-label="Issue status">
          {[
            ["unresolved", "Open"],
            ["resolved", "Resolved"],
            ["all", "All"],
          ].map(([value, label]) => (
            <button
              key={label}
              className={status === value ? "is-active" : undefined}
              type="button"
              aria-pressed={status === value}
              onClick={() =>
                update((next) => {
                  next.set("status", value ?? "unresolved");
                })
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <button
            ref={openButton}
            className="button filter-trigger"
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              if (open) closeFilters();
              else {
                setDraftFilters(new URLSearchParams(filters));
                setOpen(true);
              }
            }}
          >
            <Icon name="filter" size={20} />
            Filters
            {activeFilters.length === 0 ? null : (
              <span className="filter-count">
                {String(activeFilters.length)}
              </span>
            )}
          </button>
          <label className="sort-control">
            <span className="sr-only">Sort issues</span>
            <select
              aria-label="Sort issues"
              value={sort}
              onChange={(event) =>
                update((next) => {
                  if (event.target.value === "last-desc") next.delete("sort");
                  else next.set("sort", event.target.value);
                })
              }
            >
              {ISSUE_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {activeFilters.length === 0 ? null : (
        <div className="active-filter-row" aria-label="Active filters">
          <div className="active-filter-chips">
            {activeFilters.map((filter) => (
              <button
                key={`${filter.key}-${filter.value}`}
                type="button"
                onClick={() =>
                  update((next) =>
                    removeQueryValue(next, filter.key, filter.value),
                  )
                }
              >
                {filter.label}
                <Icon name="close" size={16} />
              </button>
            ))}
          </div>
          <button className="clear-filter-link" type="button" onClick={onClear}>
            Clear all
          </button>
        </div>
      )}
      {open ? (
        <div
          className={mobile ? "filter-backdrop" : "filter-popover-anchor"}
          onMouseDown={(event) => {
            if (mobile && event.target === event.currentTarget) closeFilters();
          }}
        >
          <section
            ref={panel}
            className={mobile ? "filter-panel filter-sheet" : "filter-panel"}
            id={panelId}
            role="dialog"
            aria-modal={mobile ? "true" : undefined}
            aria-labelledby={`${panelId}-title`}
            onKeyDown={trapFocus}
          >
            <header className="filter-panel-header">
              <h2 id={`${panelId}-title`}>Filters</h2>
              <button
                className="icon-button"
                type="button"
                aria-label="Close filters"
                data-filter-close
                onClick={() => {
                  closeFilters();
                }}
              >
                <Icon name="close" size={22} />
              </button>
            </header>
            <div className="filter-groups">
              {FILTER_GROUPS.map((group) => (
                <FilterGroup
                  key={group.key}
                  label={group.label}
                  name={group.key}
                  options={facets[group.facet]}
                  selected={draftFilters.getAll(group.key)}
                  onToggle={(value) =>
                    updateDraft((next) =>
                      toggleQueryValue(next, group.key, value),
                    )
                  }
                />
              ))}
              <TimeRange
                filters={draftFilters}
                onChange={(from, to) =>
                  updateDraft((next) => {
                    if (from === null) next.delete("from");
                    else next.set("from", from);
                    if (to === null) next.delete("to");
                    else next.set("to", to);
                  })
                }
              />
            </div>
            <footer className="filter-panel-footer">
              <button
                className="button button-quiet"
                type="button"
                onClick={() =>
                  updateDraft((next) => {
                    for (const group of FILTER_GROUPS) next.delete(group.key);
                    next.delete("from");
                    next.delete("to");
                  })
                }
              >
                Clear
              </button>
              <button
                className="button button-primary"
                type="button"
                onClick={() => {
                  onApply(cleanCursor(new URLSearchParams(draftFilters)));
                  closeFilters();
                }}
              >
                Show issues
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function trapFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function FilterGroup({
  label,
  name,
  options,
  selected,
  onToggle,
}: {
  readonly label: string;
  readonly name: MultiFilter;
  readonly options: readonly FacetValue[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
}) {
  return (
    <fieldset className="filter-group">
      <legend>{label}</legend>
      {options.length === 0 ? (
        <p>No values in this project</p>
      ) : (
        <div className="filter-options">
          {options.map((option) => (
            <label key={option.queryValue}>
              <input
                type="checkbox"
                name={name}
                value={option.queryValue}
                checked={selected.includes(option.queryValue)}
                onChange={() => onToggle(option.queryValue)}
              />
              <span>{facetLabel(option)}</span>
              <span className="option-count">{String(option.count)}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function TimeRange({
  filters,
  onChange,
}: {
  readonly filters: URLSearchParams;
  readonly onChange: (from: string | null, to: string | null) => void;
}) {
  const range = rangeValue(filters.get("from"), filters.get("to"));
  return (
    <fieldset className="filter-group time-range-group">
      <legend>Time range</legend>
      <label className="filter-select-row">
        <span className="sr-only">Time range</span>
        <select
          aria-label="Time range"
          value={range}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "any") onChange(null, null);
            else if (value !== "custom") {
              const days = value === "24h" ? 1 : value === "7d" ? 7 : 30;
              onChange(
                new Date(Date.now() - days * 86_400_000).toISOString(),
                null,
              );
            }
          }}
        >
          <option value="any">All retained</option>
          <option value="24h">Past 24 hours</option>
          <option value="7d">Past 7 days</option>
          <option value="30d">Past 30 days</option>
          {range === "custom" ? (
            <option value="custom">Custom range</option>
          ) : null}
        </select>
      </label>
      {range === "custom" ? (
        <div className="custom-time-range">
          <label>
            From (UTC)
            <input
              type="datetime-local"
              value={isoToUtcInput(filters.get("from"))}
              onChange={(event) =>
                onChange(utcInputToIso(event.target.value), filters.get("to"))
              }
            />
          </label>
          <label>
            To (UTC)
            <input
              type="datetime-local"
              value={isoToUtcInput(filters.get("to"))}
              onChange={(event) =>
                onChange(filters.get("from"), utcInputToIso(event.target.value))
              }
            />
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}

function activeFilterChips(filters: URLSearchParams, facets: Facets) {
  const chips: { key: MultiFilter; value: string; label: string }[] = [];
  for (const group of FILTER_GROUPS) {
    for (const value of filters.getAll(group.key)) {
      const option = facets[group.facet].find(
        (item) => item.queryValue === value,
      );
      chips.push({
        key: group.key,
        value,
        label: option === undefined ? value : facetLabel(option),
      });
    }
  }
  if (filters.has("from") || filters.has("to")) {
    chips.push({
      key: "release",
      value: "__time__",
      label: timeRangeLabel(filters),
    });
  }
  return chips;
}

function timeRangeLabel(filters: URLSearchParams): string {
  const value = rangeValue(filters.get("from"), filters.get("to"));
  if (value === "24h") return "Past 24 hours";
  if (value === "7d") return "Past 7 days";
  if (value === "30d") return "Past 30 days";
  return "Custom time range";
}

function rangeValue(from: string | null, to: string | null): string {
  if (from === null && to === null) return "any";
  if (from === null || to !== null) return "custom";
  const difference = Date.now() - Date.parse(from);
  const day = 86_400_000;
  if (Math.abs(difference - day) < 60_000) return "24h";
  if (Math.abs(difference - 7 * day) < 60_000) return "7d";
  if (Math.abs(difference - 30 * day) < 60_000) return "30d";
  return "custom";
}

function facetLabel(value: FacetValue): string {
  const label = value.label ?? value.value ?? "Unknown";
  return /^[0-9a-f]{16,}$/iu.test(label) ? label.slice(0, 8) : label;
}

function toggleQueryValue(
  next: URLSearchParams,
  key: string,
  value: string,
): void {
  const values = next.getAll(key);
  next.delete(key);
  for (const current of values) {
    if (current !== value) next.append(key, current);
  }
  if (!values.includes(value)) next.append(key, value);
}

function removeQueryValue(
  next: URLSearchParams,
  key: string,
  value: string,
): void {
  if (value === "__time__") {
    next.delete("from");
    next.delete("to");
    return;
  }
  const values = next.getAll(key);
  next.delete(key);
  for (const current of values)
    if (current !== value) next.append(key, current);
}

function cleanCursor(next: URLSearchParams): URLSearchParams {
  next.delete("cursor");
  return next;
}

function isoToUtcInput(value: string | null): string {
  if (value === null || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toISOString().slice(0, 16);
}

function utcInputToIso(value: string): string | null {
  if (value.length === 0) return null;
  const parsed = new Date(`${value}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
