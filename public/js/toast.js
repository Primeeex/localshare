/**
 * Toast notification manager for LocalShare.
 */

const ICONS = {
  success:
    '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error:
    '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warning:
    '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

class ToastManager {
  constructor() {
    this.container = null;
    this.max = 5;
    this.timers = new Map();
  }

  init() {
    this.container = document.getElementById("toast-container");
  }

  show(message, type = "info", { duration = 4000, title } = {}) {
    if (!this.container) this.init();
    if (!this.container) return;

    // Cap stack size
    while (this.container.children.length >= this.max) {
      this.container.removeChild(this.container.firstElementChild);
    }

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");

    const icon = ICONS[type] || ICONS.info;
    const titleHtml = title ? `<strong>${escapeHtml(title)}</strong><br>` : "";
    toast.innerHTML = `
      ${icon}
      <div class="toast-message">${titleHtml}${escapeHtml(message)}</div>
      <button class="toast-close" aria-label="Dismiss notification">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;

    const close = () => this.dismiss(toast);
    toast.querySelector(".toast-close").addEventListener("click", close);

    this.container.appendChild(toast);

    if (duration > 0) {
      const timer = setTimeout(close, duration);
      this.timers.set(toast, timer);
    }

    return toast;
  }

  dismiss(toast) {
    const timer = this.timers.get(toast);
    if (timer) clearTimeout(timer);
    this.timers.delete(toast);
    if (!toast.parentElement) return;
    toast.classList.add("toast-exit");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    // Fallback if animationend never fires
    setTimeout(() => toast.remove(), 250);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export const toast = new ToastManager();
export default toast;
