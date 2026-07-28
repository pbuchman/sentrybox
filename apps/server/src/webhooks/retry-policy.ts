export type DeliveryResult = "delivered" | "retry" | "dead_letter";

const RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;
const TWELVE_HOURS_MS = 12 * 60 * 60_000;
const RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;

export function classifyHttpStatus(statusCode: number): DeliveryResult {
  if (
    !Number.isSafeInteger(statusCode) ||
    statusCode < 100 ||
    statusCode > 599
  ) {
    return "dead_letter";
  }
  if (statusCode >= 200 && statusCode < 300) return "delivered";
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    return "retry";
  }
  return "dead_letter";
}

export function nextRetryAt(
  createdAt: string,
  failedAt: string,
  completedAttempt: number,
): string | null {
  if (!Number.isSafeInteger(completedAttempt) || completedAttempt <= 0) {
    throw new TypeError("completed attempt must be a positive safe integer");
  }
  const created = parseTimestamp(createdAt, "creation timestamp");
  const failed = parseTimestamp(failedAt, "failure timestamp");
  const delay = RETRY_DELAYS_MS[completedAttempt - 1] ?? TWELVE_HOURS_MS;
  const candidate = failed + delay;
  if (candidate > created + RETRY_WINDOW_MS) return null;
  return new Date(candidate).toISOString();
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}
