export const ISSUE_SORT_OPTIONS = [
  { value: "last-desc", label: "Last activity · Newest" },
  { value: "last-asc", label: "Last activity · Oldest" },
  { value: "first-desc", label: "First seen · Newest" },
  { value: "first-asc", label: "First seen · Oldest" },
  { value: "events-desc", label: "Events · Most" },
  { value: "events-asc", label: "Events · Fewest" },
  { value: "severity-desc", label: "Severity · Highest" },
] as const;

export type IssueSort = (typeof ISSUE_SORT_OPTIONS)[number]["value"];

export function issueSort(value: string | null): IssueSort {
  return ISSUE_SORT_OPTIONS.some((option) => option.value === value)
    ? (value as IssueSort)
    : "last-desc";
}
