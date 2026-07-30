# Home Dev operations

Run the Home Dev operational check from the canonical checkout as root:

```bash
sudo /home/pbuchman/deploy/sentrybox/deploy/home-dev/monitor.sh
```

The installed `sentrybox-monitor.timer` runs this check every five minutes,
with a bounded 30-second randomized delay. The oneshot service writes only to
the host journal and has no separate log file. This is a monotonic timer: it
starts two minutes after boot and does not replay checks missed while the host
was down. The command exits `0` only when
all checks are healthy. It exits non-zero for an alert and sends a structured
record to the host journal with
`SENTRYBOX_COMPONENT=operations`, `SENTRYBOX_CHECK=home_dev`, and a sanitized
`SENTRYBOX_ALERTS` value. This is the private operator alert surface: inspect
it only on the Home Dev host or through an already-authorized private journal
reader. Do not copy event payloads, DSNs, HMACs, tokens, or downloaded exports
into tickets, chat, or journal fields.

Inspect the latest check without asking it to render application data:

```bash
sudo journalctl --output=json --since '26 hours ago' \
  | jq -c 'select(.SENTRYBOX_COMPONENT == "operations" and .SENTRYBOX_CHECK == "home_dev")'
```

The monitor reads only the private Tailscale `/health/ready` and `/metrics`
endpoints plus root-private operational state under
`/var/lib/sentrybox-deploy`. It alerts for:

- failed readiness;
- physical data above `4.5 GiB` (`4,831,838,208` bytes);
- physical data at or above `4.75 GiB` (`5,100,273,664` bytes), where ingest
  must be disabled by the runtime;
- a failed latest retention run or any dead-letter webhook;
- unavailable or oversized private metrics (responses are capped at `256 KiB`);
- a delta of two or more application-generated `429` or `503` ingest
  responses since the previous five-minute observation; and
- external backup status `disabled/degraded`, independently from a failed or
  unavailable local retained-snapshot scrub, a scrub result older than 26
  hours, or a result future-dated by more than five minutes; and
- a successful restore test older than 35 days or future-dated by more than
  five minutes.

The application counters do not include `429` or `503` responses generated at
the Caddy or another proxy edge. The monitor stores the prior application
counter values and observation timestamp atomically in a root-owned, mode
`0600`, singly linked file. Its first observation establishes a baseline;
counter decreases are treated as runtime resets, and gaps over ten minutes
re-establish the baseline rather than accumulating an unbounded total.
The latest-retention gauge likewise prevents an old failure from keeping the
check failed after a later retention run succeeds.

The current Home Dev installation intentionally has no external backup target.
Its daily backup unit is therefore expected to report `disabled/degraded` and
exit non-zero instead of creating unbounded root-filesystem snapshots. It
records that outcome separately in root-private `backup.state`, alongside the
latest local retained-snapshot scrub outcome. Lock contention, an invalid
snapshot, or a failed scrub is an additional alert and is never collapsed into
the expected external degradation. The local `predeploy.sqlite` rollback
snapshot is never treated as external backup success, regardless of its
modification time. With no transport configured,
the backup job never creates `backup.success`, so
`backup_disabled_degraded` is the expected monitor result. A future success
marker may be published only after a real off-host upload and checksum
verification. Do not add GCS, R2, or another storage target ad hoc.

## Response sequence

1. Keep the failing journal record and its timestamp; it contains only the
   sanitized alert names needed for triage.
2. For readiness or ingest-disabled alerts, pause changes and inspect the
   private health and metrics endpoints from the tailnet. Do not expose either
   endpoint publicly to make diagnosis easier.
3. For retention, dead-letter, or repeated-response alerts, inspect the
   private UI and the existing private Code Agent workflow. Treat a dead-letter
   as a delivery incident rather than retrying it by copying a webhook body.
4. For backup or restore alerts, follow
   [backup and recovery](backup-and-recovery.md). A failed restore test must
   not be "fixed" by writing its success marker or restoring over live data.
5. Before closing an incident, re-run the monitor. Until an approved external
   backup target exists, require that all alerts except the documented
   `backup_disabled_degraded` condition are cleared.

## Journal hygiene

The operational check intentionally sends fixed metadata only: message,
priority, component, check name, and alert names. It must never emit an event
payload, DSN, HMAC, token, downloaded export, request body, URL containing a
credential, or raw response body. Verify this after changing monitoring:

```bash
sudo journalctl --output=json --since '26 hours ago' \
  | jq -c 'select(.SENTRYBOX_COMPONENT == "operations")' \
  | grep -Eqi 'dsn=|hmac=|token=|downloaded_export=' && exit 1 || true
```

The command above is a negative check on the monitor's own structured records;
it does not authorize searching or exporting application event content.
