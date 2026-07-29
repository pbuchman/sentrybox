# Backup and recovery

## Current Home Dev state

Home Dev has no configured external backup target, external backup mount, or
backup transport. `sentrybox-backup.timer` therefore starts a service that exits
non-zero and reports `disabled/degraded`; it does not claim success and does not
accumulate local daily snapshots. When `predeploy.sqlite` exists, the scheduled
run first re-applies the 23-day retention profile to that same snapshot while
holding the deployment lock.

Inspect the explicit degraded state:

```bash
sudo systemctl start sentrybox-backup.service
sudo systemctl status --no-pager sentrybox-backup.service
sudo journalctl -u sentrybox-backup.service --since today --no-pager
```

The application remains available when this independent oneshot service fails.
The operational monitor treats a local scrub result older than 26 hours, or
future-dated by more than five minutes, as a separate alert in addition to the
expected external-backup degradation.
Do not represent disaster recovery as ready until an encrypted external target,
checksum verification, seven daily generations, and the 23-day backup scrub are
implemented and restore-tested.

## Pre-deployment snapshot

Immediately before a deployment, `backup.sh predeploy` uses SQLite's online
backup API from an immutable SentryBox image. It does not stop the live database
or copy the database/WAL files directly. It atomically replaces
`/home/pbuchman/services/sentrybox/backups/predeploy.sqlite`, keeps the staging
directory bounded, and rejects a result larger than 5 GiB.

The full `predeploy.sqlite` is reserved for deployment rollback until every
health and public-ingest check passes and the new state is safely written.
Before the deployment is committed, SentryBox runs the real retention sweeper
with a 23-day event age against a private copy and atomically replaces the
snapshot. A failed scrub leaves the full rollback snapshot intact and rolls the
deployment back. Automatic rollback replaces the live database only after the
previous runtime proves that the live database is invalid.

## Isolated restore validation

`sentrybox-restore-test.timer` validates `predeploy.sqlite` monthly with the
immutable image digest in `/var/lib/sentrybox-deploy/current.env`. The script
copies the snapshot into a mode-`0700` temporary directory under deployment
state and mounts only that copy into the container. The live data directory is
inaccessible to the unit and is never mounted into the restore container.

On the copy, the current runtime verifies SQLite integrity, rejects a database
newer than the runtime, executes its real migrations with checksum validation,
runs the real initial retention sweep, then verifies integrity, the exact
migration version, and reads of the core project, issue, event, and webhook
tables. The container has no network or secrets. Its named container and the
entire bounded temporary tree are removed after success, failure, or signal.

Run and inspect the restore test:

```bash
sudo systemctl start sentrybox-restore-test.service
sudo systemctl status --no-pager sentrybox-restore-test.service
sudo journalctl -u sentrybox-restore-test.service --since '35 days ago' --no-pager
sudo systemctl list-timers \
  sentrybox-backup.timer sentrybox-restore-test.timer --no-pager
```

Success is the journal message `Pre-deployment SentryBox backup passed restore
validation.` A failure is a recovery-readiness incident; never overwrite the
live database with an unvalidated snapshot.

On success, the restore test atomically updates the private
`/var/lib/sentrybox-deploy/restore-test.success` marker. The operational monitor
uses only this marker's age; never create or modify it manually to suppress a
recovery alert.

## Installation verification

`install.sh` refuses to enable the timers unless `backup.sh`, `monitor.sh`, and
`restore-test.sh` are regular executable files. It runs `systemd-analyze verify`
over the runtime, deployment, backup, monitor, and restore units before reloading
systemd.

```bash
sudo systemd-analyze verify \
  /etc/systemd/system/sentrybox.service \
  /etc/systemd/system/sentrybox-deploy.service \
  /etc/systemd/system/sentrybox-backup.service \
  /etc/systemd/system/sentrybox-backup.timer \
  /etc/systemd/system/sentrybox-monitor.service \
  /etc/systemd/system/sentrybox-monitor.timer \
  /etc/systemd/system/sentrybox-restore-test.service \
  /etc/systemd/system/sentrybox-restore-test.timer
```
