import type { NormalizedEventInput } from "@sentrybox/protocol";
import { fingerprintEvent, type FingerprintResult } from "./fingerprint.js";

export interface ScopedIssueInput {
  readonly projectId: number;
  readonly event: NormalizedEventInput;
}

export interface ScopedIssueKey {
  readonly projectId: number;
  readonly fingerprintVersion: 1;
  readonly fingerprint: string;
}

/**
 * Creates the storage grouping tuple after the ingest boundary has verified the
 * project identity. Payload-derived fingerprints deliberately have no project
 * identity, so the same event payload can be scoped safely by this tuple.
 */
export function scopedIssueKey(input: ScopedIssueInput): ScopedIssueKey {
  const fingerprint = fingerprintEvent(input.event);
  return scopedIssueKeyForFingerprint(input.projectId, fingerprint);
}

export function scopedIssueKeyForFingerprint(
  projectId: number,
  fingerprint: FingerprintResult,
): ScopedIssueKey {
  if (!Number.isSafeInteger(projectId) || projectId < 0) {
    throw new Error("projectId must be a non-negative safe integer");
  }
  return {
    projectId,
    fingerprintVersion: fingerprint.version,
    fingerprint: fingerprint.digest,
  };
}
