import { useEffect, useState } from "react";

export interface TimeValueProps {
  readonly value: string;
  readonly className?: string;
  readonly compact?: boolean;
}

export function TimeValue({
  value,
  className,
  compact = false,
}: TimeValueProps) {
  const [now, setNow] = useState(() => Date.now());
  const canonical = canonicalTime(value);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return (
    <time
      className={className === undefined ? "time-value" : className}
      dateTime={canonical}
      title={canonical}
    >
      <span className="time-relative">{relativeTime(canonical, now)}</span>
      <span className={compact ? "time-exact sr-only" : "time-exact"}>
        {formatUtc(canonical)}
      </span>
    </time>
  );
}

function canonicalTime(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : value;
}

function relativeTime(value: string, now: number): string {
  const difference = now - Date.parse(value);
  const future = difference < 0;
  const absolute = Math.abs(difference);
  if (absolute < 30_000) return "just now";
  const units: readonly [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [milliseconds, name] of units) {
    if (absolute >= milliseconds) {
      const amount = Math.max(1, Math.round(absolute / milliseconds));
      const phrase = `${String(amount)} ${name}${amount === 1 ? "" : "s"}`;
      return future ? `in ${phrase}` : `${phrase} ago`;
    }
  }
  const seconds = Math.max(1, Math.round(absolute / 1000));
  return future
    ? `in ${String(seconds)} seconds`
    : `${String(seconds)} seconds ago`;
}

function formatUtc(value: string): string {
  const date = new Date(value);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}
