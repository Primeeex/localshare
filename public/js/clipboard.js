/**
 * Clipboard tab: entry rendering + copy-on-view sync.
 * @module clipboard
 */

import { escapeHtml, formatRelativeTime, copyText } from "./util.js";
import { deviceId } from "./api.js";

/** Shared observer for copy-on-view to avoid leaking one observer per entry. */
let clipboardObserver = null;
const observedEntries = new Map(); // entry element -> entry data

/**
 * Render one clipboard entry.
 *
 * Sets `data-clipboard-id` so `autoCopy` can find the row again after the
 * async copy resolves.
 * @param {Object} entry Clipboard entry from the server.
 * @param {Object} [actions] `{onView, onDelete, onCopyFailed}`.
 * @returns {HTMLElement}
 */
export function renderClipboardEntry(entry, actions = {}) {
  const el = document.createElement("div");
  el.className = "text-entry";
  el.setAttribute("role", "listitem");
  el.dataset.clipboardId = entry.id;

  const preview = entry.content.length > 600 ? entry.content.slice(0, 600) + "\n…" : entry.content;
  const label = entry.label || (entry.type === "image" ? "Image" : "Text");
  const sharedBy = entry.sharedByName || "Someone";

  el.innerHTML = `
    <div class="text-entry-header">
      <span class="text-entry-label">${escapeHtml(label)}</span>
      <span class="text-entry-meta">${escapeHtml(sharedBy)} &middot; ${escapeHtml(
        formatRelativeTime(entry.sharedAt)
      )}</span>
    </div>
    <div class="text-entry-content">${escapeHtml(preview)}</div>
    <div class="text-entry-actions">
      <button class="btn btn-ghost btn-sm" data-copy>Copy</button>
      <button class="btn btn-ghost btn-sm" data-view>View</button>
      <button class="btn btn-ghost btn-sm" data-delete>Delete</button>
    </div>
  `;

  el.querySelector("[data-copy]").addEventListener("click", async () => {
    if (await copyText(entry.content)) {
      markCopied(entry.id);
      const btn = el.querySelector("[data-copy]");
      const original = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = original), 1500);
    } else {
      actions.onCopyFailed?.();
    }
  });

  el.querySelector("[data-view]").addEventListener("click", () => {
    actions.onView?.(entry);
  });

  el.querySelector("[data-delete]").addEventListener("click", () => actions.onDelete?.());

  // Copy-on-view: when the row becomes visible, auto-copy if it is a
  // "newer than what we last copied" entry from another device.
  // Uses a shared observer to avoid leaking observers when the list re-renders.
  if (entry.sharedBy !== deviceId) {
    observedEntries.set(el, entry);
    ensureClipboardObserver();
  }

  return el;
}

/** Ensure the shared clipboard observer exists. */
function ensureClipboardObserver() {
  if (clipboardObserver) return;
  clipboardObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const entry = observedEntries.get(e.target);
          if (entry) {
            autoCopy(entry);
            observedEntries.delete(e.target);
            clipboardObserver.unobserve(e.target);
          }
        }
      }
      // If no more entries to observe, disconnect the observer
      if (observedEntries.size === 0) {
        clipboardObserver.disconnect();
        clipboardObserver = null;
      }
    },
    { threshold: 0.6 }
  );
}

/** Disconnect the shared observer and clear tracked entries. */
export function clearClipboardObserver() {
  if (clipboardObserver) {
    clipboardObserver.disconnect();
    clipboardObserver = null;
  }
  observedEntries.clear();
}

const syncedAt = new Map(); // entryId -> timestamp when we last put it on the local clipboard

function markCopied(id) {
  syncedAt.set(id, Date.now());
}

async function autoCopy(entry) {
  if (syncedAt.has(entry.id)) return;
  // copyText covers insecure LAN origins (no navigator.clipboard) via
  // execCommand; when neither path is allowed we stay silent - this runs
  // without a user gesture, so a failure here must never interrupt the UI.
  if (await copyText(entry.content)) {
    syncedAt.set(entry.id, Date.now());
    markSynced(entry.id);
  }
}

/**
 * Show that an entry is on this device's clipboard.
 *
 * `.synced` is the semantic hook; the visible treatment reuses what already
 * exists - a design-token inline border (the pattern used by `.device-avatar`
 * and `.menu` in menu.js) plus the existing `.expiry-badge success` pill for
 * the text. No stylesheet change is required.
 * @param {string} entryId
 */
function markSynced(entryId) {
  const row = document.querySelector(`[data-clipboard-id="${CSS.escape(entryId)}"]`);
  if (!row) return;
  row.classList.add("synced");
  row.style.borderLeft = "3px solid var(--color-success)";

  if (row.querySelector(".clipboard-synced")) return;
  const badge = document.createElement("span");
  badge.className = "expiry-badge success clipboard-synced";
  badge.textContent = "On clipboard";
  badge.title = "This entry was copied to this device automatically";
  row.querySelector(".text-entry-header")?.appendChild(badge);
}

/**
 * Safe localStorage helpers for clipboard sync.
 * In private/incognito mode, localStorage access throws.
 */
function safeGetItem(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Wire up the clipboard sync toggle.
 *
 * The preference is persisted per device. Reading the system clipboard is only
 * possible from a user gesture (and only in a secure context), so there is
 * deliberately no background poller here: pushing to the room happens through
 * the explicit paste/share flow, never on a timer (spec 19: no idle timers).
 */
export function setupClipboardSync() {
  const toggle = document.getElementById("clipboard-sync-toggle");
  if (!toggle) return;

  // Restore preference
  const enabled = safeGetItem("localshare:clipboardSync") === "1";
  toggle.checked = enabled;
  toggle.dataset.enabled = enabled ? "1" : "0";
}
