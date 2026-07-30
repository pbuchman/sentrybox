# SentryBox Documentation Redesign

**Status:** Approved for implementation on 2026-07-30
**Type:** Historical design record

## Objective

Present SentryBox as an independent, self-hosted error tracker that can serve
multiple projects. Keep IntexuraOS on Home Dev as the current reference
deployment, not as the product boundary. Describe Sentry interoperability as a
tested subset with explicit limits instead of implying that SentryBox replaces
the Sentry platform.

## Information architecture

- `README.md` is the product entry point: problem, value, operating model,
  compatibility summary, current status, and documentation map.
- `docs/README.md` separates product guidance, reference material, the current
  example deployment, operations, and historical records.
- `docs/specification.md` contains the stable, product-neutral contract.
- `docs/reference/sentry-compatibility.md` is the normative compatibility
  matrix and names the tested versions and known fidelity gaps.
- `docs/examples/intexuraos-home-dev/` owns all current tenant- and host-specific
  runbooks.
- `docs/archive/` owns completed implementation plans and the retired cutover
  procedure.

## Product narrative

The documentation starts with the operational problem: teams may want familiar
Sentry SDK error reporting without sending application failures to an external
error-tracking service or operating the full Sentry platform. SentryBox accepts
the supported Sentry Envelope event flow, redacts and normalizes it, groups it
into issues, stores it in bounded local SQLite storage, exposes a private
operator UI/API, and can notify one configured automation workflow.

The principal benefits are:

- reuse of the verified Sentry Envelope event flow without claiming a general
  DSN-only migration;
- operator ownership of error data and storage policy;
- a private investigation surface separated from public ingest;
- bounded retention and live-data storage safeguards;
- durable alert delivery for the reference Code Agent workflow.

## Compatibility boundary

The compatibility page uses `Supported`, `Partial`, and `Not supported` states.
It records that evidence covers an `@sentry/node@8.55.0` custom
acceptance-transport flow, a captured `@sentry/react@8.55.0` Envelope fixture,
standard DSN parsing, event Envelopes, identity/gzip request bodies,
warning/error/fatal events, and the implemented HTTP outcomes. It does not
claim that either SDK's default transport has been verified.

It also records these boundaries:

- no `/store/`, tracing, transactions, spans, sessions, profiles, replay,
  feedback, minidumps, security reports, or attachments;
- a custom private UI and only five successful read routes under `/api/0`;
- one `event_alert` / `triggered` webhook contract for Code Agent;
- compatibility tests for two read operations through the external pinned
  `@sentry/mcp-server@0.37.0`, not a bundled MCP server;
- known event-fidelity differences for numeric timestamps, top-level `request`,
  and `tags.service`;
- up to 30 days of retention, subject to earlier budget eviction, and a 5 GiB
  live-data-directory safety budget rather than a total-installation limit.

## Current product status

The ingest, storage, grouping, UI, API, retention, and project model are capable
of handling multiple projects and environments. The bundled configuration,
organization slug, UI permalinks, public hosts, and project validator still
contain IntexuraOS assumptions. Those code changes are intentionally tracked as
a separate product-generalization follow-up rather than hidden by documentation.

## Home Dev ownership boundary

The SentryBox repository remains the source of truth for deployment mechanics:
Compose, systemd units, Caddy fragments, immutable-image deployment, rollback,
monitoring, backup posture, and credentials. The `pbuchman-dev` repository
documents how those assets are installed and verified on the Home Dev host. It
does not duplicate or fork the deployment implementation, and its shared
`machine-setup/config/Caddyfile` remains unchanged.

## Automated documentation contract

A repository-owned checker validates active local links, parses active shell
examples with `bash -n`, and rejects a small set of misleading unqualified
Sentry claims. Archive content is retained as history and excluded from current
product-copy policy. The checker runs in the normal test and CI path.
