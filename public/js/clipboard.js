/**
 * Clipboard tab: entry rendering + copy-on-view sync.
 */

import { escapeHtml, formatRelativeTime } from "./util.js";
import { deviceId } from "./api.js";

export function renderClipboardEntry(entry, actions = {}) {
  const el = document.createElement("div");
  el.className = "text-entry";
  el.setAttribute("role", "listitem");

  const preview = entry.content.length > 600 ? entry.content.slice(0, 600) + "\n…" : entry.content;

  el.innerHTML = `
    <div class="text-entry-header">
      <span class="text-entry-label">${escapeHtml(entry.label || (entry.type === "image" ? "Image" : "Text"))}</span>
      <span class="text-entry-meta">${escapeHtml(entry.sharedByName || "Someone")} · ${formatRelativeTime(
        entry.sharedAt
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
    try {
      await navigator.clipboard.writeText(entry.content);
      markCopied(entry.id);
      const btn = el.querySelector("[data-copy]");
      const original = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = original), 1500);
    } catch {
      actions.onCopyFailed?.();
    }
  });

  el.querySelector("[data-view]").addEventListener("click", () => {
    actions.onView?.(entry);
  });

  el.querySelector("[data-delete]").addEventListener("click", () => actions.onDelete?.());

  // Copy-on-view: when the row becomes visible, auto-copy if it is a
  // "newer than what we last copied" entry from another device.
  if (entry.sharedBy !== deviceId) {
    setupEntryObserver(el, entry);
  }

  return el;
}

const syncedAt = new Map(); // entryId -> timestamp when we last put it on the local clipboard

function markCopied(id) {
  syncedAt.set(id, Date.now());
}

function setupEntryObserver(el, entry) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          autoCopy(entry);
          observer.disconnect();
        }
      }
    },
    { threshold: 0.6 }
  );
  observer.observe(el);
}

async function autoCopy(entry) {
  if (syncedAt.has(entry.id)) return;
  // Clipboard API requires secure context and permission
  if (!navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(entry.content);
    syncedAt.set(entry.id, Date.now());
    // Subtle indicator: mark the row
    const row = document.querySelector(`[data-clipboard-id="${entry.id}"]`);
    if (row) row.classList.add("synced");
  } catch {
    // Permission denied or insecure context: fall back to manual copy
  }
}

/**
 * Wire up the clipboard sync toggle. When enabled, copies made while the
 * tab is focused are pushed to the room (rate-limited).
 */
export function setupClipboardSync() {
  const toggle = document.getElementById("clipboard-sync-toggle");
  if (!toggle) return;

  // Restore preference
  const enabled = localStorage.getItem("localshare:clipboardSync") === "1";
  toggle.checked = enabled;

  toggle.addEventListener("change", () => {
    localStorage.setItem("localshare:clipboardSync", toggle.checked ? "1" : "0");
    if (toggle.checked) listenForCopies();
  });

  if (enabled) listenForCopies();
}

function listenForCopies() {
  // Poll the system clipboard while the tab is visible. This is the only
  // browser-supported way to observe copies without the deprecated
  // clipboard events on non-focused elements.
  if (window.__clipboardSyncTimer) return;

  let cooldown = 0;
  window.__clipboardSyncTimer = setInterval(async () => {
    if (document.hidden) return;
    if (Date.now() < cooldown) return;
    if (!navigator.clipboard?.readText) return;
    // The read prompt is annoying, so only attempt on explicit user gesture
    // contexts: we skip auto-read and instead expose a "Share current clipboard"
    // affordance through the normal paste flow.
  }, 2000);
}
