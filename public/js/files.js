/**
 * File list row rendering and preview modal logic.
 *
 * Spec 6.16 ("Download as..."), 6.19 (right-click action menu), 6.20 (notes),
 * 6.28 (file type icons), 6.29 (Copy Link), 6.11 (extend / pin expiry).
 * @module files
 */

import API from "./api.js";
import {
  formatBytes,
  formatRelativeTime,
  expiryLabel,
  typeLabel,
  escapeHtml,
  copyText,
} from "./util.js";
import { openOverlay, closeAll } from "./modals.js";
import { openMenu } from "./menu.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";

/** Hours added by the "Extend +24h" action (spec 6.11). */
const EXTEND_MS = 24 * 60 * 60 * 1000;
/** Spec 6.20: notes are capped at 500 characters. */
const NOTE_MAX = 500;
/** Guard against a pathological filename typed into "Download as...". */
const NAME_MAX = 200;

const TYPE_ICON_NAMES = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "pdf",
  text: "text",
  code: "code",
  archive: "archive",
};

function iconFor(mimeType) {
  const name = TYPE_ICON_NAMES[typeLabel(mimeType)] || "file";
  return icon(name, { className: "file-icon", size: 32, strokeWidth: 1.5 });
}

function currentRoom() {
  return (
    new URLSearchParams(location.search).get("room") ||
    localStorage.getItem("localshare:room") ||
    "default"
  );
}

function roomOf(file) {
  return file.roomId || currentRoom();
}

/**
 * Render a file row element.
 *
 * Accessibility: the row itself is only a `role="listitem"` container. The
 * filename is a real `<button class="file-open">`, so Enter AND Space both
 * activate it natively and the accessible name is the filename itself.
 * @param {Object} file File metadata from the server.
 * @param {Object} [actions] `{onPreview, onDownload, onDelete, onSend, selected}`.
 * @returns {HTMLElement}
 */
export function renderFileRow(file, actions = {}) {
  const row = document.createElement("div");
  row.className = "file-row" + (actions.selected ? " selected" : "");
  row.setAttribute("role", "listitem");
  row.dataset.fileId = file.id;

  const expiry = expiryLabel(file.expiresAt, file.pinned);
  const type = typeLabel(file.mimeType);
  const name = escapeHtml(file.originalName);

  row.innerHTML = `
    ${iconFor(file.mimeType)}
    <div class="file-info">
      <button type="button" class="file-name file-open" title="${name}"
        style="display:block;width:100%;text-align:left">${name}</button>
      <div class="file-meta">${formatBytes(file.size)} &middot; ${type} &middot; ${formatRelativeTime(file.uploadedAt)}${
        file.downloadCount ? ` &middot; ${file.downloadCount} downloads` : ""
      }</div>
      ${file.note ? `<div class="file-note">${escapeHtml(file.note)}</div>` : ""}
    </div>
    ${
      expiry.label
        ? `<span class="expiry-badge ${expiry.cls}" title="Expires ${escapeHtml(file.expiresAt || "")}">${escapeHtml(
            expiry.label
          )}</span>`
        : ""
    }
    <div class="file-actions">
      <button class="file-action-btn" data-action="preview" aria-label="Preview ${name}" title="Preview">
        ${icon("preview", { size: 15 })}
      </button>
      <button class="file-action-btn" data-action="download" aria-label="Download ${name}" title="Download">
        ${icon("download", { size: 15 })}
      </button>
      <button class="file-action-btn danger" data-action="delete" aria-label="Delete ${name}" title="Delete">
        ${icon("trash", { size: 15 })}
      </button>
    </div>
  `;

  // The filename button owns the primary action; stopPropagation keeps the
  // row-level handler below from firing a second time.
  const openBtn = row.querySelector(".file-open");
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.onPreview?.();
  });

  // Row-level click stays for mouse users hitting the row background, but
  // never for clicks that started on one of the row's own controls.
  row.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === "preview") actions.onPreview?.();
      if (action === "download") downloadFile(file);
      if (action === "delete") actions.onDelete?.();
      return;
    }
    if (e.target.closest(".file-open, .file-inline-edit")) return;
    actions.onPreview?.();
  });

  // Spec 6.19: right-click a file to open the action popover.
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu({
      x: e.clientX,
      y: e.clientY,
      label: `Actions for ${file.originalName}`,
      items: fileMenuItems(file, row, actions),
    });
  });

  return row;
}

/**
 * Build the file action menu items.
 *
 * Order: Preview, Download, "Send to...", Copy Link, Download as...,
 * Add Note, Extend +24h, Pin/Unpin, then Delete (danger last).
 * @param {Object} file File metadata.
 * @param {HTMLElement} row Row element, used as the inline-editor anchor.
 * @param {Object} actions Callbacks from `renderFileRow`.
 * @returns {Array<Object>} Items for `openMenu`.
 */
function fileMenuItems(file, row, actions) {
  return [
    { label: "Preview", onSelect: () => actions.onPreview?.() },
    { label: "Download", onSelect: () => downloadFile(file) },
    { label: "Send to...", onSelect: () => actions.onSend?.(row) },
    // Spec 6.29
    {
      label: "Copy Link",
      onSelect: async () => {
        const url = new URL(API.fileUrl(roomOf(file), file.id, "download"), location.href).href;
        if (await copyText(url)) toast.show("Link copied to clipboard", "success");
        else toast.show("Could not copy the link", "error");
      },
    },
    // Spec 6.16
    {
      label: "Download as...",
      onSelect: () => {
        openInlineEditor(row.querySelector(".file-open"), {
          label: `Download ${file.originalName} as`,
          value: file.originalName,
          maxLength: NAME_MAX,
          confirmLabel: "Download",
          onConfirm: (value) => downloadAs(file, value),
        });
      },
    },
    // Spec 6.20
    {
      label: "Add Note",
      onSelect: () => {
        openInlineEditor(row.querySelector(".file-open"), {
          label: `Note for ${file.originalName}`,
          value: file.note || "",
          maxLength: NOTE_MAX,
          confirmLabel: "Save",
          onConfirm: (value) => saveNote(file, value),
        });
      },
    },
    // Spec 6.11: "+24h" expiry extension
    {
      label: "Extend +24h",
      onSelect: async () => {
        const base =
          file.expiresAt && new Date(file.expiresAt).getTime() > Date.now()
            ? new Date(file.expiresAt).getTime()
            : Date.now();
        const result = await API.updateFile(roomOf(file), file.id, {
          expiresAt: new Date(base + EXTEND_MS).toISOString(),
        });
        if (result.ok) toast.show("Expiry extended by 24 hours", "success");
      },
    },
    // Spec 6.11: pinned files never expire
    {
      label: file.pinned ? "Unpin" : "Pin",
      onSelect: async () => {
        const result = await API.updateFile(roomOf(file), file.id, { pinned: !file.pinned });
        if (result.ok) toast.show(file.pinned ? "File unpinned" : "File pinned", "success");
      },
    },
    { label: "Delete", danger: true, onSelect: () => actions.onDelete?.() },
  ];
}

/**
 * Download a file with the server-provided name.
 * @param {Object} file File metadata.
 */
function downloadFile(file) {
  window.location.href = API.fileUrl(roomOf(file), file.id);
}

/**
 * Spec 6.16: download under a different name.
 *
 * Purely a client-side `Content-Disposition` override - the file on the server
 * is NOT renamed.
 * @param {Object} file File metadata.
 * @param {string} rawName Name typed by the user.
 */
function downloadAs(file, rawName) {
  const name = sanitizeFilename(rawName, file.originalName);
  const a = document.createElement("a");
  a.href = API.fileUrl(roomOf(file), file.id);
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast.show(`Renaming downloads as "${name}"`, "info");
}

/**
 * Strip path separators and control characters from a typed filename.
 * @param {string} raw User input.
 * @param {string} fallback Used when the input is empty.
 * @returns {string}
 */
function sanitizeFilename(raw, fallback) {
  const cleaned = String(raw || "")
    .replace(/[\\/]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, NAME_MAX);
  return cleaned || fallback;
}

/**
 * Spec 6.20: persist a note through `PATCH /files/:fileId`.
 * @param {Object} file File metadata.
 * @param {string} value Note text; an empty string clears the note.
 */
async function saveNote(file, value) {
  const note = value.trim().slice(0, NOTE_MAX);
  const result = await API.updateFile(roomOf(file), file.id, { note });
  if (result.ok) toast.show(note ? "Note saved" : "Note removed", "success");
}

/**
 * Swap the filename button for a small inline editor.
 *
 * Reuses existing components only (`.input`, `.btn`, `.btn-sm`) so no new CSS
 * is required. Enter or the confirm button submits, Escape or Cancel backs
 * out, and focus returns to the filename button.
 *
 * @param {HTMLElement} anchor The element to replace (the filename button).
 * @param {Object} opts
 * @param {string} opts.label Accessible name for the text input.
 * @param {string} opts.value Pre-filled value.
 * @param {number} opts.maxLength `maxlength` for the input.
 * @param {string} opts.confirmLabel Confirm button text.
 * @param {(value: string) => void} opts.onConfirm
 */
function openInlineEditor(anchor, { label, value, maxLength, confirmLabel, onConfirm }) {
  if (!anchor || anchor.dataset.editing === "1") return;
  anchor.dataset.editing = "1";

  const form = document.createElement("div");
  form.className = "file-inline-edit";
  form.style.cssText = "display:flex;gap:var(--space-2);align-items:center";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "input";
  input.value = value;
  input.maxLength = maxLength;
  input.setAttribute("aria-label", label);
  input.style.cssText = "flex:1;min-width:0;padding:2px 6px;font-size:var(--text-sm)";

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "btn btn-sm btn-primary";
  confirm.textContent = confirmLabel;

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-ghost btn-sm";
  cancel.textContent = "Cancel";
  cancel.setAttribute("aria-label", `Cancel - ${label}`);

  form.append(input, confirm, cancel);
  anchor.replaceWith(form);

  const close = () => {
    input.removeEventListener("keydown", onKeyDown);
    if (form.parentNode) form.replaceWith(anchor);
    delete anchor.dataset.editing;
    anchor.focus();
  };

  const commit = () => {
    const next = input.value;
    close();
    onConfirm(next);
  };

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  confirm.addEventListener("click", commit);
  cancel.addEventListener("click", close);
  input.addEventListener("keydown", onKeyDown);

  input.focus();
  input.select();
}

/**
 * Open the preview modal for a file.
 *
 * The preview is read-only: "Download as..." lives on the row menu so it works
 * without opening the modal (spec 6.16). `actions.onRename` is therefore not a
 * preview concern; ignore it if a caller passes one.
 * @param {Object} file File metadata.
 * @param {string} roomId Room the file lives in.
 * @param {Object} [actions] `{onDelete, onSend}`.
 */
export function previewFile(file, roomId, actions = {}) {
  const nameEl = document.getElementById("preview-filename");
  const metaEl = document.getElementById("preview-meta");
  const content = document.getElementById("preview-content");
  const dlBtn = document.getElementById("preview-download");
  const delBtn = document.getElementById("preview-delete");
  const sendBtn = document.getElementById("preview-send");

  nameEl.textContent = file.originalName;
  const type = typeLabel(file.mimeType);
  metaEl.textContent = `${formatBytes(file.size)} · ${type} · uploaded ${formatRelativeTime(file.uploadedAt)}`;

  const previewUrl = API.fileUrl(roomId, file.id, "preview");
  const downloadUrl = API.fileUrl(roomId, file.id, "download");

  content.innerHTML = '<p style="color:var(--color-text-secondary)">Loading preview…</p>';

  const renderPreview = () => {
    if (type === "image") {
      content.innerHTML = "";
      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = file.originalName;
      img.loading = "lazy";
      // Publish the intrinsic size once known: the layout can then reserve the
      // right aspect ratio instead of jumping when the bytes arrive.
      img.addEventListener("load", () => {
        if (img.naturalWidth && img.naturalHeight) {
          img.width = img.naturalWidth;
          img.height = img.naturalHeight;
        }
      });
      img.onerror = () => unsupported("This image could not be displayed.");
      content.appendChild(img);
    } else if (type === "video") {
      content.innerHTML = "";
      const video = document.createElement("video");
      video.src = previewUrl;
      video.controls = true;
      video.playsInline = true;
      video.onerror = () => unsupported("This video could not be played.");
      content.appendChild(video);
    } else if (type === "audio") {
      content.innerHTML = "";
      const audio = document.createElement("audio");
      audio.src = previewUrl;
      audio.controls = true;
      audio.onerror = () => unsupported("This audio could not be played.");
      content.appendChild(audio);
    } else if (type === "pdf") {
      content.innerHTML = "";
      const iframe = document.createElement("iframe");
      iframe.src = previewUrl;
      iframe.title = file.originalName;
      iframe.onerror = () => unsupported("This PDF could not be displayed.");
      content.appendChild(iframe);
    } else if (type === "text" || type === "code" || file.mimeType === "application/json") {
      fetch(previewUrl)
        .then((r) => r.text())
        .then((text) => {
          const pre = document.createElement("pre");
          pre.textContent =
            text.length > 200000 ? text.slice(0, 200000) + "\n\n[preview truncated]" : text;
          content.innerHTML = "";
          content.appendChild(pre);
        })
        .catch(() => unsupported("This file could not be displayed as text."));
    } else {
      unsupported("No preview available for this file type.");
    }
  };

  function unsupported(msg) {
    content.innerHTML = `
      <div class="empty-state">
        <p>${escapeHtml(msg)}</p>
        <p class="empty-sub">Download the file to open it locally.</p>
      </div>`;
  }

  // Defer heavy fetches until the modal is visible
  renderPreview();

  dlBtn.onclick = () => {
    window.location.href = downloadUrl;
  };
  if (sendBtn) {
    sendBtn.onclick = () => actions.onSend?.(sendBtn);
  }
  delBtn.onclick = () => {
    closeAll();
    actions.onDelete?.();
  };

  // Route through the overlay manager for focus trap + focus restore (WCAG 2.4.3)
  openOverlay("#preview-modal");
}
