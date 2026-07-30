# SentryBox

Application errors often contain the exact code paths and runtime context that a
team is least willing to send to another service. SentryBox is for operators who
want familiar Sentry SDK error reporting while keeping investigation data and its
retention policy under their own control, without operating the full Sentry
platform.

SentryBox is an independent, self-hosted error tracker. It accepts a deliberately
limited Sentry event flow, redacts and normalizes events, groups them into issues,
stores them in bounded local SQLite storage, and exposes a private investigation
surface. One configured automation workflow can receive durable notifications
when an issue is created or regresses.

## What it provides

- Tested acceptance of a real `@sentry/node@8.55.0` event Envelope delivered by
  the repository's controlled custom transport, plus captured
  `@sentry/react@8.55.0` Envelope coverage. These are deliberately different
  evidence levels; neither is a blanket DSN-only migration claim.
- Ownership of normalized error data, access boundaries, retention, and storage
  policy.
- A public write-only ingest surface separated from the private operator UI,
  API, downloads, health details, and metrics.
- Multi-project issue grouping, filters, occurrence history, resolve/reopen,
  redacted exports, and permanent deletion.
- Bounded retention and live-data safeguards, plus a transactional webhook
  outbox for the supported automation contract.

## From SDK to operator

1. A compatible application sends a supported Sentry event Envelope to a
   project DSN.
2. The public listener validates the DSN key, project, environment, origin, body
   limits, and rate limits.
3. SentryBox admits warning, error, and fatal events; redacts and bounds the
   diagnostic payload; and stores each event idempotently.
4. A versioned fingerprint groups the occurrence into an issue. New and
   regressed issue generations can create durable webhook deliveries.
5. An operator investigates through the private UI/API, filters by project and
   runtime facets, downloads redacted evidence, and manages issue state.

## Current product status

Ingest, storage, grouping, retention, the operator UI/API, and the underlying
project model are implemented for multiple projects and environments. The
current bundled configuration, organization slug, UI permalinks, public hosts,
and project-configuration validator still contain IntexuraOS-specific defaults.
Those defaults are visible constraints, not part of the independent product
boundary. Their removal is tracked separately in
[GitHub issue #27](https://github.com/pbuchman/sentrybox/issues/27).

The current evidence does not prove that an arbitrary application can move by
changing only its DSN. It covers one pinned Node SDK flow through the controlled
custom transport and a captured React Envelope fixture. Traces, transactions,
spans, sessions, profiles, replay, feedback, attachments, and the rest of the
Sentry platform remain outside the product boundary.

## Compatibility summary

SentryBox supports standard DSN authentication, newline-framed event Envelopes,
identity and gzip bodies, browser CORS for configured origins, and the documented
response outcomes. It provides a custom private UI and a small Sentry-shaped read
facade for two tested MCP investigations.

SentryBox is not a drop-in Sentry replacement and is not fully
Sentry-compatible. It does not implement Sentry's UI, complete HTTP API,
telemetry product suite, generic webhook platform, or a bundled MCP server. See
the [normative compatibility matrix](docs/reference/sentry-compatibility.md)
before directing a workload to SentryBox.

## Reference deployment

IntexuraOS on Home Dev is the current reference deployment. It demonstrates
public Envelope ingest, private operator access, immutable container deployment,
monitoring, recovery, credentials, and the supported automation integration. It
is an example deployment rather than the definition of the product.

The repository remains the source of truth for deployment assets and operating
procedures. Start with the
[reference deployment index](docs/examples/intexuraos-home-dev/README.md) for
the current runbooks.

## Documentation

- [Documentation index](docs/README.md)
- [Product and architecture contract](docs/specification.md)
- [Normative Sentry compatibility](docs/reference/sentry-compatibility.md)
- [License](LICENSE)

## Development

Development requires Node.js `>=22.22.2 <23` and pnpm `10.29.3`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
```
