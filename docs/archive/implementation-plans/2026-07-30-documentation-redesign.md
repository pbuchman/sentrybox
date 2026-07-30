# SentryBox Documentation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ambiguous Sentry replacement messaging with an accurate, navigable product story and a tested compatibility contract while preserving IntexuraOS/Home Dev as the reference deployment.

**Architecture:** A small documentation checker protects objective repository properties, product and compatibility pages own stable claims, and tenant-specific operations move under one example deployment. Historical plans and the completed cutover remain available under `docs/archive/` but no longer appear as active guidance.

**Tech Stack:** Markdown, Node.js 22 built-in test runner, Bash syntax validation, pnpm, GitHub Actions.

## Global Constraints

- Product documentation is written in English.
- SentryBox is independent and multi-project; IntexuraOS/Home Dev is the current reference deployment.
- Sentry compatibility is a precise tested subset, never a full or drop-in Sentry replacement.
- Evidence is limited to `@sentry/node@8.55.0`, `@sentry/react@8.55.0`, and the repository tests.
- Current hard-coded organization, route, host, and project-validator assumptions must remain visible and are not generalized in this change.
- Active product pages contain no Home Dev paths, IntexuraOS domains, or Code Agent deployment instructions.
- `docs/examples/intexuraos-home-dev/` owns active reference-deployment runbooks.
- `docs/archive/` owns completed implementation plans and retired cutover material.
- Do not change application behavior or deployment assets.

---

### Task 1: Add the documentation verifier

**Files:**
- Create: `scripts/docs/verify-documentation.mjs`
- Create: `scripts/docs/verify-documentation.test.mjs`

**Interfaces:**
- Consumes: a repository root and a list of Markdown files.
- Produces: exported validation functions plus a CLI with exit code `0` for a valid tree and non-zero with file-scoped diagnostics for violations.

- [ ] **Step 1: Write failing unit tests with temporary Markdown fixtures**

Cover one valid relative link, one missing local link, valid and invalid fenced
`bash` syntax, an external link that is ignored, archive exclusion, and each
forbidden unqualified claim category. Derive expected diagnostic strings as
literals and exercise the real filesystem and Bash parser.

- [ ] **Step 2: Verify the tests fail because the module is absent**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test scripts/docs/verify-documentation.test.mjs`  
Expected: FAIL because `verify-documentation.mjs` does not exist.

- [ ] **Step 3: Implement the minimal verifier**

Scan `README.md` and Markdown below `docs/`, excluding `docs/archive/`. Resolve
relative link targets against the source document, ignore absolute URLs and
fragment-only links, validate fenced `bash`/`sh` blocks with `bash -n`, and
reject these misleading claims case-insensitively: drop-in/full Sentry
replacement, fully Sentry-compatible, built-in/native MCP, same grouping as
Sentry, guaranteed 30-day history, and a hard 5 GiB total limit.

- [ ] **Step 4: Run the focused tests**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test scripts/docs/verify-documentation.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `test: add documentation contract verifier`

### Task 2: Rewrite the product and compatibility documentation

**Files:**
- Modify: `README.md`
- Create: `docs/README.md`
- Rewrite: `docs/specification.md`
- Create: `docs/reference/sentry-compatibility.md`

**Interfaces:**
- Consumes: verified behavior in source and tests.
- Produces: the stable product entry point, navigation page, neutral contract, and normative Sentry compatibility matrix.

- [ ] **Step 1: Rewrite `README.md`**

Use this order: problem and audience; value; compact SDK-to-operator flow;
current product status; supported/non-goal summary; reference deployment; docs
map; development commands. Explicitly say that a DSN-only move applies to the
verified event flow and that current IntexuraOS-specific defaults remain.

- [ ] **Step 2: Add `docs/README.md`**

Group links as Product, Reference, Example deployment and operations, and
Historical. Do not present archived plans as current work.

- [ ] **Step 3: Add the normative compatibility matrix**

Use `Supported`, `Partial`, and `Not supported` rows for SDK/DSN, Envelope,
levels and responses, event fidelity, UI/API, webhook, MCP reads, retention, and
storage. Include all version limits, unsupported item types, five-route facade,
external MCP package/version, and timestamp/request/service fidelity gaps from
the approved design.

- [ ] **Step 4: Replace the mixed specification with a neutral contract**

Retain product scope, architecture, data model, ingest, normalization,
grouping/lifecycle, privacy, storage/retention, API categories, operations, and
acceptance invariants. Link protocol details to the compatibility page. Remove
tenant domains, user paths, current disk readings, migration chronology, and
Home Dev/Code Agent procedures.

- [ ] **Step 5: Validate the focused product pages**

Run the verifier against the product pages and run:
`rg -n 'errors\.intexuraos\.cloud|/home/pbuchman|Code Agent' README.md docs/specification.md docs/reference/sentry-compatibility.md`  
Expected: no tenant deployment details in product pages; compatibility names
Code Agent only where it precisely scopes the webhook contract.

- [ ] **Step 6: Commit**

Commit message: `docs: redefine SentryBox product and compatibility`

### Task 3: Separate the reference deployment and wire documentation CI

**Files:**
- Move: `docs/runbooks/*.md` to `docs/examples/intexuraos-home-dev/runbooks/`
- Move: `docs/examples/intexuraos-home-dev/runbooks/dev-direct-cutover.md` to `docs/archive/cutover/dev-direct-cutover.md`
- Move: `docs/superpowers/plans/*.md` to `docs/archive/implementation-plans/`
- Create: `docs/examples/intexuraos-home-dev/README.md`
- Modify: moved runbooks and every affected local link
- Modify: `test/container/runtime-contract.test.mjs`
- Modify: `test/ci/workflow-policy.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-image.yml`

**Interfaces:**
- Consumes: the verifier CLI from Task 1 and navigation from Task 2.
- Produces: one active reference-deployment tree, one historical tree, and a `test:docs` command run by CI and release validation.

- [ ] **Step 1: Move files with history and add the example index**

The index identifies IntexuraOS/Home Dev as the current live deployment,
summarizes public ingest, private UI/API, immutable GHCR deployment, state/data,
monitoring, and the disabled/degraded external-backup posture, then links every
active runbook.

- [ ] **Step 2: Update repository contracts before changing their targets**

Change existing tests to use the new example and archive paths and to verify
stable behavior instead of transient free-disk numbers. Run the focused tests
and confirm they fail on paths that have not yet been fully rewired.

- [ ] **Step 3: Repair all moved-document links and references**

Update product navigation, runbook cross-links, plan historical links, and test
fixtures. No active link may point to `docs/runbooks/` or
`docs/superpowers/plans/`.

- [ ] **Step 4: Wire the verifier into repository checks**

Add `test:docs` to `package.json`, include it in `pnpm test`, and add a named
documentation-contract step to both CI and release workflows before build/test.

- [ ] **Step 5: Run focused and full checks**

Run:
`PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:docs`  
`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test test/ci/workflow-policy.test.mjs test/container/runtime-contract.test.mjs`  
`PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm format:check`  
Expected: all pass with no broken active links, shell syntax errors, stale active
paths, or forbidden claims.

- [ ] **Step 6: Commit**

Commit message: `docs: organize reference deployment and history`

### Task 4: Final SentryBox verification

**Files:**
- Verify only; fix files only when a prior task's review identifies a concrete defect.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a merge-ready branch and evidence for the whole-branch review.

- [ ] **Step 1: Run the complete quality suite on Node 22**

Run, in order: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`,
`pnpm test`, and `pnpm test:integration`, with
`/opt/homebrew/opt/node@22/bin` first on `PATH`.

- [ ] **Step 2: Run repository diff checks**

Run: `git diff --check origin/main...HEAD` and inspect `git status --short`.

- [ ] **Step 3: Request whole-branch review**

Review against the approved design and every Global Constraint above. Resolve
all Critical and Important findings before publication.

