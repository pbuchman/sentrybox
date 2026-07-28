# Intexura Error Hub Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Sentry-compatible ingest, grouping, lifecycle, private API, webhook outbox, retention engine, log locator, and focused operator UI defined in the product specification.

**Architecture:** A Node.js 22 pnpm workspace runs one Fastify process with separate public-ingest and private-operator listeners. SQLite is the single durable store. Pure protocol and domain packages keep envelope parsing, redaction, fingerprinting, and lifecycle rules independently testable. A React/Vite application is built into static assets served only by the private listener.

**Tech Stack:** Node.js 22, TypeScript 5.9.3, pnpm 10.29.3, Fastify 5.6.2, better-sqlite3 13.0.1, Zod 4.4.3, Pino 10.3.1, React 19.2.8, Vite 8.1.5, Vitest 4.1.10, Testing Library 16.3.2, Playwright 1.62.0.

## Global Constraints

- Implement only the behavior in [the specification](../../specification.md).
- Public ingress and private read/admin traffic must remain separate listeners.
- Persist only `warning`, `error`, and `fatal`; acknowledge and discard unsupported envelope items without retry pressure.
- Project and allowed environment come from the verified DSN credential; `release` and `environment` remain separate indexed facets.
- Never persist unredacted payload bytes or `contentPreview`.
- Every database mutation that changes lifecycle state and its webhook must be atomic.
- There is no application authentication layer. Network placement, Origin/Host checks, and Tailscale ACLs enforce private access.
- Keep the live data directory below 5 GiB and event retention at 30 days.

---

## Task 1: Establish the tested workspace

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `vitest.workspace.ts`
- Create: `apps/server/package.json`
- Create: `apps/web/package.json`
- Create: `packages/domain/package.json`
- Create: `packages/protocol/package.json`
- Create: `.github/workflows/ci.yml`

- [ ] Create the four workspace packages and pin the versions listed above; use `packageManager: "pnpm@10.29.3"` and `engines.node: ">=22 <23"`.
- [ ] Add root scripts `typecheck`, `lint`, `test`, `test:integration`, and `build`, each delegating through `pnpm -r`.
- [ ] Add strict TypeScript settings including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and project references.
- [ ] Add one deliberately failing smoke test per package proving Vitest discovers all workspaces.
- [ ] Run `corepack pnpm install --frozen-lockfile=false && pnpm test`; expect four failing smoke assertions.
- [ ] Replace the smoke assertions with package identity assertions and rerun `pnpm test`; expect all four to pass.
- [ ] Configure CI on `ubuntu-latest` only, with install, format check, lint, typecheck, test, and build jobs; do not reference a self-hosted runner.
- [ ] Commit with `chore: scaffold error hub workspace`.

## Task 2: Parse and validate the Sentry Envelope protocol

**Files:**

- Create: `packages/protocol/src/envelope.ts`
- Create: `packages/protocol/src/decompression.ts`
- Create: `packages/protocol/src/sentry-types.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/envelope.test.ts`
- Test fixtures: `packages/protocol/test/fixtures/node-event.envelope`
- Test fixtures: `packages/protocol/test/fixtures/browser-event.envelope`
- Test fixtures: `packages/protocol/test/fixtures/mixed-items.envelope`

- [ ] Write failing tests for newline framing, a missing `Content-Type`, gzip input, a mixed envelope, duplicate item headers, malformed JSON, a decompressed body over 1 MiB, and a decompression-ratio violation.
- [ ] Define the protocol boundary:

```ts
export interface EnvelopeItem {
  readonly type: string;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly payload: Uint8Array;
}

export interface ParsedEnvelope {
  readonly eventId: string | null;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly items: readonly EnvelopeItem[];
}

export function parseEnvelope(body: Uint8Array): ParsedEnvelope;
export function decompressEnvelope(input: NodeJS.ReadableStream, encoding: string | undefined): Promise<Uint8Array>;
```

- [ ] Parse item lengths when supplied and newline-delimited payloads otherwise; reject ambiguous or truncated framing with a typed protocol error.
- [ ] Preserve unknown item types in memory so the ingest route can acknowledge and discard them.
- [ ] Add real fixtures captured from `@sentry/node@8.55.0` and `@sentry/react@8.55.0`; strip all user data before committing fixtures.
- [ ] Run `pnpm --filter @intexura-error-hub/protocol test`; expect all parser cases to pass.
- [ ] Commit with `feat(protocol): accept sentry envelope v7 events`.

## Task 3: Normalize, redact, and classify accepted events

**Files:**

- Create: `packages/protocol/src/normalize.ts`
- Create: `packages/protocol/src/redact.ts`
- Create: `packages/protocol/src/limits.ts`
- Test: `packages/protocol/src/normalize.test.ts`
- Test: `packages/protocol/src/redact.test.ts`

- [ ] Write failing table tests for Sentry levels `warning`, `warn`, `error`, and `fatal`, plus rejection of `debug`, `info`, and unknown levels.
- [ ] Define `NormalizedEventInput` with event ID, timestamps, title/message, exception frames, breadcrumbs, tags, contexts, extras, release, environment, server name, and correlation identifiers.
- [ ] Implement level normalization to the canonical union:

```ts
export type ErrorLevel = 'warn' | 'error' | 'fatal';

export type Admission =
  | { readonly accepted: true; readonly level: ErrorLevel }
  | { readonly accepted: false; readonly reason: 'below_threshold' | 'unsupported_item' };
```

- [ ] Recursively redact configured secret keys and values matching bearer tokens, API keys, DSNs, cookies, authorization headers, emails where not structurally required, and the exact `contentPreview` key before serialization.
- [ ] Apply the specification limits for strings, frames, breadcrumbs, collection sizes, and recursion; set `truncated=true` and record truncation reasons.
- [ ] Extract `requestId`, `reqId`, `traceId`, and `taskId` from tags, contexts, and extras using a deterministic precedence without inventing values.
- [ ] Run `pnpm --filter @intexura-error-hub/protocol test`; expect redaction tests to prove the forbidden fixture values are absent from the entire serialized result.
- [ ] Commit with `feat(protocol): normalize and redact error events`.

## Task 4: Implement deterministic grouping and lifecycle rules

**Files:**

- Create: `packages/domain/src/event.ts`
- Create: `packages/domain/src/fingerprint.ts`
- Create: `packages/domain/src/message-normalization.ts`
- Create: `packages/domain/src/lifecycle.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/src/fingerprint.test.ts`
- Test: `packages/domain/src/lifecycle.test.ts`

- [ ] Write failing grouping tests for explicit fingerprints, identical exceptions across different releases/environments, changed line numbers, vendor-only frames, warning templates containing UUIDs/timestamps/SHAs/numbers, and distinct projects.
- [ ] Implement the versioned grouping boundary:

```ts
export interface FingerprintResult {
  readonly version: 1;
  readonly digest: string;
  readonly explanation: readonly string[];
}

export function fingerprintEvent(event: NormalizedEventInput): FingerprintResult;
```

- [ ] Normalize only the volatile tokens listed in the specification; keep exception type, service, application module, filename, and function identity.
- [ ] Write failing lifecycle tests for create, repeat, resolve, manual reopen, regression after resolve, and delete/recreate.
- [ ] Implement pure lifecycle decisions returning `created`, `repeated`, `regressed`, or `manually_reopened`, including the next generation and whether a webhook is required.
- [ ] Run `pnpm --filter @intexura-error-hub/domain test`; expect grouping to stay constant across release/environment but differ by project.
- [ ] Commit with `feat(domain): group events and model issue lifecycle`.

## Task 5: Create the SQLite schema and transactional repositories

**Files:**

- Create: `apps/server/src/storage/database.ts`
- Create: `apps/server/src/storage/migrate.ts`
- Create: `apps/server/src/storage/migrations/001_initial.sql`
- Create: `apps/server/src/storage/project-repository.ts`
- Create: `apps/server/src/storage/issue-repository.ts`
- Create: `apps/server/src/storage/event-repository.ts`
- Create: `apps/server/src/storage/outbox-repository.ts`
- Test: `apps/server/src/storage/database.test.ts`
- Test: `apps/server/src/storage/issue-repository.test.ts`

- [ ] Write a failing migration test that opens an empty temporary database and asserts every table, foreign key, uniqueness constraint, and required index from section 13.
- [ ] Add `projects`, `project_ingest_keys`, `issues`, `events`, `event_tags`, `issue_facets`, `webhook_outbox`, and `schema_migrations`; enforce unique `(project_id, event_id)` and `(project_id, fingerprint_version, fingerprint)`.
- [ ] Enable WAL, foreign keys, busy timeout, incremental auto-vacuum, and bounded WAL auto-checkpoint on every connection.
- [ ] Hash DSN public keys with SHA-256 and compare hashes in constant time; never store the clear key.
- [ ] Implement one transaction that performs idempotency lookup, issue create/update/regression, event insert, facet update, and immutable outbox insert.
- [ ] Store the redacted normalized payload as deterministic JSON compressed with gzip after all indexed fields have been extracted.
- [ ] Add tests proving retries do not increment counts, two different IDs do increment one issue, regression increments generation once, and delete cascades through events/tags/facets/outbox.
- [ ] Run `pnpm --filter @intexura-error-hub/server test -- storage`; expect a clean temporary database after every test.
- [ ] Commit with `feat(storage): persist issues events and outbox atomically`.

## Task 6: Build the isolated public ingest listener

**Files:**

- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/secrets.ts`
- Create: `apps/server/src/public-app.ts`
- Create: `apps/server/src/ingest/route.ts`
- Create: `apps/server/src/ingest/project-auth.ts`
- Create: `apps/server/src/ingest/rate-limit.ts`
- Create: `apps/server/src/ingest/shadow-forwarder.ts`
- Create: `apps/server/src/http/sentry-errors.ts`
- Test: `apps/server/src/ingest/route.test.ts`
- Test: `apps/server/src/ingest/shadow-forwarder.test.ts`

- [ ] Write failing Fastify injection tests for the exact `POST /api/:projectId/envelope/` path, OPTIONS preflight, project/key mismatch, environment/key mismatch, unknown project, disabled project, allowed/disallowed browser origins, gzip, duplicate event IDs, unsupported items, and every severity.
- [ ] Parse `ERROR_HUB_ENV_FILE` once as a strict `KEY=VALUE` credential file and resolve only named Code Agent HMAC and legacy-forwarding secrets. Fail readiness for missing, duplicate, empty, or unreferenced required values and prove tests/logs/config APIs never expose them.
- [ ] Parse `sentry_key` from query parameters and the standard `X-Sentry-Auth` fallback; require the numeric project ID and key to resolve to the same enabled project and require the event environment to equal the environment bound to that key.
- [ ] Implement the success/error surface: `200 {"id":"event-id"}`, `400` with `X-Sentry-Error`, `413` for the decompressed limit, `429` with `Retry-After`, and `503` only for storage safety/readiness failures.
- [ ] Configure the public Fastify instance with no private routes, no static assets, no database identifiers in responses, a 1 MiB decompressed limit, bounded concurrent parsing, request timeout, and per-source/per-project rate limits.
- [ ] Acknowledge transaction, span, session, sessions, client report, and unknown items without persistence or retries.
- [ ] Add the migration-only bounded in-memory forwarder. Select its fixed legacy DSN from the verified environment-bound key, rewrite only transport authentication, preserve envelope item bytes/event IDs, reject client-supplied destinations, persist no raw envelope, and keep its result independent from the SDK response.
- [ ] Test forwarding success, target-environment selection, disabled mode, queue saturation, network failure, and environment mismatch; expect metrics but no retry or raw-payload disk write.
- [ ] Add an integration test that sends an actual v8.55 Node envelope and confirms project, release, environment, service, level, and occurrence count in SQLite.
- [ ] Run `pnpm --filter @intexura-error-hub/server test -- ingest`; expect all responses and headers to match the transport contract.
- [ ] Commit with `feat(ingest): expose write-only sentry envelope endpoint`.

## Task 7: Deliver Sentry-compatible Code Agent webhooks

**Files:**

- Create: `apps/server/src/webhooks/payload.ts`
- Create: `apps/server/src/webhooks/signature.ts`
- Create: `apps/server/src/webhooks/dispatcher.ts`
- Create: `apps/server/src/webhooks/retry-policy.ts`
- Test: `apps/server/src/webhooks/payload.test.ts`
- Test: `apps/server/src/webhooks/dispatcher.test.ts`

- [ ] Write a failing golden test for the exact `event_alert.triggered` JSON body and headers from section 10, including the organization issue URL and nested event/project fields.
- [ ] Add failing mode tests proving `disabled` writes an immutable `suppressed` audit row, the dispatcher never sends/retries it, enabling records a baseline without releasing backlog, and only later creates/regressions become pending.
- [ ] Serialize the body once, persist those exact bytes in the outbox, and calculate lowercase HMAC-SHA256 over those bytes at delivery time.
- [ ] Define the delivery boundary:

```ts
export interface WebhookAttempt {
  readonly deliveryId: string;
  readonly body: Buffer;
  readonly targetUrl: URL;
  readonly secretRef: string;
  readonly attempt: number;
}

export type DeliveryResult = 'delivered' | 'retry' | 'dead_letter';
```

- [ ] Implement the exact retry schedule and HTTP classification from the specification, with request timeout, stable `X-Error-Hub-Delivery`, and no payload logging.
- [ ] Prove in tests that repeated occurrences create no delivery, a resolved issue regression creates one new generation delivery, retries use byte-identical bodies/signatures, and dead letters remain inspectable.
- [ ] Run `pnpm --filter @intexura-error-hub/server test -- webhooks`; expect no network calls outside the local test server.
- [ ] Commit with `feat(webhooks): deliver code agent compatible alerts`.

## Task 8: Implement the private operator and Sentry-read APIs

**Files:**

- Create: `apps/server/src/private-app.ts`
- Create: `apps/server/src/api/issues.ts`
- Create: `apps/server/src/api/events.ts`
- Create: `apps/server/src/api/facets.ts`
- Create: `apps/server/src/api/exports.ts`
- Create: `apps/server/src/api/system.ts`
- Create: `apps/server/src/api/private-request-guard.ts`
- Create: `apps/server/src/sentry-api/issues.ts`
- Create: `apps/server/src/sentry-api/events.ts`
- Create: `apps/server/src/sentry-api/projects.ts`
- Test: `apps/server/src/api/private-api.test.ts`
- Test: `apps/server/src/sentry-api/compatibility.test.ts`

- [ ] Write failing contract tests for every private endpoint in section 12, cursor stability, facet OR/AND semantics, exact timestamps, resolve/reopen/delete behavior, streamed downloads, and dead-letter retry.
- [ ] Require an allowed Host and Origin for mutations, JSON content type where applicable, and reject public-ingest Host values; do not add login, cookies, or bearer auth.
- [ ] Stream one-event JSON, issue NDJSON gzip, and filtered NDJSON gzip directly from SQLite without temporary files or whole-export buffering.
- [ ] Implement only the five Sentry REST read endpoints in section 11.3 and return structured 404 for the remainder.
- [ ] Match the Sentry field shape required by `get_issue_details` and `search_issue_events`, including exception entries, frames, breadcrumbs, contexts, tags, release, environment, occurrence counts, and stable permalinks.
- [ ] Add a compatibility test that launches pinned `@sentry/mcp-server@0.37.0` against the private listener and exercises both tools over seeded data.
- [ ] Run `pnpm --filter @intexura-error-hub/server test -- api`; expect private mutations to fail with an unapproved Host/Origin and pass with the configured private origin.
- [ ] Commit with `feat(api): expose private operator and worker evidence APIs`.

## Task 9: Add log correlation, retention, and health safety

**Files:**

- Create: `apps/server/src/logs/query-builder.ts`
- Create: `apps/server/src/retention/sweeper.ts`
- Create: `apps/server/src/retention/storage-budget.ts`
- Create: `apps/server/src/health/status.ts`
- Create: `apps/server/src/metrics.ts`
- Test: `apps/server/src/logs/query-builder.test.ts`
- Test: `apps/server/src/retention/sweeper.test.ts`
- Test: `apps/server/src/health/status.test.ts`

- [ ] Write failing query-builder tests for exact trace/request/task IDs, service/environment/time fallback, escaped LogQL values, browser-only events, and the ±2 minute boundary.
- [ ] Return a typed correlation result with `confidence: "exact_identifier" | "time_message_fallback" | "not_applicable"`; the UI must never label fallback as exact.
- [ ] Write failing retention tests using a tiny injected budget for 30-day expiry, 4 GiB/3.6 GiB logical thresholds, the 4.75 GiB physical stop, bounded batches, retained count/first-last/facet recomputation, orphan issue cleanup, outbox cleanup, terminal `webhook_redrives` cleanup independent of the original outbox state, checkpoint, and incremental vacuum.
- [ ] Make ingest readiness depend on the storage safety state; retention failures must not silently delete newer data or fill the filesystem.
- [ ] Expose private health and Prometheus data for accepted/discarded/rejected events, parse latency, issue grouping, database bytes, oldest event, retention runs, and outbox states.
- [ ] Run `pnpm --filter @intexura-error-hub/server test -- retention logs health`; expect deterministic behavior without inspecting the developer machine disk.
- [ ] Commit with `feat(operations): correlate logs and enforce storage budget`.

## Task 10: Build the focused responsive UI

**Files:**

- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/routes/issue-list.tsx`
- Create: `apps/web/src/routes/issue-detail.tsx`
- Create: `apps/web/src/components/filter-bar.tsx`
- Create: `apps/web/src/components/issue-row.tsx`
- Create: `apps/web/src/components/event-details.tsx`
- Create: `apps/web/src/components/time-value.tsx`
- Create: `apps/web/src/components/confirm-delete-dialog.tsx`
- Create: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/app.css`
- Create: `apps/web/public/fonts/Atkinson-Hyperlegible.woff2`
- Create: `apps/web/public/fonts/JetBrains-Mono.woff2`
- Test: `apps/web/src/routes/issue-list.test.tsx`
- Test: `apps/web/src/routes/issue-detail.test.tsx`
- Test: `apps/web/e2e/operator-flow.spec.ts`

- [ ] Write failing component tests for all filters, shareable query state, project/version/environment visibility, exact plus relative time, resolve/reopen, download, delete confirmation, empty states, and webhook failure recovery.
- [ ] Implement the visual tokens and issue-list hierarchy exactly from section 15; bundle fonts locally and avoid icon-only actions, gradients, charts, and decorative motion.
- [ ] Render semantic desktop rows and mobile cards from the same data; move filters into an accessible mobile sheet without horizontal page scrolling.
- [ ] Refresh relative labels every 30 seconds while keeping exact UTC text and `<time datetime>` stable.
- [ ] Put exception/application frames before metadata, then facets, log locator, breadcrumbs, redacted context, occurrences, delivery state, and normalized JSON.
- [ ] Add keyboard, reduced-motion, focus, contrast, screen-reader, loading, error, and destructive-confirmation tests.
- [ ] Run `pnpm --filter @intexura-error-hub/web test`; expect all component tests to pass.
- [ ] Run `pnpm --filter @intexura-error-hub/web exec playwright test --project=chromium`; expect desktop and 390 px mobile operator flows to pass.
- [ ] Commit with `feat(web): add private issue triage interface`.

## Task 11: Wire the single runtime and prove end-to-end behavior

**Files:**

- Create: `apps/server/src/main.ts`
- Create: `apps/server/src/runtime.ts`
- Create: `apps/server/src/static-ui.ts`
- Create: `apps/server/test/e2e/error-hub.test.ts`
- Create: `apps/server/test/e2e/fixtures.ts`
- Modify: `apps/server/package.json`
- Modify: `package.json`

- [ ] Write a failing end-to-end test that starts both listeners on ephemeral loopback ports, ingests Node and browser envelopes, groups them, filters by all facets, opens an event, generates a log query, resolves, regresses, receives the signed webhook, downloads, and permanently deletes.
- [ ] Bind public and private Fastify instances independently and fail if they resolve to the same address/port. Default to loopback for direct execution; the hardened Compose file must explicitly bind both internal ports to `0.0.0.0` inside the container namespace so host loopback publishing works.
- [ ] Start migration, retention, and webhook loops through one abortable runtime; shut down by stopping ingress, draining in-flight transactions, checkpointing WAL, and then closing SQLite.
- [ ] Serve the Vite build only from the private app and support the required `/organizations/intexuraos/issues/:id/` permalink route.
- [ ] Add fixture assertions that no debug/info payload and no forbidden redaction value exists anywhere in the database or export.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; expect zero failures and a server distribution containing the private UI assets.
- [ ] Run the full end-to-end suite twice to expose leaked ports, database handles, timers, or non-idempotent migrations.
- [ ] Commit with `feat: complete error hub runtime`.

## Endpoint Changes

### Modified

- None; this is a new standalone service.

### Created

- Public `POST|OPTIONS /api/{projectId}/envelope/` and `GET /health/live`.
- Private issue, event, facet, download, lifecycle, outbox, system-status,
  readiness, and metrics routes listed in specification section 12.
- Private Sentry-compatible issue/event/project read routes listed in
  specification section 11.3.
- Private UI routes including `/organizations/intexuraos/issues/{issueId}/`.

### Removed

- None.

### Unchanged

- External Code Agent endpoint `POST /api/code/webhooks/sentry`; the Hub is its
  client and does not own or modify the route in this plan.

## Completion gate

- [ ] Map every acceptance criterion in specification section 21 to at least one automated test and record the test path beside the criterion in the pull-request description.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` from a clean checkout.
- [ ] Confirm `rg -n "contentPreview|authorization|cookie|password|token"` against generated test databases and exports finds no fixture secret values.
- [ ] Confirm the public listener returns 404 for `/`, `/api/issues`, `/api/export`, Sentry read APIs, and static assets.
- [ ] Request code review before starting the deployment and IntexuraOS integration plans.
