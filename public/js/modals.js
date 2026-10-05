/**
 * Overlay manager for modals and the mobile bottom sheet.
 *
 * Responsibilities:
 * - Spec 13.4: entry 150ms ease-out (CSS), exit 100ms ease-in before hiding.
 * - WCAG 2.4.3 / 2.1.2: move focus into the overlay, trap Tab inside it,
 *   and restore focus to the trigger on close.
 * - Escape closes the topmost overlay (spec 6.26).
 */

import { menuOpen, closeMenu } from "./menu.js";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const closeTimers = new WeakMap();
let activeOverlay = null;
let previousFocus = null;

function visibleFocusables(el) {
  return Array.from(el.querySelectorAll(FOCUSABLE)).filter(
    (node) => node.getClientRects().length > 0
  );
}

function onKeydown(e) {
  if (!activeOverlay) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    // A popover opened above a modal dismisses first
    if (menuOpen()) {
      closeMenu();
      return;
    }
    closeAll();
    return;
  }
  if (e.key !== "Tab") return;

  const nodes = visibleFocusables(activeOverlay);
  if (nodes.length === 0) {
    e.preventDefault();
    activeOverlay.focus();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const inside = activeOverlay.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault();
    first.focus();
  }
}

function beginTracking(el, { restore = true } = {}) {
  if (restore) previousFocus = document.activeElement;
  if (activeOverlay !== el) activeOverlay = el;
  document.addEventListener("keydown", onKeydown, true);
}

function focusOverlay(el) {
  const nodes = visibleFocusables(el);
  if (nodes.length > 0) nodes[0].focus();
  else {
    el.setAttribute("tabindex", "-1");
    el.focus();
  }
}

/**
 * Open an overlay by selector (`.modal` or `.bottom-sheet`).
 * @param {string} sel CSS selector for the overlay root
 */
export function openOverlay(sel) {
  const el = document.querySelector(sel);
  if (!el) return;

  closeAll({ silent: true });

  // Cancel a pending exit animation so reopening is instant
  window.clearTimeout(closeTimers.get(el));
  el.classList.remove("modal--closing");
  el.hidden = false;

  beginTracking(el);
  // Focus after paint so the browser lays the overlay out first
  window.requestAnimationFrame(() => focusOverlay(el));
}

/**
 * Close every open overlay. Modals play their 100ms ease-in exit (spec 13.6)
 * unless reduced motion is requested; the bottom sheet hides immediately.
 * @param {{silent?: boolean}} [opts] silent = do not restore focus (used when swapping overlays)
 */
export function closeAll(opts = {}) {
  document.removeEventListener("keydown", onKeydown, true);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll(".modal, .bottom-sheet").forEach((m) => {
    if (m.hidden) return;
    window.clearTimeout(closeTimers.get(m));
    if (reduced || m.classList.contains("bottom-sheet")) {
      m.classList.remove("modal--closing");
      m.hidden = true;
      return;
    }
    // WHY: spec 13.6 exit animation is 100ms ease-in before hiding
    m.classList.add("modal--closing");
    const timer = window.setTimeout(() => {
      m.classList.remove("modal--closing");
      m.hidden = true;
      closeTimers.delete(m);
    }, 100);
    closeTimers.set(m, timer);
  });

  const wasTracked = activeOverlay;
  activeOverlay = null;
  if (!opts.silent && previousFocus && document.contains(previousFocus)) {
    previousFocus.focus?.();
  }
  previousFocus = null;
  // WHY: keeps trigger state (e.g. the menu button's aria-expanded) in sync
  // when an overlay closes through the overlay manager (Escape, backdrop)
  document.dispatchEvent(new CustomEvent("localshare:overlays-closed"));
  return wasTracked;
}

/** True when any overlay is currently open. */
export function overlayOpen() {
  if (!activeOverlay) return false;
  return !activeOverlay.hidden;
}
