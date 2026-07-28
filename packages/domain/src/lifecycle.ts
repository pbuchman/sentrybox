export interface UnresolvedIssueSnapshot {
  readonly status: "unresolved";
  readonly generation: number;
  readonly resolvedAt: null;
}

export interface ResolvedIssueSnapshot {
  readonly status: "resolved";
  readonly generation: number;
  readonly resolvedAt: string;
}

export type IssueSnapshot = UnresolvedIssueSnapshot | ResolvedIssueSnapshot;
export type IssueStatus = IssueSnapshot["status"];

export interface OccurrenceDecision {
  readonly outcome: "created" | "repeated" | "regressed";
  readonly next: IssueSnapshot;
  readonly webhookRequired: boolean;
}

export interface ResolveDecision {
  readonly outcome: "resolved";
  readonly next: IssueSnapshot;
  readonly webhookRequired: false;
}

export interface ManualReopenDecision {
  readonly outcome: "manually_reopened";
  readonly next: IssueSnapshot;
  readonly webhookRequired: false;
}

export interface DeleteDecision {
  readonly outcome: "deleted";
  readonly next: null;
}

export function decideOccurrence(
  current: IssueSnapshot | null,
): OccurrenceDecision {
  if (current === null) {
    return {
      outcome: "created",
      next: { status: "unresolved", generation: 1, resolvedAt: null },
      webhookRequired: true,
    };
  }
  if (current.status === "unresolved") {
    return { outcome: "repeated", next: current, webhookRequired: false };
  }
  return {
    outcome: "regressed",
    next: {
      status: "unresolved",
      generation: current.generation + 1,
      resolvedAt: null,
    },
    webhookRequired: true,
  };
}

export function decideResolve(
  current: UnresolvedIssueSnapshot,
  resolvedAt: string,
): ResolveDecision {
  return {
    outcome: "resolved",
    next: { status: "resolved", generation: current.generation, resolvedAt },
    webhookRequired: false,
  };
}

export function decideManualReopen(
  current: ResolvedIssueSnapshot,
): ManualReopenDecision {
  return {
    outcome: "manually_reopened",
    next: {
      status: "unresolved",
      generation: current.generation,
      resolvedAt: null,
    },
    webhookRequired: false,
  };
}

export function decideDelete(current: IssueSnapshot): DeleteDecision {
  void current;
  return { outcome: "deleted", next: null };
}
