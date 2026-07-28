import { Buffer } from "node:buffer";

const NULLABLE_FACET_PREFIX = "~v1:";
const NULLABLE_FACET_NULL = `${NULLABLE_FACET_PREFIX}n`;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
const MAX_FILTER_VALUES = 20;
const MAX_FILTER_VALUE_LENGTH = 1_024;
const MAX_NULLABLE_FILTER_TOKEN_LENGTH = 6 + 4 * MAX_FILTER_VALUE_LENGTH;
const MAX_QUERY_LENGTH = 1_024;
const MAX_CURSOR_LENGTH = 2_048;
const CURSOR_VERSION = 1;

export interface PrivateFilters {
  readonly project: readonly string[];
  readonly release: readonly (string | null)[];
  readonly environment: readonly string[];
  readonly service: readonly (string | null)[];
  readonly level: readonly string[];
  readonly status: readonly string[];
  readonly from: string | null;
  readonly to: string | null;
  readonly query: string | null;
}

export interface SqlPredicate {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export class PrivateApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PrivateApiError";
  }
}

export function parseFilters(query: unknown): PrivateFilters {
  const record = queryRecord(query);
  const from = optionalTimestamp(firstValue(record.from), "from");
  const to = optionalTimestamp(firstValue(record.to), "to");
  if (from !== null && to !== null && from > to) {
    throw badRequest("from must not be after to");
  }
  const rawSearch = firstValue(record.query) ?? "";
  if (rawSearch.length > MAX_QUERY_LENGTH)
    throw badRequest("query is too long");
  const search = rawSearch.trim();
  return {
    project: repeated(record.project),
    release: nullableFacetValues(record.release),
    environment: repeated(record.environment),
    service: nullableFacetValues(record.service),
    level: validatedValues(record.level, ["warn", "error", "fatal"], "level"),
    status: normalizedStatusValues(record.status),
    from,
    to,
    query: search.length === 0 ? null : search,
  };
}

export function parsePageLimit(query: unknown, key = "limit"): number {
  const value = firstValue(queryRecord(query)[key]);
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!/^[1-9]\d*$/u.test(value))
    throw badRequest(`${key} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > MAX_PAGE_LIMIT) {
    throw badRequest(`${key} must be between 1 and ${String(MAX_PAGE_LIMIT)}`);
  }
  return number;
}

export function optionalQueryValue(query: unknown, key: string): string | null {
  return firstValue(queryRecord(query)[key]) ?? null;
}

export function eventFilterPredicate(
  filters: PrivateFilters,
  aliases: {
    readonly event: string;
    readonly issue: string;
    readonly project: string;
  },
): SqlPredicate {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  addTextFacet(
    clauses,
    parameters,
    `${aliases.project}.slug`,
    filters.project,
    {
      alternateColumn: `CAST(${aliases.project}.id AS TEXT)`,
    },
  );
  addReleaseFacet(
    clauses,
    parameters,
    `${aliases.event}.release`,
    filters.release,
  );
  addTextFacet(
    clauses,
    parameters,
    `${aliases.event}.environment`,
    filters.environment,
  );
  addNullableTextFacet(
    clauses,
    parameters,
    `${aliases.event}.service`,
    filters.service,
  );
  addTextFacet(clauses, parameters, `${aliases.event}.level`, filters.level);
  addTextFacet(clauses, parameters, `${aliases.issue}.status`, filters.status);
  if (filters.from !== null) {
    clauses.push(`${aliases.event}.occurred_at >= ?`);
    parameters.push(filters.from);
  }
  if (filters.to !== null) {
    clauses.push(`${aliases.event}.occurred_at <= ?`);
    parameters.push(filters.to);
  }
  if (filters.query !== null) {
    const like = `%${escapeLike(filters.query)}%`;
    clauses.push(`(
      ${aliases.issue}.title LIKE ? ESCAPE '\\' OR
      ${aliases.event}.title LIKE ? ESCAPE '\\' OR
      COALESCE(${aliases.event}.message, '') LIKE ? ESCAPE '\\' OR
      COALESCE(${aliases.event}.exception_type, '') LIKE ? ESCAPE '\\' OR
      COALESCE(${aliases.event}.culprit, '') LIKE ? ESCAPE '\\'
    )`);
    parameters.push(like, like, like, like, like);
  }
  return {
    sql: clauses.length === 0 ? "1 = 1" : clauses.join(" AND "),
    parameters,
  };
}

export function encodeCursor(timestamp: string, id: number | string): string {
  const canonical = canonicalTimestamp(timestamp, "cursor timestamp");
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, t: canonical, i: id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(
  value: string | null,
  idType: "number" | "string",
): { readonly timestamp: string; readonly id: number | string } | null {
  if (value === null) return null;
  if (value.length > MAX_CURSOR_LENGTH) throw badRequest("cursor is too long");
  try {
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value)
      throw new Error("canonical encoding");
    const decoded: unknown = JSON.parse(buffer.toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded)
    )
      throw new Error("shape");
    const record = decoded as Record<string, unknown>;
    if (
      record.v !== CURSOR_VERSION ||
      Object.keys(record).sort().join(",") !== "i,t,v"
    )
      throw new Error("version");
    const timestamp = canonicalTimestamp(record.t, "cursor timestamp");
    const id = record.i;
    if (idType === "number") {
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
        throw new Error("id");
      return { timestamp, id };
    }
    if (typeof id !== "string" || id.length === 0) throw new Error("id");
    return { timestamp, id };
  } catch {
    throw badRequest("cursor is invalid");
  }
}

export function positiveId(value: string, field: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw badRequest(`${field} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw badRequest(`${field} is invalid`);
  return parsed;
}

export function canonicalTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  )
    throw badRequest(`${field} must be an ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw badRequest(`${field} must be an ISO timestamp`);
  const canonical = new Date(milliseconds).toISOString();
  if (canonical !== value)
    throw badRequest(`${field} must be an ISO timestamp`);
  return canonical;
}

export function encodeNullableFacetQueryValue(value: string | null): string {
  return value === null
    ? NULLABLE_FACET_NULL
    : `${NULLABLE_FACET_PREFIX}s:${Buffer.from(value, "utf8").toString("base64url")}`;
}

export function badRequest(message: string): PrivateApiError {
  return new PrivateApiError(400, "invalid_request", message);
}

export function notFound(message: string): PrivateApiError {
  return new PrivateApiError(404, "not_found", message);
}

export function conflict(message: string): PrivateApiError {
  return new PrivateApiError(409, "conflict", message);
}

function queryRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function repeated(
  value: unknown,
  maxLength = MAX_FILTER_VALUE_LENGTH,
): readonly string[] {
  const values = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  if (values.length > MAX_FILTER_VALUES)
    throw badRequest("too many values for one filter");
  const strings = values.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > maxLength
    ) {
      throw badRequest("filter value is invalid");
    }
    return entry;
  });
  return [...new Set(strings)];
}

function validatedValues(
  value: unknown,
  allowed: readonly string[],
  field: string,
): readonly string[] {
  const values = repeated(value);
  if (values.some((entry) => !allowed.includes(entry))) {
    throw badRequest(`${field} filter is invalid`);
  }
  return values;
}

function normalizedStatusValues(value: unknown): readonly string[] {
  const statuses = validatedValues(value, ["unresolved", "resolved"], "status");
  return statuses.length === 2 ? [] : statuses;
}

function nullableFacetValues(value: unknown): readonly (string | null)[] {
  const decoded = repeated(value, MAX_NULLABLE_FILTER_TOKEN_LENGTH).map(
    decodeNullableFacetQueryValue,
  );
  const seen = new Set<string>();
  return decoded.filter((entry) => {
    const identity = entry === null ? "null" : `string:${entry}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function decodeNullableFacetQueryValue(value: string): string | null {
  if (value === NULLABLE_FACET_NULL) return null;
  if (!value.startsWith(NULLABLE_FACET_PREFIX)) {
    if (value.length > MAX_FILTER_VALUE_LENGTH)
      throw badRequest("nullable facet value is invalid");
    return value;
  }
  const match = value.match(/^~v1:s:([A-Za-z0-9_-]+)$/u);
  if (match === null) throw badRequest("nullable facet value is invalid");
  const encoded = match[1];
  if (encoded === undefined)
    throw badRequest("nullable facet value is invalid");
  const bytes = Buffer.from(encoded, "base64url");
  const decoded = bytes.toString("utf8");
  if (
    bytes.toString("base64url") !== encoded ||
    !Buffer.from(decoded, "utf8").equals(bytes) ||
    decoded.length === 0 ||
    decoded.length > MAX_FILTER_VALUE_LENGTH
  ) {
    throw badRequest("nullable facet value is invalid");
  }
  return decoded;
}

function firstValue(value: unknown): string | undefined {
  const selected = Array.isArray(value) ? value[0] : value;
  if (selected === undefined) return undefined;
  if (typeof selected !== "string")
    throw badRequest("query parameter is invalid");
  return selected;
}

function optionalTimestamp(
  value: string | undefined,
  field: string,
): string | null {
  return value === undefined ? null : canonicalTimestamp(value, field);
}

function addTextFacet(
  clauses: string[],
  parameters: unknown[],
  column: string,
  values: readonly string[],
  options?: { readonly alternateColumn: string },
): void {
  if (values.length === 0) return;
  const placeholders = values.map(() => "?").join(", ");
  const primary = `${column} IN (${placeholders})`;
  if (options === undefined) {
    clauses.push(primary);
    parameters.push(...values);
    return;
  }
  clauses.push(
    `(${primary} OR ${options.alternateColumn} IN (${placeholders}))`,
  );
  parameters.push(...values, ...values);
}

function addNullableTextFacet(
  clauses: string[],
  parameters: unknown[],
  column: string,
  values: readonly (string | null)[],
): void {
  if (values.length === 0) return;
  const includeNull = values.includes(null);
  const concrete = values.filter((value): value is string => value !== null);
  const choices: string[] = [];
  if (concrete.length > 0) {
    choices.push(`${column} IN (${concrete.map(() => "?").join(", ")})`);
    parameters.push(...concrete);
  }
  if (includeNull) choices.push(`${column} IS NULL`);
  clauses.push(`(${choices.join(" OR ")})`);
}

function addReleaseFacet(
  clauses: string[],
  parameters: unknown[],
  column: string,
  values: readonly (string | null)[],
): void {
  addNullableTextFacet(clauses, parameters, column, values);
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
