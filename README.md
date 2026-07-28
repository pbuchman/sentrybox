# Intexura Error Hub

Intexura Error Hub is a small, self-hosted error tracker designed for IntexuraOS.
It accepts the Sentry JavaScript SDK protocol, groups warning, error, and fatal events,
provides a private operational UI, and emits Sentry-compatible webhooks to the
existing IntexuraOS Code Agent automation.

The repository currently contains the approved product specification and the
implementation, deployment, and migration plans. Runtime code has not been
implemented yet.

## Scope

- Sentry-compatible DSN ingestion for the exact SDK versions used by IntexuraOS.
- `warning`, `error`, and `fatal` events only.
- Grouping, filtering, download, resolve, reopen, and permanent deletion.
- Project, release, environment, service, and severity facets.
- Correlation links into the existing IntexuraOS log platform.
- Sentry-compatible webhooks for the current Code Agent flow.
- Private UI and read APIs exposed through Tailscale; public write-only ingest.
- Thirty-day retention with a hard 5 GiB Home Dev storage budget.

## Documents

- [Product and architecture specification](docs/specification.md)
- [Core implementation plan](docs/superpowers/plans/2026-07-28-error-hub-core-implementation.md)
- [IntexuraOS integration plan](docs/superpowers/plans/2026-07-28-intexuraos-integration.md)
- [Home Dev deployment and cutover plan](docs/superpowers/plans/2026-07-28-home-dev-deployment-and-cutover.md)

## Status

Design and execution plans are complete; implementation has not started.

## License

[MIT](LICENSE)
