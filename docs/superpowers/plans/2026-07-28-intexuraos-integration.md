# IntexuraOS Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect IntexuraOS to Error Hub with DSN-only reporting changes, preserve the existing Code Agent and Sentry-worker contracts, and remove the two known webhook reservation failure modes before Hub automation is enabled.

**Architecture:** Application reporting remains on `@sentry/node@8.55.0` and `@sentry/react@8.55.0`; only environment-specific DSN values change during cutover. Code Agent continues receiving the current Sentry raw-body HMAC webhook and parsing `event_alert.triggered`, but its reservation repository becomes leased and uses stable issue/event identity. Code workers keep historical SaaS Sentry access and gain a second pinned Sentry-MCP entry pointed at the Hub's private compatibility API.

**Tech Stack:** Existing IntexuraOS TypeScript/Fastify/Firestore stack, Sentry JavaScript SDK 8.55.0, pinned `@sentry/mcp-server@0.37.0`, Vitest, Docker Code Worker, Tailscale private HTTPS.

## Global Constraints

- Tasks 1–6 modify only IntexuraOS. Task 7 adds only the explicitly listed
  acceptance tooling and runbook to Error Hub.
- Do not replace the Sentry SDK, shared logger facade, Code Task schema, `agentType: "sentry"`, `defaultSentryWorkerType`, `sentryIssue`, or `SENTRY_AGENT_FINAL`.
- Do not add a new application logger, general queue refactor, provider rename, or UI redesign.
- Hub webhook bodies remain valid current `event_alert.triggered` payloads; the existing route, HMAC header, raw-body verification, and parser shape remain compatible.
- Hub webhook transition identity comes from the already parsed event ID. Historical Sentry payloads without an event ID keep the legacy fallback.
- Error Hub human and worker reads remain private through Tailscale. The fixed MCP compatibility token is syntactic input for the official client, not authentication.
- Keep the SaaS MCP/token available until every historical Sentry Code Task is terminal.

---

## Task 1: Replace title-based webhook reservation with one leased state machine

**Repository:** `intexuraos-2`

**Files:**

- Modify: `apps/code-agent/src/domain/models/sentryIssueEvent.ts`
- Modify: `apps/code-agent/src/domain/repositories/sentryIssueEventRepository.ts`
- Modify: `apps/code-agent/src/infra/firestore/sentryIssueEventRepository.ts`
- Modify: `apps/code-agent/src/domain/usecases/processSentryWebhook.ts`
- Modify: `firestore-collections.json`
- Test: `apps/code-agent/src/__tests__/infra/firestore/sentryIssueEventRepository.test.ts`
- Test: `apps/code-agent/src/__tests__/usecases/processSentryWebhook.test.ts`

- [ ] Add failing repository tests proving: same Hub event retry is duplicate; two different titles for the same stable issue do not create parallel tasks; identical titles on different issues remain separate; an unexpired reservation blocks; an expired reservation without a task can be reacquired; and a merged/closed previous task permits a later event ID for the same issue.
- [ ] Replace the two-step `reserve()` plus `reserveTaskForProblem()` API with one atomic acquisition contract:

```ts
export interface AcquireSentryTaskReservationInput {
  event: NormalizedSentryIssueEvent;
  receivedAt: Date;
  proposedCodeTaskId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  payload: unknown;
}

export type AcquireSentryTaskReservationResult =
  | { kind: 'acquired'; transitionKey: string; issueKey: string; leaseToken: string; codeTaskId: string }
  | { kind: 'duplicate'; codeTaskId?: string }
  | { kind: 'inspect_linked_task'; codeTaskId: string; transitionKey: string; issueKey: string };
```

- [ ] Build Hub transition keys from organization, project identity, stable issue ID, and event ID. For historical payloads without event ID, retain the current resource/action suffix as a compatibility fallback.
- [ ] Build problem keys from organization, project identity, and stable issue ID; remove normalized title hashing from new records.
- [ ] Store `state: reserved|task_created|failed`, lease token, lease expiry, proposed task ID, event ID, latest delivery time, failure reason, and linked Linear/task IDs. Read legacy documents without these fields and migrate them lazily.
- [ ] In one Firestore transaction, acquire/update the transition and problem documents together. Never leave one reserved when the other rejects the acquisition.
- [ ] Generate the proposed task ID before acquisition and retain it across lease recovery. If it already exists, inspect it rather than creating another task.
- [ ] Add `completeReservation()` and `failReservation()` methods guarded by lease token. A failure before task creation releases the lease for retry; a failure after an idempotent task create records the known task ID.
- [ ] Update `processSentryWebhook()` to classify and verify before acquisition, then create Linear/task/enqueue under the lease, and complete or fail the reservation on every return path.
- [ ] Preserve the current blocking rule for active tasks and open pull requests. Treat merged/closed PRs, archived tasks, deleted linked tasks, and terminal failures as non-blocking for a later Hub event ID.
- [ ] Run `pnpm --filter @intexuraos/code-agent test -- processSentryWebhook sentryIssueEventRepository`; expect all crash-window and concurrency tests to pass.
- [ ] Commit with `fix(code-agent): make sentry task reservation retryable`.

## Task 2: Preserve the exact webhook ingress contract

**Repository:** `intexuraos-2`

**Files:**

- Test: `apps/code-agent/src/__tests__/infra/sentry-event-parser.test.ts`
- Test: `apps/code-agent/src/__tests__/infra/sentry-webhook-auth.test.ts`
- Test: `apps/code-agent/src/__tests__/routes/webhooks/sentry.test.ts`
- Create fixture: `apps/code-agent/src/__tests__/fixtures/error-hub-event-alert.json`

- [ ] Add the exact specification payload as a fixture with a valid 32-character event ID and `/organizations/intexuraos/issues/{id}/` permalink.
- [ ] Add a failing route test posting the raw fixture with `Sentry-Hook-Resource: event_alert` and a lowercase HMAC-SHA256 `Sentry-Hook-Signature`.
- [ ] Assert the current parser produces organization, project ID/slug, issue ID, URL, status, title, and event ID without a Hub-specific body field.
- [ ] Assert byte changes invalidate the signature and exact-byte retries remain valid.
- [ ] Assert `event_alert.triggered` is actionable, repeated delivery of the same event ID is duplicate, and a later event ID can pass the leased issue-state check after the prior task is terminal.
- [ ] Make no route or parser production change if these tests already pass; the deliverable is the compatibility fixture and regression coverage.
- [ ] Run the three focused test files; expect the Error Hub fixture to traverse the real verifier and parser.
- [ ] Commit with `test(code-agent): lock error hub webhook compatibility`.

## Task 3: Pin Sentry MCP and add the Error Hub server entry

**Repository:** `intexuraos-2`

**Files:**

- Modify: `docker/code-worker/Dockerfile`
- Modify: `docker/code-worker/config-defaults/codex-config.toml`
- Modify: `workers/orchestrator/src/services/isolation/types.ts`
- Modify: `workers/orchestrator/src/services/isolation/worker-env.ts`
- Modify: `workers/orchestrator/src/services/task-dispatcher.ts`
- Modify: `workers/orchestrator/src/bootstrap/env-config.ts`
- Modify: `workers/orchestrator/src/bootstrap/service-wiring.ts`
- Test: `workers/orchestrator/src/services/isolation/__tests__/worker-image.test.ts`
- Test: `workers/orchestrator/src/services/isolation/__tests__/types.test.ts`
- Test: `workers/orchestrator/src/services/isolation/__tests__/docker-provider.test.ts`
- Test: `workers/orchestrator/src/__tests__/bootstrap/env-config.test.ts`

- [ ] Write failing image/config tests that reject `latest`, require `@sentry/mcp-server@0.37.0`, and require both `sentry` and `error_hub` MCP entries.
- [ ] Pin the global install in `docker/code-worker/Dockerfile` and invoke the installed `sentry-mcp` binary instead of downloading a package at worker runtime.
- [ ] Keep the existing SaaS entry and add:

```toml
[mcp_servers.error_hub]
command = "sh"
args = ["-lc", 'exec sentry-mcp --access-token tailnet-only --host "$ERROR_HUB_HOST" --disable-skills=seer']
```

- [ ] Read optional startup configuration `INTEXURAOS_ERROR_HUB_HOST`. Reject schemes, paths, credentials, and whitespace; accept a DNS host with optional port. The cutover gate, rather than historical-only startup, requires this value before Hub webhooks can be enabled.
- [ ] Add non-secret `ERROR_HUB_HOST` to the values injected into the worker container without logging all environment values.
- [ ] Keep `SENTRY_AUTH_TOKEN` required and injected during dual-read migration; document its later removal as a separate cleanup, not part of this change.
- [ ] Add tests proving a missing Hub host does not break historical-only operation, an invalid supplied host fails startup clearly, and the exact valid host reaches the container environment.
- [ ] Build the Code Worker image and run `sentry-mcp --version`; expect `0.37.0` and no network installation at task start.
- [ ] Commit with `feat(orchestrator): add pinned error hub mcp target`.

## Task 4: Route worker investigation by issue URL without changing completion

**Repository:** `intexuraos-2`

**Files:**

- Modify: `workers/orchestrator/src/services/prompts/sentry-prompt.ts`
- Create test: `workers/orchestrator/src/__tests__/services/prompts/sentry-prompt.test.ts`
- Test: `workers/orchestrator/src/__tests__/services/completion-verifier/contracts.test.ts`
- Test: `workers/orchestrator/src/services/task-dispatcher/__tests__/completion-pipeline.test.ts`

- [ ] Write failing prompt tests for a `sentry.io` historical SaaS URL and the
  configured private Error Hub permalink host.
- [ ] Instruct the worker to choose `error_hub` MCP when the issue URL host matches `ERROR_HUB_HOST`, and `sentry` MCP for historical SaaS URLs. Do not ask it to query both for one task.
- [ ] Define fallback reads as the same five private Sentry-compatible REST routes. For Hub URLs, the fixed syntactic bearer string carries no authority; network reachability is the access boundary.
- [ ] Keep evidence requirements unchanged: issue details, recent events, stack, tags, culprit, release, environment, frequency, exact issue URL, reproduction, verification, PR, and Linear issue.
- [ ] Keep the exact `SENTRY_AGENT_FINAL` block and `sentry_*` callback fields unchanged. Add regression assertions rather than renaming them.
- [ ] Run the focused prompt and completion tests; expect the only prompt delta to be provider selection instructions.
- [ ] Commit with `feat(orchestrator): route sentry tasks to error hub evidence`.

## Task 5: Prove a real Code Worker can read the private Hub

**Repository:** `intexuraos-2`

**Files:**

- Create: `workers/orchestrator/scripts/verify-error-hub-mcp.mjs`
- Modify: `workers/orchestrator/package.json`
- Test: `workers/orchestrator/src/services/isolation/__tests__/e2e-container.test.ts`

- [ ] Add a failing container test against a disposable local HTTPS-compatible Hub fixture that invokes `get_issue_details` and `search_issue_events` through the `error_hub` MCP entry.
- [ ] Make the verification script accept only issue URL/expected event ID arguments and read the configured host from the environment; it must not accept arbitrary commands.
- [ ] Run the test from the actual Code Worker network and image, not the host Node process.
- [ ] On Home Dev staging, seed a non-production Hub issue and run the script from one disposable Code Worker container. Expect issue title, project, environment, release, stack, and event ID to match.
- [ ] If the worker bridge cannot route to the host Tailscale address, add only the documented host-gateway route in deployment configuration; never attach the Hub private listener to `code-worker-net`.
- [ ] Record the successful command and sanitized output in the deployment evidence; do not enable Code Agent Hub webhooks yet.
- [ ] Commit with `test(orchestrator): verify private error hub mcp access`.

## Task 6: Lock DSN-only reporting compatibility

**Repository:** `intexuraos-2`

**Files:**

- Create: `packages/infra-sentry/src/__tests__/errorHubCompatibility.test.ts`
- Modify only if a test proves necessary: `packages/infra-sentry/src/init.ts`
- Modify only if a test proves necessary: `packages/infra-sentry/src/transport.ts`
- Modify only if a test proves necessary: `apps/web/src/sentryConfig.ts`

- [ ] Start a local envelope-capture fixture and write a failing test that initializes the current Node SDK with an Error Hub-shaped DSN.
- [ ] Emit one Pino warning, error, and fatal plus one debug/info message; assert the SDK targets `/api/{projectId}/envelope/`, includes key/project/release/environment/service, and never requires an application endpoint change.
- [ ] Add a browser configuration test proving the current React config accepts the replacement DSN and retains environment/release.
- [ ] Keep current application source unchanged if the compatibility tests pass. Any source modification requires an observed failing contract and a focused regression test.
- [ ] Do not add a Hub event ID to Pino logs in this migration; correlation uses existing request/trace/task identifiers and the documented time/message fallback.
- [ ] Run `pnpm --filter @intexuraos/infra-sentry test && pnpm --filter @intexuraos/web test`; expect DSN-only compatibility.
- [ ] Commit with `test(sentry): prove error hub dsn compatibility`.

## Task 7: Validate the full automation flow before cutover

**Repositories:** `intexuraos-2` and `intexura-error-hub`

**Files:**

- Create in Hub: `scripts/acceptance/emit-controlled-issue.mjs`
- Create in Hub: `scripts/acceptance/verify-code-agent-flow.mjs`
- Create in Hub: `docs/runbooks/automation-acceptance.md`

- [ ] Make the emitter send one deterministic dev issue event through the real SDK and environment-bound dev DSN; it must refuse a production DSN.
- [ ] Verify Hub storage shows one unresolved issue, the correct project/version/environment, one occurrence, one created outbox row, and a successful HMAC delivery.
- [ ] Verify Code Agent creates exactly one Linear issue and one `agentType: "sentry"` Code Task with the configured `defaultSentryWorkerType`.
- [ ] Retry the same Hub delivery and assert there is no second Linear issue/task.
- [ ] Complete or close the controlled task, resolve the Hub issue, emit a new event ID, and verify exactly one later task can be created for the regression.
- [ ] Verify the real worker reads issue evidence from the Hub and still completes the unchanged `SENTRY_AGENT_FINAL` contract.
- [ ] Keep all production webhook routes disabled throughout this test.
- [ ] Commit Hub acceptance tooling with `test: add code agent automation acceptance flow`.

## Endpoint Changes

### Modified

- `POST /api/code/webhooks/sentry` keeps its request, signature, response, and
  parser contract; its internal duplicate/reservation behavior becomes leased
  and event-ID/stable-issue-ID based.

### Created

- None in IntexuraOS. The worker consumes Error Hub's private Sentry-compatible
  routes defined by the core plan.

### Removed

- None during dual-read migration.

### Unchanged

- The Sentry SDK Envelope endpoint is selected from DSN by the existing SDK.
- `POST /api/code/webhooks/sentry`, `Sentry-Hook-Signature`,
  `Sentry-Hook-Resource`, task payloads, and completion callback fields retain
  their external shapes.
- Historical SaaS Sentry REST/MCP access remains available until its tasks are
  terminal.

## Completion gate

- [ ] Run the Code Agent, orchestrator, worker-image, completion, infra-sentry, and web focused test suites from a clean IntexuraOS checkout.
- [ ] Run IntexuraOS tracked verification required by `.claude/CLAUDE.md` for the changed apps/packages.
- [ ] Confirm `rg -n "@sentry/mcp-server@latest|npx @sentry/mcp-server@latest" docker workers` returns no runtime use.
- [ ] Confirm existing historical Sentry task fixtures still pass unchanged.
- [ ] Confirm one Hub issue retry and one Hub regression have the expected one-task-per-transition behavior.
- [ ] Do not enable production Hub webhooks until the Home Dev deployment/cutover plan reaches its explicit production gate.
