import { useEffect, useRef } from "react";

/**
 * Synchronizes CSS `:user-invalid` with ARIA attributes (`aria-invalid` & dynamic
 * `aria-describedby` linking) and provides a `WeakMap` fallback when `:user-invalid`
 * is unsupported (`validate-input-after-interaction` compliant).
 */
export function ValidationAriaSync() {
  const announcerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined" || typeof CSS === "undefined") return;

    const supportsUserInvalid = CSS.supports("selector(:user-invalid)");
    const dirtyState = new WeakMap<HTMLElement, { hasInteracted: boolean; hasBlurred: boolean }>();
    const flagged = new WeakSet<HTMLElement>();
    const announced = new WeakSet<HTMLElement>();
    let announceTimer: ReturnType<typeof setTimeout> | undefined;

    const linkError = (el: HTMLElement, shown: boolean) => {
      const errorId = el.dataset["error"];
      if (!errorId) return;
      const existing = (el.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((id) => id && id !== errorId);
      if (shown) existing.push(errorId);
      if (existing.length > 0) el.setAttribute("aria-describedby", existing.join(" "));
      else el.removeAttribute("aria-describedby");
    };

    const announceError = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
      const errorId = el.dataset["error"];
      if (!errorId || !announcerRef.current) return;
      const errNode = document.getElementById(errorId);
      if (!errNode) return;
      const label = el.labels?.[0]?.textContent?.trim();
      const prefix = label ? `${label}: ` : "";
      clearTimeout(announceTimer);
      announcerRef.current.textContent = "";
      announceTimer = setTimeout(() => {
        if (announcerRef.current) {
          announcerRef.current.textContent = `${prefix}${(errNode.textContent ?? "").trim()}`;
        }
      }, 500);
    };

    const syncElement = (target: EventTarget | null, shouldAnnounce = false) => {
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches("input, select, textarea")) return;
      const field = target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

      const isInvalid = supportsUserInvalid
        ? field.matches(":user-invalid")
        : !field.validity.valid &&
          Boolean(dirtyState.get(field)?.hasInteracted && dirtyState.get(field)?.hasBlurred);

      if (!supportsUserInvalid) {
        const st = dirtyState.get(field);
        if (st?.hasInteracted && st.hasBlurred) {
          field.classList.toggle("user-invalid-fallback", !field.validity.valid);
          field.classList.toggle("user-valid-fallback", field.validity.valid);
        }
      }

      if (isInvalid) {
        if (shouldAnnounce && !announced.has(field)) {
          announceError(field);
          announced.add(field);
        }
        field.setAttribute("aria-invalid", "true");
        linkError(field, true);
        flagged.add(field);
      } else if (flagged.has(field) || field.getAttribute("aria-invalid") !== "true") {
        field.setAttribute("aria-invalid", "false");
        linkError(field, false);
        flagged.delete(field);
        announced.delete(field);
      }
    };

    document.querySelectorAll("input, select, textarea").forEach((el) => syncElement(el));

    const onBlur = (e: Event) => {
      if (e.target instanceof HTMLElement) {
        const prev = dirtyState.get(e.target) ?? { hasInteracted: false, hasBlurred: false };
        dirtyState.set(e.target, { ...prev, hasBlurred: true });
      }
      syncElement(e.target, true);
    };

    const onInput = (e: Event) => {
      if (e.target instanceof HTMLElement) {
        const prev = dirtyState.get(e.target) ?? { hasInteracted: false, hasBlurred: false };
        dirtyState.set(e.target, { ...prev, hasInteracted: true });
      }
      syncElement(e.target, false);
    };

    const onInvalid = (e: Event) => {
      if (e.target instanceof HTMLElement) {
        dirtyState.set(e.target, { hasInteracted: true, hasBlurred: true });
        announced.add(e.target);
      }
      syncElement(e.target, false);
    };

    document.addEventListener("blur", onBlur, true);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onBlur, true);
    document.addEventListener("invalid", onInvalid, true);

    return () => {
      clearTimeout(announceTimer);
      document.removeEventListener("blur", onBlur, true);
      document.removeEventListener("input", onInput);
      document.removeEventListener("change", onBlur, true);
      document.removeEventListener("invalid", onInvalid, true);
    };
  }, []);

  return <div ref={announcerRef} aria-live="polite" className="visually-hidden" />;
}
