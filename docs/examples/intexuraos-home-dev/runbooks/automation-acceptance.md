# Code Agent automation acceptance

This runbook proves the development-only SentryBox automation path before any
production webhook destination is enabled. It uses one deterministic issue per
operator-chosen run ID and the real `@sentry/node@8.55.0` SDK.

The acceptance path is:

```text
backend-dev DSN -> SentryBox ingest/grouping/outbox -> signed Code Agent webhook
  -> one Linear issue -> one agentType=sentry Code Task -> private SentryBox evidence
```

Production SentryBox webhook destinations and production Sentry webhook
sources remain unchanged throughout this procedure.

## Preconditions

1. SentryBox readiness is healthy on the private Home Dev Tailscale origin.
2. The backend development DSN is available only as `ERROR_HUB_DEV_DSN`. Do not
   use a generic Sentry variable or a production DSN. The emitter also fixes
   `environment=dev`, project ID `1`, and the public SentryBox hostname. A production
   key is rejected by SentryBox's environment binding and makes the command fail.
3. Dev Code Agent delivery is `live`; both production destinations are still
   `disabled`. Validate the stored project configuration before and after the
   run.
4. The Code Agent reservation fix and the pinned dual MCP worker image are the
   versions deployed on Home Dev.
5. Obtain a short-lived development Auth0 access token without printing it or
   storing it in shell history. The verifier reads it only from
   `CODE_AGENT_DEV_AUTH_TOKEN` and never includes it in output.
6. Pick a unique, non-secret run ID such as `home-dev-2026-07-29-a`. Reusing the
   same ID intentionally addresses the same deterministic issue.

Set the non-secret endpoints and the secret values in a history-disabled
interactive shell:

```bash
export ERROR_HUB_PRIVATE_ORIGIN="https://<home-dev-tailnet-name>:8443"
export CODE_AGENT_DEV_BASE_URL="https://dev.intexuraos.cloud/api/code"
export ERROR_HUB_ACCEPTANCE_ENVIRONMENT="dev"
export ERROR_HUB_ACCEPTANCE_RUN_ID="home-dev-2026-07-29-a"
read -r -s -p "backend-dev SentryBox DSN: " ERROR_HUB_DEV_DSN
export ERROR_HUB_DEV_DSN
read -r -s -p "dev Auth0 token: " CODE_AGENT_DEV_AUTH_TOKEN
export CODE_AGENT_DEV_AUTH_TOKEN
```

Do not run these commands with `NODE_ENV=production`. Neither acceptance script
accepts an arbitrary host, project, environment, Code Agent endpoint, task ID,
or issue ID.

## 1. Create the controlled issue

From the SentryBox checkout:

```bash
node scripts/acceptance/emit-controlled-issue.mjs \
  --phase initial \
  --run-id "$ERROR_HUB_ACCEPTANCE_RUN_ID"

node scripts/acceptance/verify-code-agent-flow.mjs \
  --phase initial \
  --run-id "$ERROR_HUB_ACCEPTANCE_RUN_ID" \
  --wait-seconds 180
```

The verifier requires all of the following at once:

- one unresolved `intexuraos-backend` issue in `dev` at release
  `intexuraos-sentrybox-acceptance@1.0.0`;
- generation `1`, occurrence count `1`, and the deterministic event ID;
- exactly one generation-1 outbox row in `delivered` state, proving the HMAC
  was accepted by Code Agent;
- exactly one current Code Task containing the exact private SentryBox issue URL,
  with `agentType=sentry` and the configured `defaultSentryWorkerType`;
- one hydrated Linear identifier matching that task's `linearIssueId`.

Record only the sanitized `issueId`, `taskId`, `linearIssueId`, generation, and
occurrence count printed by the verifier.

## 2. Prove idempotent retry

Send the identical event ID by repeating the deterministic initial transition:

```bash
node scripts/acceptance/emit-controlled-issue.mjs \
  --phase duplicate \
  --run-id "$ERROR_HUB_ACCEPTANCE_RUN_ID"

node scripts/acceptance/verify-code-agent-flow.mjs \
  --phase duplicate \
  --run-id "$ERROR_HUB_ACCEPTANCE_RUN_ID" \
  --wait-seconds 60
```

The occurrence count, outbox count, Linear identity, and Code Task identity must
remain unchanged. Any second task, second Linear issue, second event, or second
outbox row is a stop condition.

## 3. Prove private worker evidence access

Before allowing the controlled task to complete, run the IntexuraOS verifier
from the actual pinned Code Worker image and network:

```bash
pnpm --filter @intexuraos/orchestrator verify:error-hub-mcp \
  "<exact private issue URL from the verifier>" \
  "<controlled event ID from the emitter>"
```

The command must report the same title, project, environment, release, stack,
and event ID. It must use the `error_hub` MCP entry, must not query SaaS Sentry,
and must not attach SentryBox to `code-worker-net`.

If an authenticated worker completes the controlled Code Task, verify the
unchanged completion contract:

```bash
node scripts/acceptance/verify-code-agent-flow.mjs \
  --phase completed \
  --run-id "$ERROR_HUB_ACCEPTANCE_RUN_ID" \
  --wait-seconds 300
```

This requires a successful terminal task, a received callback, the exact SentryBox
issue URL, `fixed|suppressed`, PR URL, Linear URL, and non-empty verification in
the existing `sentry_*` result fields. If Home Dev intentionally has no active
Codex/Claude authorization, do not add credentials merely to make this task
run; the direct real-image MCP check remains the evidence-read gate, and the
existing completion contract suite remains mandatory.

## 4. Close the first transition and resolve the SentryBox issue

Keep the `taskId` and `linearIssueId` from step 1 as non-secret evidence. The
close phase deletes only the single task selected by the exact controlled SentryBox
URL and resolves only the corresponding SentryBox issue. It refuses the mutation
without an exact confirmation value:

```bash
export ERROR_HUB_ACCEPTANCE_ALLOW_CONTROLLED_MUTATION="delete-controlled-task-and-resolve-dev-issue"

node scripts/acceptance/verify-code-agent-flow.mjs \
  --phase close \
  --run-id "$ERROR_HUB_ACCEPTANCE_RUN_ID" \
  --wait-seconds 0

unset ERROR_HUB_ACCEPTANCE_ALLOW_CONTROLLED_MUTATION
```

Do not substitute a task or issue ID on the command line. The script derives
both from the deterministic run and verifies every identity before mutation.

## 5. Prove one later regression transition

Emit the same grouped fault with its deterministic second event ID:

```bash
node scripts/acceptance/emit-controlled-issue.mjs \
  --phase regression \
  --run-id "$ERROR_HUB_ACCEPTANCE_RUN_ID"

node scripts/acceptance/verify-code-agent-flow.mjs \
  --phase regression \
  --run-id "$ERROR_HUB_ACCEPTANCE_RUN_ID" \
  --prior-task-id "<taskId from step 1>" \
  --prior-linear-issue-id "<linearIssueId from step 1>" \
  --wait-seconds 180
```

The final state must be one unresolved issue at generation `2`, two distinct
events, two delivered outbox generations, and exactly one new current Code
Task with a new Linear issue. Repeating the regression emission must not create
another transition.

## 6. Final safety checks

1. Re-run project configuration validation and require production Code Agent
   delivery to remain `disabled`.
2. Confirm no production DSN, production webhook, or production Sentry source
   changed during the run.
3. Confirm no dead-letter outbox rows and that readiness, retention, backup,
   storage, and Tailscale worker access remain healthy.
4. Unset the DSN and Auth0 variables in the interactive shell.
5. Preserve only sanitized timestamps and the SentryBox/Code Task/Linear IDs. Never
   preserve DSNs, HMACs, access tokens, webhook bodies, or credential hashes.

Failure of any assertion stops the cutover. Do not enable production SentryBox
webhooks until this full development sequence and the separate production gate
are green.
