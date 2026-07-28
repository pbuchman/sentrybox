import type { RecordOccurrenceResult } from "./storage/issue-repository.js";
import type { ErrorHubDatabase } from "./storage/database.js";
import type { StorageSafetyState } from "./retention/storage-budget.js";

type IngestOutcome = "accepted" | "discarded" | "rejected";
type RetentionOutcome = "success" | "failure";
export type DispatchOutcome =
  | "delivered"
  | "retry"
  | "dead_letter"
  | "stale_lease";

export class ErrorHubMetrics {
  readonly #ingest = fixedCounter([
    "accepted",
    "discarded",
    "rejected",
  ] as const);
  readonly #grouping = fixedCounter([
    "created",
    "repeated",
    "regressed",
    "duplicate",
  ] as const);
  readonly #retention = fixedCounter(["success", "failure"] as const);
  readonly #retentionRemoved = fixedCounter(["age", "budget"] as const);
  readonly #dispatch = fixedCounter([
    "delivered",
    "retry",
    "dead_letter",
    "stale_lease",
  ] as const);
  #parseDurationCount = 0;
  #parseDurationSum = 0;

  public recordIngest(outcome: IngestOutcome): void {
    increment(this.#ingest, outcome, 1);
  }

  public observeParseDuration(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError(
        "parse duration must be a non-negative finite number",
      );
    }
    this.#parseDurationCount += 1;
    this.#parseDurationSum += seconds;
  }

  public recordGrouping(
    result: Pick<RecordOccurrenceResult, "duplicate" | "outcome">,
  ): void {
    increment(
      this.#grouping,
      result.duplicate ? "duplicate" : result.outcome,
      1,
    );
  }

  public recordRetention(
    outcome: RetentionOutcome,
    removed: { readonly age: number; readonly budget: number },
  ): void {
    increment(this.#retention, outcome, 1);
    increment(this.#retentionRemoved, "age", removed.age);
    increment(this.#retentionRemoved, "budget", removed.budget);
  }

  public recordDispatch(outcome: DispatchOutcome): void {
    increment(this.#dispatch, outcome, 1);
  }

  public render(input: {
    readonly database: ErrorHubDatabase;
    readonly storage: StorageSafetyState;
  }): string {
    const snapshot = input.storage.snapshot();
    const outbox = databaseStateCounts(input.database, "webhook_outbox", [
      "pending",
      "retry",
      "delivered",
      "dead_letter",
      "suppressed",
    ] as const);
    const redrives = databaseStateCounts(input.database, "webhook_redrives", [
      "pending",
      "delivered",
      "dead_letter",
    ] as const);
    const lines: string[] = [];
    appendCounter(
      lines,
      "error_hub_ingest_events_total",
      "outcome",
      this.#ingest,
    );
    lines.push(
      "# TYPE error_hub_parse_duration_seconds summary",
      `error_hub_parse_duration_seconds_count ${String(this.#parseDurationCount)}`,
      `error_hub_parse_duration_seconds_sum ${metricNumber(this.#parseDurationSum)}`,
    );
    appendCounter(lines, "error_hub_grouping_total", "outcome", this.#grouping);
    lines.push(
      "# TYPE error_hub_storage_physical_bytes gauge",
      `error_hub_storage_physical_bytes ${metricNumber(snapshot.physicalUsage?.totalBytes ?? 0)}`,
      "# TYPE error_hub_storage_logical_bytes gauge",
      `error_hub_storage_logical_bytes ${metricNumber(snapshot.logicalPayloadBytes ?? 0)}`,
      "# TYPE error_hub_oldest_event_timestamp_seconds gauge",
      `error_hub_oldest_event_timestamp_seconds ${metricNumber(timestampSeconds(snapshot.oldestEventReceivedAt))}`,
    );
    appendCounter(
      lines,
      "error_hub_retention_runs_total",
      "outcome",
      this.#retention,
    );
    appendCounter(
      lines,
      "error_hub_retention_removed_events_total",
      "reason",
      this.#retentionRemoved,
    );
    appendGauge(lines, "error_hub_outbox_deliveries", "state", outbox);
    appendGauge(lines, "error_hub_webhook_redrives", "state", redrives);
    appendCounter(lines, "error_hub_dispatch_total", "outcome", this.#dispatch);
    return `${lines.join("\n")}\n`;
  }
}

function fixedCounter<const Value extends string>(
  values: readonly Value[],
): Record<Value, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<
    Value,
    number
  >;
}

function increment<Value extends string>(
  counter: Record<Value, number>,
  value: Value,
  amount: number,
): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError("metric increment must be a non-negative safe integer");
  }
  const next = counter[value] + amount;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError("metric counter exceeded the safe integer range");
  }
  counter[value] = next;
}

function appendCounter<Value extends string>(
  lines: string[],
  name: string,
  label: string,
  values: Record<Value, number>,
): void {
  lines.push(`# TYPE ${name} counter`);
  for (const [value, count] of Object.entries(values) as [Value, number][]) {
    lines.push(`${name}{${label}="${value}"} ${String(count)}`);
  }
}

function appendGauge<Value extends string>(
  lines: string[],
  name: string,
  label: string,
  values: Record<Value, number>,
): void {
  lines.push(`# TYPE ${name} gauge`);
  for (const [value, count] of Object.entries(values) as [Value, number][]) {
    lines.push(`${name}{${label}="${value}"} ${String(count)}`);
  }
}

function databaseStateCounts<const State extends string>(
  database: ErrorHubDatabase,
  table: "webhook_outbox" | "webhook_redrives",
  states: readonly State[],
): Record<State, number> {
  const result = fixedCounter(states);
  const rows = database
    .prepare(`SELECT state, COUNT(*) AS count FROM ${table} GROUP BY state`)
    .all() as { state: State; count: number }[];
  for (const row of rows) {
    if (states.includes(row.state)) result[row.state] = row.count;
  }
  return result;
}

function metricNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  return String(value);
}

function timestampSeconds(value: string | null): number {
  if (value === null) return 0;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1_000 : 0;
}
