# Home Dev operations

Run the Home Dev operational check from the canonical checkout as root:

```bash
sudo /home/pbuchman/deploy/sentrybox/deploy/home-dev/monitor.sh
```

The command exits `0` only when all checks are healthy. It exits non-zero for
an alert and sends a structured record to the host journal with
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
endpoints plus metadata on the bounded pre-deployment snapshot and restore
success marker. It alerts for:

- failed readiness;
- physical data above `4.5 GiB` (`4,831,838,208` bytes);
- physical data at or above `4.75 GiB` (`5,100,273,664` bytes), where ingest
  must be disabled by the runtime;
- any retention failure, dead-letter webhook, or two or more `429` or `503`
  ingest responses in the current runtime;
- a pre-deployment snapshot older than 26 hours; and
- a successful restore test older than 35 days.

The current Home Dev installation intentionally has no external backup target.
Its daily backup unit is therefore expected to report `disabled/degraded` and
exit non-zero instead of creating unbounded root-filesystem snapshots. Treat a
`backup_stale` alert as an explicit recovery-readiness gap until an approved
encrypted external destination is supplied; do not add GCS, R2, or another
storage target ad hoc.

## Response sequence

1. Keep the failing journal record and its timestamp; it contains only the
   sanitized alert names needed for triage.
2. For readiness or ingest-disabled alerts, pause changes and inspect the
   private health and metrics endpoints from the tailnet. Do not expose either
   endpoint publicly to make diagnosis easier.
3. For retention, dead-letter, or repeated-response alerts, inspect the
   private UI and the existing private Code Agent workflow. Treat a dead-letter
   as a delivery incident rather than retrying it by copying a webhook body.
4. For backup or restore age alerts, follow
   [backup and recovery](backup-and-recovery.md). A failed restore test must
   not be "fixed" by writing its success marker or restoring over live data.
5. Before closing an incident, re-run the monitor and require its structured
   success record with `SENTRYBOX_ALERTS=none`.

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
