/**
 * File list row rendering and preview modal logic.
 */

import API from "./api.js";
import { formatBytes, formatRelativeTime, expiryLabel, typeLabel, escapeHtml } from "./util.js";
import { openOverlay, closeAll } from "./modals.js";
import { openMenu } from "./menu.js";

const TYPE_ICONS = {
  image:
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  video:
    '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  text: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  archive:
    '<path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
};

function iconFor(mimeType) {
  const type = typeLabel(mimeType);
  const path = TYPE_ICONS[type] || TYPE_ICONS.file;
  return `<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

/**
 * Render a file row element.
 */
export function renderFileRow(file, actions = {}) {
  const row = document.createElement("div");
  row.className = "file-row" + (actions.selected ? " selected" : "");
  row.setAttribute("role", "listitem");
  row.tabIndex = 0;

  const expiry = expiryLabel(file.expiresAt, file.pinned);
  const type = typeLabel(file.mimeType);

  row.innerHTML = `
    ${iconFor(file.mimeType)}
    <div class="file-info">
      <div class="file-name" title="${escapeHtml(file.originalName)}">${escapeHtml(file.originalName)}</div>
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
      <button class="file-action-btn" data-action="preview" aria-label="Preview ${escapeHtml(file.originalName)}" title="Preview">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button class="file-action-btn" data-action="download" aria-label="Download ${escapeHtml(file.originalName)}" title="Download">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="file-action-btn danger" data-action="delete" aria-label="Delete ${escapeHtml(file.originalName)}" title="Delete">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  `;

  row.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === "preview") actions.onPreview?.();
      if (action === "download")
        window.location.href = API.fileUrl(file.roomId || currentRoom(), file.id);
      if (action === "delete") actions.onDelete?.();
      return;
    }
    actions.onPreview?.();
  });

  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      actions.onPreview?.();
    }
  });

  // Spec 6.19: right-click a file to open the action popover (Preview,
  // Download, "Send to..." device picker, Delete)
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu({
      x: e.clientX,
      y: e.clientY,
      label: `Actions for ${file.originalName}`,
      items: [
        { label: "Preview", onSelect: () => actions.onPreview?.() },
        {
          label: "Download",
          onSelect: () => {
            window.location.href = API.fileUrl(file.roomId || currentRoom(), file.id);
          },
        },
        { label: "Send to...", onSelect: () => actions.onSend?.(row) },
        { label: "Delete", danger: true, onSelect: () => actions.onDelete?.() },
      ],
    });
  });

  return row;
}

function currentRoom() {
  return (
    new URLSearchParams(location.search).get("room") ||
    localStorage.getItem("localshare:room") ||
    "default"
  );
}

/**
 * Open the preview modal for a file.
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

  content.innerHTML = '<p style="color:var(--color-text-secondary)">Loading preview...</p>';

  const renderPreview = () => {
    if (type === "image") {
      content.innerHTML = "";
      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = file.originalName;
      img.loading = "lazy";
      img.onerror = () => unsupported("This image could not be displayed.");
      content.appendChild(img);
    } else if (type === "video") {
      content.innerHTML = "";
      const video = document.createElement("video");
      video.src = previewUrl;
      video.controls = true;
      video.playsInline = true;
      video.oncanplay = () => {};
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
