import { createHash } from "node:crypto";
import type { NormalizedEventInput } from "@intexura-error-hub/protocol";
import { normalizeMessageTemplate } from "./message-normalization.js";

export interface FingerprintResult {
  readonly version: 1;
  readonly digest: string;
  readonly explanation: readonly string[];
}

type FingerprintPart = readonly [name: string, value: string];

export function fingerprintEvent(
  event: NormalizedEventInput,
): FingerprintResult {
  const explicitFingerprint = nonDefaultExplicitFingerprint(event.fingerprint);
  const exception = selectedException(event.exception);
  const service =
    meaningfulText(event.server_name) ??
    meaningfulText(tag(event.tags, "service")) ??
    "";

  if (explicitFingerprint !== null) {
    return fingerprint(
      [
        ["strategy", "explicit"],
        ["exceptionType", exception.type],
        ["service", service],
        ...explicitFingerprint.map(
          (value, index) => [`fingerprint[${index}]`, value] as const,
        ),
      ],
      ["explicit fingerprint values", "exception type", "service"],
    );
  }

  if (exception.present) {
    const frames = applicationFrames(exception.frames);
    return fingerprint(
      [
        ["strategy", "exception"],
        ["exceptionType", exception.type],
        ["message", normalizeMessageTemplate(exception.value)],
        ["service", service],
        ...frames.flatMap(
          (frame, index) =>
            [
              [`frame[${index}].module`, frame.module],
              [`frame[${index}].filename`, frame.filename],
              [`frame[${index}].function`, frame.functionName],
            ] as const,
        ),
      ],
      [
        "exception type",
        "normalized exception message",
        "service",
        `${frames.length} application frame${frames.length === 1 ? "" : "s"}`,
      ],
    );
  }

  return fingerprint(
    [
      ["strategy", "warning"],
      ["logger", text(event.logger) ?? ""],
      ["service", service],
      [
        "message",
        normalizeMessageTemplate(
          text(event.message) ?? text(event.title) ?? "",
        ),
      ],
    ],
    ["logger", "service", "normalized warning message"],
  );
}

function fingerprint(
  parts: readonly FingerprintPart[],
  explanation: readonly string[],
): FingerprintResult {
  return {
    version: 1,
    digest: createHash("sha256").update(canonical(parts), "utf8").digest("hex"),
    explanation,
  };
}

function canonical(parts: readonly FingerprintPart[]): string {
  return parts
    .map(
      ([name, value]) =>
        `${utf8Length(name)}:${name}${utf8Length(value)}:${value}`,
    )
    .join("");
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function nonDefaultExplicitFingerprint(
  value: unknown,
): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const meaningful = value.filter(
    (entry): entry is string =>
      typeof entry === "string" &&
      entry.trim().length > 0 &&
      !isSdkDefaultFingerprint(entry),
  );
  return meaningful.length > 0 ? meaningful : null;
}

function isSdkDefaultFingerprint(value: string): boolean {
  return value.trim() === "{{ default }}" || value.trim() === "{{default}}";
}

function selectedException(value: unknown): {
  readonly present: boolean;
  readonly type: string;
  readonly value: string;
  readonly frames: readonly unknown[];
} {
  const values = record(value).values;
  if (!Array.isArray(values)) {
    return { present: false, type: "", value: "", frames: [] };
  }
  for (const candidate of values) {
    const exception = record(candidate);
    const type = text(exception.type);
    const exceptionValue = text(exception.value);
    if (type !== null || exceptionValue !== null) {
      const stacktrace = record(exception.stacktrace);
      return {
        present: true,
        type: type ?? "",
        value: exceptionValue ?? "",
        frames: Array.isArray(stacktrace.frames) ? stacktrace.frames : [],
      };
    }
  }
  return { present: false, type: "", value: "", frames: [] };
}

function applicationFrames(frames: readonly unknown[]): readonly {
  module: string;
  filename: string;
  functionName: string;
}[] {
  return frames
    .filter(isRelevantApplicationFrame)
    .slice(-5)
    .map((frame) => {
      const value = record(frame);
      return {
        module: normalizeMessageTemplate(text(value.module) ?? ""),
        filename: normalizeFilename(
          text(value.filename) ?? text(value.abs_path) ?? "",
        ),
        functionName: normalizeMessageTemplate(text(value.function) ?? ""),
      };
    });
}

function isRelevantApplicationFrame(frame: unknown): boolean {
  const value = record(frame);
  return value.in_app !== false && !isKnownVendorFrame(value);
}

function isKnownVendorFrame(value: Readonly<Record<string, unknown>>): boolean {
  return [value.module, value.filename, value.abs_path, value.package].some(
    (candidate) =>
      typeof candidate === "string" &&
      /(?:^|[/.\\])(?:node_modules|vendor|third_party|external|\.pnpm)(?:[/.\\]|$)/iu.test(
        candidate,
      ),
  );
}

function normalizeFilename(value: string): string {
  const withoutQuery = value.split(/[?#]/u, 1)[0] ?? "";
  const path = withoutQuery.replaceAll("\\", "/");
  const withoutScheme = path.replace(/^[a-z][a-z\d+.-]*:\/+/iu, "/");
  const isAbsolute =
    withoutScheme.startsWith("/") || /^[a-z]:\//iu.test(withoutScheme);
  const segments = withoutScheme.split("/").filter(Boolean);
  const stablePathIndex = segments.findIndex((segment) =>
    ["app", "apps", "lib", "packages", "src"].includes(segment),
  );
  const filename = !isAbsolute
    ? withoutScheme
    : stablePathIndex >= 0
      ? segments.slice(stablePathIndex).join("/")
      : segments.slice(-2).join("/");
  return normalizeMessageTemplate(filename);
}

function tag(value: unknown, name: string): unknown {
  return record(value)[name];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function meaningfulText(value: unknown): string | null {
  const candidate = text(value)?.trim();
  return candidate === undefined || candidate.length === 0 ? null : candidate;
}
