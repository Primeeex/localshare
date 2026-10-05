/**
 * Toast notification manager for LocalShare.
 *
 * Spec 6.25:
 * - `show({ message, type, duration, title })` or `show(message, type, opts)`
 * - default duration 4s, error toasts 8s (spec PROMPT.md:939)
 * - at most 5 toasts visible; extras QUEUE behind the oldest, they never
 *   evict it (spec PROMPT.md:941)
 * - icons come from `icons.js` and are always decorative
 *
 * @module toast
 */

import { icon } from "./icons.js";

/** Toasts visible at once. Additional ones wait in a FIFO queue. */
const MAX_VISIBLE = 5;
/** Spec 6.25: "Default duration: 4 seconds. Error toasts: 8 seconds." */
const DEFAULT_DURATION = 4000;
const ERROR_DURATION = 8000;
/** Matches `.toast-exit` (150ms); fallback in case `animationend` never fires. */
const EXIT_MS = 250;

const ICON_FOR_TYPE = {
  success: "success",
  error: "error",
  warning: "alert",
  info: "info",
};

class ToastManager {
  constructor() {
    this.container = null;
    this.max = MAX_VISIBLE;
    /** Mounted toast elements. */
    this.live = new Set();
    /** Toast elements with a running auto-dismiss timer. */
    this.timers = new Map();
    /** Pending toasts waiting for a free slot, oldest first. */
    this.queue = [];
  }

  init() {
    this.container = document.getElementById("toast-container");
  }

  /**
   * Show a toast.
   *
   * Accepts both call styles so existing callers keep working:
   * ```js
   * show(message, type, { duration, title })
   * show({ message, type, duration, title })
   * ```
   *
   * @param {string|{message?: string, type?: string, duration?: number, title?: string}} message
   * @param {string} [type] `success | error | warning | info`
   * @param {{duration?: number, title?: string}} [opts]
   * @returns {HTMLElement|null} The mounted toast, or `null` when it was queued.
   */
  show(message, type = "info", opts = {}) {
    if (!this.container) this.init();
    if (!this.container) return null;

    const spec =
      message && typeof message === "object"
        ? { type: "info", ...message }
        : { message, type, ...opts };

    const toastType = ICON_FOR_TYPE[spec.type] ? spec.type : "info";
    // Errors linger twice as long (spec 6.25); an explicit duration always wins.
    const duration =
      typeof spec.duration === "number"
        ? spec.duration
        : toastType === "error"
          ? ERROR_DURATION
          : DEFAULT_DURATION;

    const pending = { ...spec, type: toastType, duration };

    // Spec 6.25: extras queue behind the oldest - they never evict it.
    if (this.live.size >= this.max) {
      this.queue.push(pending);
      return null;
    }
    return this.mount(pending);
  }

  /**
   * Create and mount one toast.
   * @param {{message: string, type: string, duration: number, title?: string}} spec
   * @returns {HTMLElement}
   */
  mount({ message, type, duration, title }) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    // Errors interrupt; everything else waits its turn.
    toast.setAttribute("role", type === "error" ? "alert" : "status");

    const titleHtml = title ? `<strong>${escapeHtml(title)}</strong><br>` : "";
    toast.innerHTML = `
      ${icon(ICON_FOR_TYPE[type], { className: "toast-icon", size: 18 })}
      <div class="toast-message">${titleHtml}${escapeHtml(message)}</div>
      <button class="toast-close" type="button" aria-label="Dismiss notification">
        ${icon("close", { size: 14 })}
      </button>
    `;

    toast.querySelector(".toast-close").addEventListener("click", () => this.dismiss(toast));

    this.container.appendChild(toast);
    this.live.add(toast);

    if (duration > 0) {
      this.timers.set(
        toast,
        setTimeout(() => this.dismiss(toast), duration)
      );
    }

    return toast;
  }

  /**
   * Dismiss a toast: clear its timer and play the exit animation.
   * @param {HTMLElement} toast
   */
  dismiss(toast) {
    const timer = this.timers.get(toast);
    if (timer) clearTimeout(timer);
    this.timers.delete(toast);
    if (!this.live.has(toast) || !toast.parentElement) return;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      toast.remove();
      this.live.delete(toast);
      this.pump();
    };

    toast.classList.add("toast-exit");
    toast.addEventListener("animationend", finish, { once: true });
    // Fallback if animationend never fires
    setTimeout(finish, EXIT_MS);
  }

  /** Mount queued toasts while slots remain. */
  pump() {
    while (this.queue.length && this.live.size < this.max) {
      this.mount(this.queue.shift());
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export const toast = new ToastManager();
export default toast;
