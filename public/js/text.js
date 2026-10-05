/**
 * Text entry rendering.
 */

import { escapeHtml, formatRelativeTime, formatBytes, copyText } from "./util.js";

function looksLikeCode(text) {
  if (text.length > 4000) return false;
  const codeSignals = [
    /(^|\n)\s*(function|const|let|var|class|import|export|def|public|private)\s/,
    /[{};]\s*$/,
    /(^|\n)\s*\/\/|(^|\n)\s*#|(^|\n)\s*--/,
    /<[a-z][\s\S]*>/i,
    /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  ];
  const lines = text.split("\n").length;
  return lines < 60 && codeSignals.some((re) => re.test(text));
}

/**
 * Render a text entry card.
 *
 * `data-entry-id` is the key `app.js` uses for keyed diffing and swipe-to-
 * delete; keep the attribute name in sync with app.js.
 * @param {Object} entry Text entry from the server.
 * @param {Object} [actions] `{onCopied, onCopyFailed, onDelete}`.
 * @returns {HTMLElement}
 */
export function renderTextEntry(entry, actions = {}) {
  const el = document.createElement("div");
  el.className = "text-entry";
  el.setAttribute("role", "listitem");
  el.dataset.entryId = entry.id;

  const isCode = looksLikeCode(entry.content);
  const preview =
    entry.content.length > 1200 ? entry.content.slice(0, 1200) + "\n…" : entry.content;

  el.innerHTML = `
    <div class="text-entry-header">
      <span class="text-entry-label">${escapeHtml(entry.label || "Untitled")}</span>
      <span class="text-entry-meta">${escapeHtml(entry.sharedByName || "Someone")} · ${formatRelativeTime(
        entry.sharedAt
      )} · ${formatBytes(entry.size || entry.content.length)}</span>
    </div>
    <div class="text-entry-content${isCode ? " code" : ""}">${escapeHtml(preview)}</div>
    <div class="text-entry-actions">
      <button class="btn btn-ghost btn-sm" data-copy>Copy</button>
      <button class="btn btn-ghost btn-sm" data-download>Save</button>
      <button class="btn btn-ghost btn-sm" data-delete>Delete</button>
    </div>
  `;

  el.querySelector("[data-copy]").addEventListener("click", async () => {
    if (await copyText(entry.content)) {
      actions.onCopied?.();
      // Optimistic label change for feedback
      const btn = el.querySelector("[data-copy]");
      const original = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = original), 1500);
    } else {
      actions.onCopyFailed?.();
    }
  });

  el.querySelector("[data-download]").addEventListener("click", () => {
    const blob = new Blob([entry.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(entry.label || "shared-text").replace(/[^\w.-]+/g, "-").slice(0, 60)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  el.querySelector("[data-delete]").addEventListener("click", () => actions.onDelete?.());

  return el;
}
