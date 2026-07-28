import { describe, expect, it } from "vitest";
import {
  decideDelete,
  decideManualReopen,
  decideOccurrence,
  decideResolve,
  type ResolvedIssueSnapshot,
  type UnresolvedIssueSnapshot,
} from "./index.js";

const unresolved: UnresolvedIssueSnapshot = {
  status: "unresolved",
  generation: 3,
  resolvedAt: null,
};

const resolved: ResolvedIssueSnapshot = {
  status: "resolved",
  generation: 3,
  resolvedAt: "2026-07-28T10:00:00.000Z",
};

describe("issue lifecycle", () => {
  it("creates generation one for an event with no current issue", () => {
    expect(decideOccurrence(null)).toEqual({
      outcome: "created",
      next: { status: "unresolved", generation: 1, resolvedAt: null },
      webhookRequired: true,
    });
  });

  it("repeats an unresolved issue without a generation or webhook change", () => {
    expect(decideOccurrence(unresolved)).toEqual({
      outcome: "repeated",
      next: unresolved,
      webhookRequired: false,
    });
  });

  it("resolves an unresolved issue without changing its generation", () => {
    expect(decideResolve(unresolved, "2026-07-28T11:00:00.000Z")).toEqual({
      outcome: "resolved",
      next: {
        status: "resolved",
        generation: 3,
        resolvedAt: "2026-07-28T11:00:00.000Z",
      },
      webhookRequired: false,
    });
  });

  it("manually reopens a resolved issue without a webhook or generation increment", () => {
    expect(decideManualReopen(resolved)).toEqual({
      outcome: "manually_reopened",
      next: { status: "unresolved", generation: 3, resolvedAt: null },
      webhookRequired: false,
    });
  });

  it("regresses once when an occurrence arrives after resolution", () => {
    expect(decideOccurrence(resolved)).toEqual({
      outcome: "regressed",
      next: { status: "unresolved", generation: 4, resolvedAt: null },
      webhookRequired: true,
    });
  });

  it("creates generation one again after permanent deletion", () => {
    const deleted = decideDelete(resolved);

    expect(deleted).toEqual({ outcome: "deleted", next: null });
    expect(decideOccurrence(deleted.next)).toEqual({
      outcome: "created",
      next: { status: "unresolved", generation: 1, resolvedAt: null },
      webhookRequired: true,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects invalid generation %s at every lifecycle decision boundary",
    (generation) => {
      const invalidUnresolved = {
        status: "unresolved" as const,
        generation,
        resolvedAt: null,
      } as UnresolvedIssueSnapshot;
      const invalidResolved = {
        status: "resolved" as const,
        generation,
        resolvedAt: "2026-07-28T10:00:00.000Z",
      } as ResolvedIssueSnapshot;

      expect(() => decideOccurrence(invalidUnresolved)).toThrow();
      expect(() => decideOccurrence(invalidResolved)).toThrow();
      expect(() =>
        decideResolve(invalidUnresolved, "2026-07-28T11:00:00.000Z"),
      ).toThrow();
      expect(() => decideManualReopen(invalidResolved)).toThrow();
      expect(() => decideDelete(invalidResolved)).toThrow();
    },
  );

  it("rejects regression when incrementing would exceed the safe integer range", () => {
    const maximumGeneration: ResolvedIssueSnapshot = {
      status: "resolved",
      generation: Number.MAX_SAFE_INTEGER,
      resolvedAt: "2026-07-28T10:00:00.000Z",
    };

    expect(() => decideOccurrence(maximumGeneration)).toThrow();
  });
});
