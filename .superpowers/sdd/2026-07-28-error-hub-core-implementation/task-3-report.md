# Task 3 report — normalize, redact, and classify accepted events

## Scope and files

- Added `packages/protocol/src/limits.ts` for byte-aware normalization limits.
- Added `packages/protocol/src/redact.ts` for recursive key/value redaction.
- Added `packages/protocol/src/normalize.ts` for severity admission, bounded normalization, and correlation extraction.
- Added `packages/protocol/src/normalize.test.ts` and `packages/protocol/src/redact.test.ts`.
- Updated `packages/protocol/src/index.ts` to export the protocol API and types.

No grouping, persistence, routes, or forwarding were implemented.

## RED evidence

1. After the initial tests were added, `pnpm --filter @intexura-error-hub/protocol test -- normalize.test.ts redact.test.ts` failed with all new admission, correlation, limit, and redaction cases because `admitEvent`, `normalizeEvent`, and `redactValue` were absent.
2. After correcting a malformed nested test fixture, the focused run had 17 expected missing-API failures and no test-transform failure.
3. The first full normalization pass left one expected assertion mismatch: a long message also derives the title, so both `title_bytes` and `message_bytes` are recorded. The test was corrected to assert real byte/collection behavior and the deterministic reason order.
4. The whole-result secret fixture failed before the last redaction fixes, exposing unredacted top-level title/exception values and request URL query values.
5. The no-header request URL fixture failed before URL sanitization was moved ahead of recursive pattern replacement and made unconditional.
6. The selected-alias fixture failed before `payload.correlations` was added.
7. The scalar metadata fixture failed before release/environment/server/platform/logger were pattern-redacted.

## GREEN and full verification

All commands used `PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH`.

| Command | Result |
| --- | --- |
| `pnpm --filter @intexura-error-hub/protocol test` | PASS — 4 files, 35 tests |
| `pnpm format:check` | PASS |
| `pnpm --filter @intexura-error-hub/protocol lint` | PASS |
| `pnpm --filter @intexura-error-hub/protocol typecheck` | PASS |
| `pnpm --filter @intexura-error-hub/protocol build` | PASS |
| `git diff --check` | PASS |

## Edge-case decisions

- `warning` and `warn` normalize to `warn`; `error` and `fatal` are retained. `trace`, `debug`, `info`, unknown levels, and no-level non-exception events are discarded as `below_threshold`.
- A missing level with a non-empty exception is retained as canonical `error`.
- All byte limits use UTF-8 byte length and preserve complete code points: title/message 4 KiB, 200 frames, 100 breadcrumbs, 100 tags, tag keys 200 B, tag values 1 KiB, recursion depth 8, and normalized event JSON below 512 KiB.
- Truncation reasons are collected in deterministic normalization order. Oversized event data is compacted by dropping redacted payload data, then breadcrumbs/frames/tags, while retaining an explicit `normalized_json` reason.
- `contentPreview` is omitted exactly, recursively. Sensitive keys are redacted case-insensitively; bearer tokens, API keys, DSNs, cookie expressions, and emails are pattern-redacted in all persistence-facing strings.
- Request contexts retain only diagnostic headers. URLs remove username/password and redact sensitive query values while retaining non-sensitive query parameters.
- Correlation order is tags, then direct extras, then contexts. Within each source `requestId`/`request_id` wins over `reqId`/`req_id`; trace direct fields win before `contexts.trace.trace_id`. Nested arbitrary values are not searched. The selected canonical value and redacted `{ source, alias, value }` evidence are stored in `payload.correlations`.

## Self-review

- Verified no persistence-facing normalization result includes raw contexts, extras, breadcrumbs, exception values, title/message, or scalar metadata; the serialized-fixture tests cover all forbidden values and `contentPreview`.
- Verified JSON-cap enforcement operates after redaction and updates `payloadBytes`, `truncated`, and reasons.
- Verified no scope beyond normalization/redaction/admission was introduced.

## Commit

Committed with `feat(protocol): normalize and redact error events`.

## Concerns

- The mandatory repository rule file `.claude/CLAUDE.md` was absent at session start, so its referenced files could not be read. Work followed the available task brief and specification instead.

## Fix round 1 — review hardening

### Finding-to-test mapping

1. Redaction bypasses: `redact.test.ts` now covers generic `auth`/`authentication`, Basic/Digest/Bearer forms, complete multi-cookie strings, and null-prototype records. `normalize.test.ts` checks a long original sensitive tag key and asserts every adversarial value is absent from the whole serialized result.
2. URL fail-closed behavior: `normalize.test.ts` covers both a relative URL and malformed absolute URL with userinfo and sensitive query values. Both preserve the safe `page=2` parameter without retaining credentials or sensitive values.
3. Hard JSON cap: a table test independently sends oversized multibyte `requestId`, `traceId`, and `taskId`; each serialized result is at most 512 KiB. Correlations are UTF-8 bounded before top-level and payload evidence use, and cap reduction ends in an explicit final hard fallback.
4. Diagnostic shapes: an allowlist test verifies frames, breadcrumbs, contexts, extras, and request data discard unknown user fields and that contexts/extras are stored only in `payload`.
5. Recursion metadata: a deep extra test asserts both the recursion marker and event `truncated: true` with `recursion_depth`.
6. Exception chain evidence: a causal multi-entry test selects the first meaningful exception after an empty entry and records its remaining discarded meaningful chain count with `exception_chain`.
7. Tag determinism: the tag test covers exact 100-entry retention, code-point deterministic ordering, and a truncated-key collision that retains the first sorted original key. It also covers original-key sensitive matching before key truncation.

### RED and GREEN evidence

- RED: the initial focused run failed 10 new adversarial tests across all seven findings (three independent oversized-correlation cases included). A final correlation regression then failed because the prior code manufactured `[REDACTED]` as a canonical ID; the new test drove its rejection.
- GREEN: `pnpm --filter @intexura-error-hub/protocol test` passes 4 files / 46 tests.

### Commands and results

All commands used `PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH`.

| Command | Result |
| --- | --- |
| `pnpm --filter @intexura-error-hub/protocol test` | PASS — 4 files, 46 tests |
| `pnpm format:check` | PASS |
| `pnpm --filter @intexura-error-hub/protocol lint` | PASS |
| `pnpm --filter @intexura-error-hub/protocol typecheck` | PASS |
| `pnpm --filter @intexura-error-hub/protocol build` | PASS |
| `git diff --check` | PASS |

### Self-review

- Secret matching now examines original keys before tag-key truncation, and all returned diagnostic records use null-prototype accumulators.
- Recursive redaction returns explicit truncation metadata; no persistence-facing normalization output duplicates contexts or extras.
- Every retained variable string passes UTF-8 bounds before the global cap. Correlation lookup remains source-limited and now rejects values changed by secret redaction rather than inventing an ID.
- The change remains confined to protocol normalization/redaction/tests/report; it adds no grouping, storage, routes, or forwarding.

### Commit

Separate fix commit: `fix(protocol): harden normalized event boundaries`.
