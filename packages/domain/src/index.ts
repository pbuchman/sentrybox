export { scopedIssueKey, scopedIssueKeyForFingerprint } from "./event.js";
export type { ScopedIssueInput, ScopedIssueKey } from "./event.js";
export { fingerprintEvent } from "./fingerprint.js";
export type { FingerprintResult } from "./fingerprint.js";
export { normalizeMessageTemplate } from "./message-normalization.js";
export {
  decideDelete,
  decideManualReopen,
  decideOccurrence,
  decideResolve,
} from "./lifecycle.js";
export type {
  DeleteDecision,
  IssueSnapshot,
  IssueStatus,
  ManualReopenDecision,
  OccurrenceDecision,
  ResolvedIssueSnapshot,
  ResolveDecision,
  UnresolvedIssueSnapshot,
} from "./lifecycle.js";
