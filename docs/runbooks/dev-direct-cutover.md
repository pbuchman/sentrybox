# Development direct cutover when legacy Sentry is unavailable

Use this development-only path when the legacy Sentry organization cannot
accept or expose events, for example because its monthly event quota is
exhausted. In that state a 48-hour comparison cannot produce evidence and must
not be treated as an acceptance gate that silently passed.

The generic shadow-forwarding feature and the production shadow procedure stay
unchanged. This exception does not authorize a production DSN or webhook
change.

## Preconditions

1. Record that legacy Sentry is unavailable and identify the affected
   development projects.
2. Confirm SentryBox private readiness and public ingest health.
3. Confirm every development IntexuraOS application process uses its
   environment-bound SentryBox DSN; production still uses its existing DSNs.
4. Detach only the development projects from the legacy Sentry alert workflow.
   Preserve production detectors and organization-wide integration settings.
5. Keep both SentryBox development Code Agent destinations disabled until the
   exact Code Worker image can read a controlled issue over the private route.

## Replace shadow comparison with deterministic evidence

1. Disable only development legacy forwarding through the project generator,
   validate `forwarding-mode disabled`, and remove only the matching development
   legacy DSN references from the runtime credential contract.
2. Emit controlled development events and verify:
   - debug and info are discarded;
   - warning, error, and fatal are retained;
   - project, environment, release, service, event ID, exact timestamp, stack,
     grouping, download, and log-correlation fields are correct;
   - an environment mismatch is rejected without changing issue, outbox, or
     forwarding counts.
3. Run the exact immutable Code Worker image on `code-worker-net` and require
   the pinned `error_hub` MCP to return the same controlled issue and event.
4. Add only `CODE_AGENT_HMAC_DEV`, enable only the two development
   destinations, and run the complete
   [Code Agent automation acceptance](automation-acceptance.md): initial,
   duplicate, controlled close, regression, and repeated regression.
5. Require exactly one delivered outbox transition, Linear issue, and Code Task
   per issue generation; duplicates must create none. A deliberately missing
   Codex or Claude authorization may block task execution, but the UI must show
   the precise reason and time. Do not add credentials for this check.
6. Finish with zero pending, retry, or dead-letter outbox rows; production
   destinations remain disabled.

Any failed assertion stops the development cutover. Legacy Sentry availability
is not required for these checks because every assertion is made against the
new ingest, storage, automation, worker, and UI paths that will actually remain
in service.
