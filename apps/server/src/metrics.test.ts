import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type ErrorHubDatabase } from "./storage/database.js";
import { migrateDatabase } from "./storage/migrate.js";
import {
  DEFAULT_RETENTION_CONFIG,
  StorageSafetyState,
} from "./retention/storage-budget.js";
import { ErrorHubMetrics } from "./metrics.js";

let database: ErrorHubDatabase;
let storage: StorageSafetyState;

beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database, "2026-07-28T00:00:00.000Z");
  storage = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
  storage.observeUsage(
    {
      databaseBytes: 100,
      walBytes: 20,
      shmBytes: 10,
      temporaryBytes: 5,
      dataDirectoryOtherBytes: 0,
      totalBytes: 135,
      freeBytes: 1_000,
    },
    321,
    "2026-07-01T00:00:00.000Z",
  );
});

afterEach(() => {
  database.close();
});

describe("ErrorHubMetrics", () => {
  it("keeps counters monotonic across every fixed-cardinality outcome", () => {
    const metrics = new ErrorHubMetrics();
    metrics.recordIngest("accepted");
    metrics.recordIngest("accepted");
    metrics.recordIngest("discarded");
    metrics.recordIngest("rejected");
    metrics.observeParseDuration(0.025);
    metrics.recordGrouping({
      duplicate: false,
      outcome: "created",
    });
    metrics.recordGrouping({
      duplicate: false,
      outcome: "repeated",
    });
    metrics.recordGrouping({
      duplicate: false,
      outcome: "regressed",
    });
    metrics.recordGrouping({ duplicate: true, outcome: "repeated" });
    metrics.recordRetention("success", { age: 2, budget: 3 });
    metrics.recordRetention("failure", { age: 0, budget: 0 });
    metrics.recordDispatch("delivered");
    metrics.recordDispatch("retry");
    metrics.recordDispatch("dead_letter");
    metrics.recordDispatch("stale_lease");
    metrics.recordIngestResponse(429);
    metrics.recordIngestResponse(429);
    metrics.recordIngestResponse(503);

    const rendered = metrics.render({ database, storage });

    expect(rendered).toContain(
      'sentrybox_ingest_events_total{outcome="accepted"} 2',
    );
    expect(rendered).toContain(
      'sentrybox_ingest_events_total{outcome="discarded"} 1',
    );
    expect(rendered).toContain(
      'sentrybox_ingest_events_total{outcome="rejected"} 1',
    );
    expect(rendered).toContain(
      'sentrybox_grouping_total{outcome="duplicate"} 1',
    );
    expect(rendered).toContain(
      'sentrybox_retention_removed_events_total{reason="age"} 2',
    );
    expect(rendered).toContain(
      'sentrybox_retention_removed_events_total{reason="budget"} 3',
    );
    expect(rendered).toContain(
      'sentrybox_dispatch_total{outcome="stale_lease"} 1',
    );
    expect(rendered).toContain(
      'sentrybox_ingest_http_responses_total{status="429"} 2',
    );
    expect(rendered).toContain(
      'sentrybox_ingest_http_responses_total{status="503"} 1',
    );
    expect(rendered).toContain("sentrybox_parse_duration_seconds_count 1");
    expect(rendered).toContain("sentrybox_storage_physical_bytes 135");
    expect(rendered).toContain("sentrybox_storage_logical_bytes 321");
    expect(rendered).not.toContain("error_hub_");
  });

  it("renders only the documented finite label sets and valid escaped Prometheus text", () => {
    const rendered = new ErrorHubMetrics().render({ database, storage });
    const labels = [...rendered.matchAll(/\{([^}]*)\}/gu)].map(
      (match) => match[1] ?? "",
    );

    expect(
      labels.every((label) =>
        /^((outcome|reason|state)="[a-z_]+"|status="(429|503)")$/u.test(label),
      ),
    ).toBe(true);
    expect(rendered).not.toMatch(
      /project|service|environment|event_id|issue_id|https?:|error text|\\n[^#e]/iu,
    );
    expect(rendered.endsWith("\n")).toBe(true);
  });
});
