# SentryBox product and architecture contract

**Status:** Active product contract

This document defines the stable, deployment-neutral behavior of SentryBox.
The [Sentry compatibility page](reference/sentry-compatibility.md) is normative
for every Sentry-shaped protocol, API, webhook, and MCP claim. Concrete hosts,
tenant configuration, installation paths, and operating commands belong to an
example deployment rather than this contract.

## 1. Product scope

SentryBox is an independent, self-hosted error tracker for teams that want to
keep application failure data under operator control. It accepts the supported
Sentry Envelope event flow, applies server-side redaction and bounds, groups
events into issues, retains them in local SQLite storage, and exposes a private
operator UI/API. It can notify one configured automation workflow when an issue
is created or regresses.

The product supports multiple projects and environments. It provides:

- public, write-only error-event ingest;
- private issue investigation and lifecycle management;
- project, release, environment, service, level, and status filtering;
- redacted event and issue downloads plus filtered export;
- bounded retention and live-data-directory safety;
- durable, signed issue-transition delivery; and
- private health, status, and metrics surfaces.

SentryBox does not aim to reproduce the Sentry platform. Tracing, transactions,
spans, sessions, profiles, replay, feedback, symbolication services, source-map
processing, team/account management, a complete Sentry API, and generic alert
configuration are outside the product scope. Full application logs remain in an
external logging system; SentryBox stores only admitted diagnostic events.

## 2. Architecture and trust boundaries

One server process owns two independently registered HTTP applications and one
SQLite database:

```text
Sentry SDKs
    |
    v
public ingest listener --> authenticate --> parse --> redact/normalize
                                                    |
                                                    v
                                              group + SQLite
                                                    |
                       +----------------------------+------------------+
                       |                            |                  |
                       v                            v                  v
              private UI/API              webhook outbox       retention
```

The public listener registers only Envelope `POST`/`OPTIONS` routes and minimal
liveness. It never registers reads, search, downloads, state changes, exports,
metrics, detailed readiness, webhook administration, or compatibility reads.

The private listener owns the operator UI, native API, downloads, system status,
metrics, readiness, and the narrow Sentry-shaped read facade. Network policy is
expected to expose it only to trusted operators and consumers. Private
destructive requests additionally require an allowed host/origin and JSON
content type where applicable.

SQLite is the transactional boundary for event persistence, issue state,
retained aggregates, and webhook outbox creation. One application writer avoids
distributed coordination and keeps issue transitions and notifications atomic.

## 3. Product data model

| Entity           | Contract                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project          | Numeric DSN identity, slug, display name, and enabled state. Issue grouping never crosses a project boundary.                                                                                                        |
| Ingest key       | Public-key hash bound to exactly one project and environment, plus its browser-origin allowlist and trusted forwarding/webhook configuration. The key is an identifier and routing authority, not a secret.          |
| Event            | One admitted, normalized occurrence identified idempotently by `(project_id, event_id)`, with indexed facets, correlation fields, compressed redacted payload, receive time, and SDK occurrence time when preserved. |
| Issue            | A project-scoped, versioned fingerprint with lifecycle state, generation, retained counts, first/last seen, highest level, and retained facet aggregates.                                                            |
| Webhook delivery | Immutable serialized body and destination snapshot, signature, transition cause, retry state, attempts, and next-attempt time.                                                                                       |

Release and environment are facets, not grouping keys. A single issue can
therefore show the same defect across versions or environments while remaining
filterable. Missing release and other nullable facets remain explicitly unknown;
the API does not invent identifiers for them.

## 4. Ingest contract

Each configured project/environment pair has a standard DSN:

```text
https://<public-key>@<public-ingest-host>/<numeric-project-id>
```

The SDK sends to:

```text
POST /api/<numeric-project-id>/envelope/?sentry_version=7&sentry_key=<public-key>&sentry_client=<sdk>
```

SentryBox accepts an event only when the numeric project ID and public key map
to the same enabled project and the event environment equals the environment
bound to that key. Event tags and payload fields cannot override this routing
authority. Browser requests must match the configured origin allowlist exactly.

The ingest path has bounded body/decompression size, request time, concurrent
parsing, source cardinality, and global/source/project rate limits. Credentials,
origin, every event's environment and ID, storage admission, and complete
Envelope validity are checked before persistence, forwarding, or outbox
creation. An Envelope containing an invalid admitted event is rejected rather
than partially persisted.

SDK retries with the same event ID are idempotent and do not increment the
occurrence count. Distinct event IDs remain distinct occurrences even when they
group into one issue. Exact transport states, item handling, admitted levels,
responses, and tested SDK versions are defined in
[Sentry compatibility](reference/sentry-compatibility.md).

An ingest key may also select a fixed, trusted migration-forwarding destination.
Forwarding never accepts a destination from request or event data, never stores
the unredacted Envelope, and never changes the SDK response. It is a bounded,
best-effort migration aid rather than durable product storage.

## 5. Normalization and privacy

Redaction and normalization finish before any event database write. SentryBox
stores only the bounded data needed to diagnose an admitted failure:

- title, formatted message, logger, level, and platform;
- exception type, value, mechanism, and frames;
- at most 100 breadcrumbs;
- release, environment, server name, and at most 100 user tags;
- selected, redacted contexts and extras; and
- request, trace, and task correlation identifiers selected from safe aliases.

Recursive redaction treats credential, authorization, cookie, token, password,
secret, API-key, request-body, user-content, and content-preview fields as
sensitive without regard to key case. Diagnostic strings also pass through
secret-pattern redaction. Request context retains only a sanitized URL, method,
and an allowlist of diagnostic headers; URL credentials and sensitive query
values are removed. SentryBox never stores the unredacted request body or the
original Envelope as product data.

| Normalized field      | Limit         |
| --------------------- | ------------- |
| Title                 | 4 KiB         |
| Message               | 4 KiB         |
| Exception frames      | 200           |
| Breadcrumbs           | 100           |
| Tags                  | 100           |
| Tag key/value         | 200 B / 1 KiB |
| Normalized event JSON | 512 KiB       |
| Recursive structure   | 8 levels      |

Truncation is deterministic, recorded with the normalized event, and visible to
consumers. Downloads and exports contain only this redacted stored model. Known
differences from Sentry event fidelity are documented explicitly in the
[compatibility matrix](reference/sentry-compatibility.md#compatibility-matrix).

## 6. Grouping and issue lifecycle

The issue key is:

```text
project_id + fingerprint_version + fingerprint
```

Fingerprint version 1 uses this precedence:

1. A non-default explicit Sentry fingerprint, combined with exception type and
   service.
2. For exceptions: exception type, normalized exception message, service, and
   up to five relevant application frames.
3. For warning messages: logger, service, and a normalized message template.

Frame identity uses module, filename, and function rather than line/column.
Vendor frames, build roots, query strings, UUIDs, common hash lengths,
timestamps, and standalone numeric identifiers are normalized before hashing.
The raw explanation and algorithm version are stored. A future algorithm change
must use a new version and must not silently re-key existing issues. This is a
SentryBox algorithm; parity with Sentry grouping is not implied.

Issue states are `unresolved` and `resolved`:

- The first occurrence creates an unresolved issue and increments generation.
- Repeated occurrences update retained counts and facets without generating a
  new issue transition.
- Resolve records the resolved state and time without deleting evidence.
- The first later occurrence atomically reopens a resolved issue and increments
  generation.
- Manual reopen changes state without pretending that a new occurrence arrived.
- Permanent delete removes the issue, occurrences, facets, and associated
  pending delivery state transactionally. A later matching event creates a new
  issue.

SentryBox does not infer resolution from pull requests or automation state.

## 7. Automation delivery

A webhook destination is configured per project/environment ingest key and is
either `disabled` or `live`. Creation of a new issue and regression of a
resolved issue each create at most one immutable outbox transition in the same
transaction as the issue change. Repeated occurrences do not each create an
alert.

Disabled mode records a non-dispatchable `suppressed` audit row. Enabling a
destination does not release suppressed history; only later issue creations or
regressions can create pending deliveries. This prevents a backlog from being
sent when a destination becomes live.

The dispatcher retries transient failures with bounded backoff for up to seven
days, treats any `2xx` response as success, and dead-letters permanent client
failures. The private UI/status API exposes failed delivery state and supports
explicit redrive after correction. Retries reuse the exact persisted body and
signature. The only Sentry-shaped payload contract is defined in
[Sentry compatibility](reference/sentry-compatibility.md).

## 8. Storage and retention

SQLite uses WAL mode, foreign keys, a busy timeout, WAL auto-checkpoint,
incremental auto-vacuum, ordered forward migrations, and indexed columns or
facet rows for every filter. Normalized event payload JSON is gzip-compressed;
normal list and facet queries do not decompress it.

Retention is based on `received_at`, not an untrusted SDK timestamp:

- events older than 30 days are removed in bounded batches;
- after every batch, issue counts, first/last seen, highest level, and facets are
  recomputed from retained events;
- issues with no retained events are removed;
- delivered outbox records and terminal (`delivered` or `dead_letter`) redrive
  records expire after 7 days;
- WAL checkpoint and incremental vacuum follow mutating retention work; and
- downloads stream and do not create files in the live data directory.

Age retention is not a promise that every event remains for 30 days. A logical
payload high-water mark of 4 GiB triggers oldest-first eviction to a 3.6 GiB
target. The live data directory has a 5 GiB safety budget covering database,
WAL/SHM, temporary, and other live-data files. At 4.75 GiB physical usage, or
when free space falls below 256 MiB, storage becomes critical; SentryBox attempts
reclamation and rejects ingest when safety cannot be established. This budget
does not describe the size of an installation or external backup storage.

The status API reports physical usage, logical payload bytes, oldest retained
event, retention outcomes, and whether ingest is accepting traffic.

## 9. Operator UI and APIs

The private operator surface answers three questions: what is failing, whether
it is a known issue, and which stored event evidence explains it. The issue list
and detail views expose precise relative and absolute times, retained counts,
facets, event evidence, lifecycle actions, downloads, and delivery state.

Native private API categories are:

| Category            | Capabilities                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Issues              | Cursor-paginated list/detail, combined filters, resolve, reopen, and permanent delete.                              |
| Events              | Cursor-paginated occurrences, normalized detail, and single-event download.                                         |
| Facets and exports  | Project/release/environment/service/level/status facets, issue download, and streaming filtered NDJSON gzip export. |
| System              | Detailed status, readiness/liveness, Prometheus metrics, and webhook redrive.                                       |
| Compatibility reads | The narrow, read-only Sentry-shaped facade defined by the compatibility matrix.                                     |

Repeated values within one facet are ORed; different facets are ANDed. Stable
cursors are based on `(last_seen, issue_id)` for issues and
`(occurred_at, event_id)` for events. Filters remain shareable in the URL.

The UI must remain keyboard-operable, use visible focus and semantic structures,
communicate severity without color alone, expose exact textual timestamps, and
require labelled confirmation for permanent deletion. Mobile operation must not
require horizontal page scrolling.

## 10. Operations and reliability

- `/health/live` reports process liveness only.
- Private readiness checks database access, migration completion, retention
  safety, and live-data storage safety.
- Private metrics cover ingest outcomes, parsing/grouping latency, retention,
  physical/logical storage, and webhook states.
- The service does not report its own failures into its own ingest path.
- Schema changes are forward migrations run under the deployment's exclusive
  update boundary.
- Application telemetry failure must not alter the monitored application's
  business response; SDK transport failures remain telemetry failures.
- Backups must be consistent SQLite copies, must not extend the event-retention
  contract, and must use storage outside the live data directory.

Deployment topology, supervision, reverse proxies, credentials, backup tooling,
and recovery commands are implementation choices documented by each deployment.
The current example is indexed under
[Example deployment and operations](README.md#example-deployment-and-operations).

## 11. Acceptance invariants

The following invariants define a conforming SentryBox release:

### Reporting and privacy

- A verified SDK event flow works after a DSN value change within the exact
  [compatibility boundary](reference/sentry-compatibility.md).
- Project and environment authority comes from the verified ingest key; payload
  metadata cannot cross that boundary.
- Gzip and identity event Envelopes are bounded before persistence.
- Unsupported telemetry is never represented as stored error events.
- The same `(project_id, event_id)` is idempotent.
- No unredacted request body or original Envelope is persisted as product data.
- Downloads contain only the redacted normalized representation.

### Grouping and lifecycle

- Grouping never crosses projects and remains explainable by a stored algorithm
  version.
- Equivalent events with different IDs can form one issue across releases and
  environments while remaining separate occurrences.
- Resolve preserves evidence; a later occurrence reopens atomically; permanent
  deletion removes the issue and its event data atomically.
- Retained issue aggregates describe only retained events.

### Access and APIs

- Public ingest exposes no event, issue, search, export, admin, metric, detailed
  status, or compatibility read.
- Private destructive requests enforce their host/origin/content-type guards.
- Unsupported Sentry-shaped API routes fail closed as documented.
- Combined filters and stable cursors cannot skip or duplicate rows within a
  consistent retained dataset.

### Storage and delivery

- Events beyond the age ceiling are removed, and budget pressure may remove the
  oldest events earlier.
- Ingest fails closed when live-data safety is unknown or critical rather than
  consuming the remaining disk.
- Issue transitions and their outbox records commit atomically.
- One issue generation creates at most one dispatchable notification; retries
  preserve body, signature, and delivery identity.
- Failed deliveries are observable and explicitly redrivable.

### Operations

- Liveness remains minimal and does not claim dependency readiness.
- Readiness does not report success when database, migration, retention, or
  storage safety is unknown.
- Operational logs and metrics do not expose secret values or normalized event
  payloads.
