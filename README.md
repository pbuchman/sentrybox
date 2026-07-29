# SentryBox

SentryBox is an independent, self-hosted, Sentry-compatible error tracker. It
accepts standard Sentry DSNs from multiple applications and projects, groups
warning, error, and fatal events, and provides a private operational UI plus
Sentry-compatible webhooks.

## Scope

- Sentry-compatible DSN ingestion for JavaScript SDK clients.
- Per-project grouping, filtering, download, resolve, reopen, and permanent
  deletion.
- Project, release, environment, service, and severity facets.
- Private UI and read APIs, with public write-only ingest.
- Thirty-day retention with a hard 5 GiB storage budget.

## IntexuraOS Home Dev integration

The bundled Home Dev configuration demonstrates integrating SentryBox with
IntexuraOS. It is an example integration; SentryBox itself is designed for
multiple independent applications and projects.

## Documents

- [Product and architecture specification](docs/specification.md)
- [Core implementation plan](docs/superpowers/plans/2026-07-28-error-hub-core-implementation.md)
- [IntexuraOS integration example](docs/superpowers/plans/2026-07-28-intexuraos-integration.md)
- [Home Dev deployment and cutover plan](docs/superpowers/plans/2026-07-28-home-dev-deployment-and-cutover.md)

## License

[MIT](LICENSE)
