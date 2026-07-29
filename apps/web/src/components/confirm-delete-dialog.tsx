import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

interface ConfirmDeleteDialogProps {
  readonly eventCount: number;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function ConfirmDeleteDialog({
  eventCount,
  pending,
  onCancel,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancel.current?.focus();
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onCancel, pending]);

  return (
    <div className="dialog-backdrop">
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={trapFocus}
      >
        <p className="eyebrow">Destructive action</p>
        <h2 id={titleId}>Delete issue permanently?</h2>
        <p id={descriptionId}>
          This removes {String(eventCount)}{" "}
          {eventCount === 1 ? "event" : "events"}, every facet, and pending
          delivery evidence. This operation has no undo.
        </p>
        <div className="dialog-actions">
          <button
            ref={cancel}
            className="button"
            type="button"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="button button-danger"
            type="button"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending
              ? "Deleting…"
              : `Delete ${String(eventCount)} ${eventCount === 1 ? "event" : "events"} permanently`}
          </button>
        </div>
      </section>
    </div>
  );
}

function trapFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
