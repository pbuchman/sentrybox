interface IconProps {
  readonly name:
    | "back"
    | "box"
    | "check"
    | "check-circle"
    | "chevron"
    | "close"
    | "copy"
    | "download"
    | "error"
    | "external"
    | "filter"
    | "more"
    | "search"
    | "sort"
    | "warning";
  readonly size?: number;
  readonly className?: string;
}

export function Icon({ name, size = 20, className }: IconProps) {
  const paths = iconPaths[name];
  return (
    <svg
      aria-hidden="true"
      className={className === undefined ? "icon" : `icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths}
    </svg>
  );
}

type NamedIconProps = Omit<IconProps, "name">;

export function BoxIcon(props: NamedIconProps) {
  return <Icon {...props} name="box" />;
}

export function SearchIcon(props: NamedIconProps) {
  return <Icon {...props} name="search" />;
}

export function FilterIcon(props: NamedIconProps) {
  return <Icon {...props} name="filter" />;
}

export function CloseIcon(props: NamedIconProps) {
  return <Icon {...props} name="close" />;
}

export function MoreIcon(props: NamedIconProps) {
  return <Icon {...props} name="more" />;
}

export function ExternalIcon(props: NamedIconProps) {
  return <Icon {...props} name="external" />;
}

export function CopyIcon(props: NamedIconProps) {
  return <Icon {...props} name="copy" />;
}

export function CheckCircleIcon(props: NamedIconProps) {
  return <Icon {...props} name="check-circle" />;
}

export function ErrorIcon(props: NamedIconProps) {
  return <Icon {...props} name="error" />;
}

const iconPaths = {
  back: (
    <>
      <path d="m15 18-6-6 6-6" />
      <path d="M9 12h11" />
    </>
  ),
  box: (
    <>
      <path d="m4 7 8-4 8 4-8 4-8-4Z" />
      <path d="m4 7 8 4 8-4v10l-8 4-8-4V7Z" />
      <path d="M12 11v10" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </>
  ),
  chevron: <path d="m8 10 4 4 4-4" />,
  close: (
    <>
      <path d="m7 7 10 10" />
      <path d="M17 7 7 17" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6" />
      <path d="M12 17h.01" />
    </>
  ),
  external: (
    <>
      <path d="M14 5h5v5" />
      <path d="m11 13 8-8" />
      <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </>
  ),
  filter: (
    <>
      <path d="M4 6h16" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 5 5" />
    </>
  ),
  sort: (
    <>
      <path d="m8 6-3-3-3 3" />
      <path d="M5 3v15" />
      <path d="m16 18 3 3 3-3" />
      <path d="M19 21V6" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 4.1 2.6 18a2 2 0 0 0 1.8 3h15.2a2 2 0 0 0 1.8-3L13.7 4.1a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
} as const;
