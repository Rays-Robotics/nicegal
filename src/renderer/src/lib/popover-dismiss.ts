import type { Attachment } from "svelte/attachments";

/** Attach to the common ancestor of the trigger and menu; listeners exist only while open. */
export function popoverDismiss(open: boolean, dismiss: () => void): Attachment<HTMLElement> {
  return (element): (() => void) | undefined => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (!event.composedPath().includes(element)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  };
}
