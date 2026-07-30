# IntexuraOS on Home Dev

**Status:** Current live reference deployment

IntexuraOS on Home Dev is the concrete deployment used to exercise SentryBox's
supported event flow and operating model. It is an example of the independent
product, not a requirement for other SentryBox installations.

## Deployment shape

- `errors.intexuraos.cloud` provides public, write-only Envelope ingest.
- The operator UI, private API, downloads, detailed health, and metrics are
  available only through the Home Dev tailnet.
- GitHub Actions publishes immutable `ghcr.io/pbuchman/sentrybox:sha-<commit>`
  images. The Home Dev deployment records and rolls back exact image digests.
- Live SQLite data is stored under
  `/home/pbuchman/services/sentrybox/data`; root-private deployment, monitor,
  backup, and restore state is stored under `/var/lib/sentrybox-deploy`.
- A five-minute host monitor checks readiness, live-data thresholds, retention,
  delivery failures, response pressure, backup posture, and restore-test age.
- No external backup target is currently configured. Scheduled external backup
  therefore reports `disabled/degraded` instead of claiming success or
  accumulating unbounded root-filesystem snapshots. Pre-deployment rollback
  snapshots and local retained-snapshot scrubs remain bounded and independently
  verified.

## Active runbooks

- [Project configuration](runbooks/project-configuration.md)
- [Network exposure](runbooks/network-exposure.md)
- [Operations and monitoring](runbooks/operations.md)
- [Backup and recovery](runbooks/backup-and-recovery.md)
- [Credential rotation](runbooks/credential-rotation.md)
- [Code Agent automation acceptance](runbooks/automation-acceptance.md)

For product-neutral behavior and compatibility limits, return to the
[documentation index](../../README.md).
