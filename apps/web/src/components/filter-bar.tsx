import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Facets, FacetValue } from "../api/client.js";
import { useMedia } from "./use-media.js";

interface FilterBarProps {
  readonly facets: Facets;
  readonly filters: URLSearchParams;
  readonly onApply: (filters: URLSearchParams) => void;
  readonly onClear: () => void;
}

type MultiFilter = "project" | "release" | "environment" | "service" | "level";

const MULTI_FILTERS: readonly {
  readonly key: MultiFilter;
  readonly label: string;
  readonly facet: keyof Pick<
    Facets,
    "project" | "release" | "environment" | "service" | "level"
  >;
}[] = [
  { key: "project", label: "Project", facet: "project" },
  { key: "release", label: "Version", facet: "release" },
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
  const mobile = useMedia("(max-width: 700px)");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => filterDraft(filters));
  const openButton = useRef<HTMLButtonElement>(null);
  const firstFilter = useRef<HTMLSelectElement>(null);
  const sheetId = useId();

  useEffect(() => {
    setDraft(filterDraft(filters));
  }, [filters]);

  useEffect(() => {
    if (!open) return;
    firstFilter.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        window.setTimeout(() => openButton.current?.focus(), 0);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const { key } of MULTI_FILTERS) {
      for (const value of draft[key]) next.append(key, value);
    }
    if (draft.status.length > 0) next.append("status", draft.status);
    const search = draft.query.trim();
    if (search.length > 0) next.set("query", search);
    const from = utcInputToIso(draft.from);
    const to = utcInputToIso(draft.to);
    if (from !== null) next.set("from", from);
    if (to !== null) next.set("to", to);
    onApply(next);
    setOpen(false);
    if (mobile) window.setTimeout(() => openButton.current?.focus(), 0);
  };

  const form = (
    <form className="filter-form" role="search" onSubmit={submit}>
      <p className="sr-only" id={`${sheetId}-multi-help`}>
        Hold Control or Command to select more than one value in a filter.
      </p>
      <div className="filter-fields">
        {MULTI_FILTERS.map(({ key, label, facet }, index) => (
          <FacetSelect
            key={key}
            label={label}
            values={facets[facet]}
            selected={draft[key]}
            {...(index === 0 ? { inputRef: firstFilter } : {})}
            helpId={`${sheetId}-multi-help`}
            onChange={(values) => {
              setDraft((current) => ({ ...current, [key]: values }));
            }}
          />
        ))}
        <label className="filter-field">
          <span>Status</span>
          <select
            aria-label="Status"
            value={draft.status}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                status: event.target.value,
              }));
            }}
          >
            <option value="">All statuses</option>
            <option value="unresolved">Unresolved</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label className="filter-field filter-search">
          <span>Search</span>
          <input
            aria-label="Search"
            type="search"
            value={draft.query}
            placeholder="Title, message, exception"
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                query: event.target.value,
              }));
            }}
          />
        </label>
        <label className="filter-field">
          <span>From (UTC)</span>
          <input
            aria-label="From (UTC)"
            type="datetime-local"
            step="0.001"
            value={draft.from}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                from: event.target.value,
              }));
            }}
          />
        </label>
        <label className="filter-field">
          <span>To (UTC)</span>
          <input
            aria-label="To (UTC)"
            type="datetime-local"
            step="0.001"
            value={draft.to}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                to: event.target.value,
              }));
            }}
          />
        </label>
      </div>
      <div className="filter-actions">
        <button className="button button-primary" type="submit">
          Apply filters
        </button>
        <button className="button button-quiet" type="button" onClick={onClear}>
          Reset filters
        </button>
        {mobile ? (
          <button
            className="button button-quiet"
            type="button"
            onClick={() => {
              setOpen(false);
              window.setTimeout(() => openButton.current?.focus(), 0);
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );

  if (!mobile) return <div className="filter-bar">{form}</div>;
  return (
    <>
      <button
        ref={openButton}
        className="button filter-open"
        type="button"
        aria-expanded={open}
        aria-controls={sheetId}
        onClick={() => setOpen(true)}
      >
        Open filters
      </button>
      {open ? (
        <div className="sheet-backdrop">
          <section
            className="filter-sheet"
            id={sheetId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${sheetId}-title`}
            onKeyDown={trapFocus}
          >
            <header className="sheet-header">
              <div>
                <p className="eyebrow">Issue scope</p>
                <h2 id={`${sheetId}-title`}>Filter issues</h2>
              </div>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => {
                  setOpen(false);
                  window.setTimeout(() => openButton.current?.focus(), 0);
                }}
              >
                Close filters
              </button>
            </header>
            {form}
          </section>
        </div>
      ) : null}
    </>
  );
}

interface FacetSelectProps {
  readonly label: string;
  readonly values: readonly FacetValue[];
  readonly selected: readonly string[];
  readonly helpId: string;
  readonly inputRef?: React.RefObject<HTMLSelectElement | null>;
  readonly onChange: (values: readonly string[]) => void;
}

function FacetSelect({
  label,
  values,
  selected,
  helpId,
  inputRef,
  onChange,
}: FacetSelectProps) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <select
        ref={inputRef}
        aria-label={label}
        aria-describedby={helpId}
        multiple
        value={[...selected]}
        onChange={(event) => {
          onChange(
            Array.from(event.target.selectedOptions, (option) => option.value),
          );
        }}
      >
        {values.map((value) => (
          <option key={value.queryValue} value={value.queryValue}>
            {facetLabel(value)} ({String(value.count)})
          </option>
        ))}
      </select>
    </label>
  );
}

function facetLabel(value: FacetValue): string {
  return value.label ?? value.value ?? "Unknown";
}

interface FilterDraft {
  readonly project: readonly string[];
  readonly release: readonly string[];
  readonly environment: readonly string[];
  readonly service: readonly string[];
  readonly level: readonly string[];
  readonly status: string;
  readonly query: string;
  readonly from: string;
  readonly to: string;
}

function filterDraft(filters: URLSearchParams): FilterDraft {
  return {
    project: filters.getAll("project"),
    release: filters.getAll("release"),
    environment: filters.getAll("environment"),
    service: filters.getAll("service"),
    level: filters.getAll("level"),
    status: filters.get("status") ?? "unresolved",
    query: filters.get("query") ?? "",
    from: isoToUtcInput(filters.get("from")),
    to: isoToUtcInput(filters.get("to")),
  };
}

function isoToUtcInput(value: string | null): string {
  if (value === null || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toISOString().slice(0, -1);
}

function utcInputToIso(value: string): string | null {
  if (value.length === 0) return null;
  const parsed = new Date(`${value}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function trapFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
