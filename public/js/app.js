/**
 * LocalShare main application module.
 * Orchestrates auth, rooms, tabs, uploads, file list, SSE, shortcuts.
 */

import API, { deviceId, setDeviceName } from "./api.js";
import { SSEClient } from "./sse-client.js";
import toast from "./toast.js";
import { formatBytes } from "./util.js";
import { renderFileRow, previewFile } from "./files.js";
import { renderTextEntry } from "./text.js";
import { renderClipboardEntry, setupClipboardSync } from "./clipboard.js";
import { renderDeviceRow, renderDeviceAvatars } from "./devices.js";
import { openOverlay, closeAll, overlayOpen } from "./modals.js";
import { openMenu, menuOpen } from "./menu.js";

// ===== State =====
const state = {
  roomId: null,
  files: [],
  textEntries: [],
  clipboardEntries: [],
  devices: [],
  selectedFileId: null,
  focusedIndex: -1,
  sse: null,
  serverInfo: null,
  devicesLoaded: false,
  refreshedOnce: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ===== Boot =====
async function boot() {
  applyStoredTheme();
  try {
    const auth = await API.authStatus();
    if (auth.pinRequired && !auth.authenticated) {
      // The server serves pin.html for HTML routes without a session cookie
      window.location.replace("/");
      return;
    }
  } catch {
    // Server unreachable: show app anyway, SSE will surface connection state
  }
  startApp();
}

async function startApp() {
  $("#app").style.display = "flex";

  // Identify this device
  const savedName = localStorage.getItem("localshare:deviceName");
  if (!savedName) {
    setDeviceName(generateDeviceName());
  } else {
    setDeviceName(savedName);
  }

  // Resolve room from URL (spec 6.17: URL param takes priority over localStorage)
  const params = new URLSearchParams(location.search);
  const urlRoom = params.get("room");
  if (urlRoom) {
    state.roomId = urlRoom;
  } else {
    state.roomId = localStorage.getItem("localshare:room") || "default";
  }

  bindHeader();
  bindTabs();
  bindUpload();
  bindText();
  bindModals();
  bindKeyboard();
  bindFileSearch();
  bindDownloadAll();
  bindPasteModal();
  setupClipboardSync(state, onClipboardEntry);
  setupDropOverlay();
  startUptimeClock();
  $("#device-qr-btn")?.addEventListener("click", openQRModal);
  $("#clipboard-settings-btn")?.addEventListener("click", () => {
    const toggle = $("#clipboard-sync-toggle");
    $("#clipboard-settings").scrollIntoView({ block: "center" });
    toggle?.focus();
  });

  renderSkeletons();
  await ensureRoomExists();
  await loadRooms();
  await connectSSE();
  await refreshAll();
}

// ===== Rooms =====
/**
 * Spec 13.9: an unknown room (deep link or stale localStorage) shows
 * "Room not found" in the selector and redirects to the default room.
 */
async function ensureRoomExists() {
  if (!state.roomId || state.roomId === "default") return;
  try {
    await API.getRoom(state.roomId);
  } catch (err) {
    if (err?.status !== 404) return;
    const select = $("#room-selector");
    if (select) {
      select.innerHTML = '<option value="">Room not found</option>';
      select.value = "";
    }
    toast.show(`Room "${state.roomId}" was not found. Redirecting to the default room.`, "error");
    state.roomId = "default";
    localStorage.removeItem("localshare:room");
    history.replaceState({}, "", location.pathname);
  }
}

async function loadRooms() {
  try {
    const rooms = await API.listRooms();
    populateRoomSelect($("#room-selector"), rooms);
    populateRoomSelect($("#sheet-room-select"), rooms);
    updateRoomName();
  } catch (err) {
    console.error("Failed to load rooms:", err);
  }
}

function populateRoomSelect(select, rooms) {
  if (!select) return;
  select.innerHTML = "";
  for (const room of rooms) {
    const opt = document.createElement("option");
    opt.value = room.id;
    opt.textContent = room.name;
    select.appendChild(opt);
  }
  // Ensure current room exists in list
  if (!rooms.some((r) => r.id === state.roomId)) {
    const opt = document.createElement("option");
    opt.value = state.roomId;
    opt.textContent = state.roomId;
    select.appendChild(opt);
  }
  select.value = state.roomId;
}

function updateRoomName() {
  const el = $("#header-room-name");
  if (!el) return;
  const select = $("#room-selector");
  const label = select?.selectedOptions?.[0]?.textContent;
  el.textContent = label || state.roomId || "default";
}

async function switchRoom(roomId) {
  state.roomId = roomId;
  localStorage.setItem("localshare:room", roomId);
  history.pushState({}, "", `?room=${encodeURIComponent(roomId)}`);
  $("#room-selector").value = roomId;
  const sheetSelect = $("#sheet-room-select");
  if (sheetSelect && sheetSelect.value !== roomId) sheetSelect.value = roomId;
  updateRoomName();
  if (state.sse) state.sse.close();
  await connectSSE();
  await refreshAll();
  toast.show(`Switched to room "${roomId}"`, "info");
}

function bindHeader() {
  $("#room-selector").addEventListener("change", (e) => switchRoom(e.target.value));

  $("#new-room-btn").addEventListener("click", () => openModal("#new-room-modal"));
  $("#qr-btn").addEventListener("click", openQRModal);
  $("#theme-toggle").addEventListener("click", toggleTheme);

  // Mobile menu (spec 13.1): bottom sheet with theme, QR, room selector, settings
  $("#menu-btn")?.addEventListener("click", openMenuSheet);
  // Escape/backdrop closes through the overlay manager, so sync aria-expanded here
  document.addEventListener("localshare:overlays-closed", () => {
    $("#menu-btn")?.setAttribute("aria-expanded", "false");
  });
  $(".bottom-sheet-backdrop")?.addEventListener("click", () => closeModals());
  $("#sheet-theme-btn")?.addEventListener("click", () => {
    toggleTheme();
    syncSheetThemeLabel();
  });
  $("#sheet-qr-btn")?.addEventListener("click", () => {
    closeModals();
    openQRModal();
  });
  $("#sheet-room-select")?.addEventListener("change", (e) => switchRoom(e.target.value));
  $("#sheet-settings-btn")?.addEventListener("click", () => {
    closeModals();
    activateTab("clipboard");
    const toggle = $("#clipboard-sync-toggle");
    $("#clipboard-settings")?.scrollIntoView({ block: "center" });
    toggle?.focus();
  });

  $("#new-room-modal")
    .querySelector("[data-close-modal]")
    .addEventListener("click", async () => {
      const name = $("#new-room-name").value.trim();
      const pin = $("#new-room-pin").value.trim();
      try {
        const room = await API.createRoom({ name: name || undefined, pin: pin || undefined });
        closeModals();
        $("#new-room-name").value = "";
        $("#new-room-pin").value = "";
        await loadRooms();
        await switchRoom(room.id);
        toast.show("Room created", "success");
      } catch (err) {
        toast.show(err.message, "error");
      }
    });
}

function openMenuSheet() {
  syncSheetThemeLabel();
  const sheetSelect = $("#sheet-room-select");
  if (sheetSelect) sheetSelect.value = state.roomId;
  openModal("#menu-sheet");
  $("#menu-btn")?.setAttribute("aria-expanded", "true");
}

function syncSheetThemeLabel() {
  const el = $("#sheet-theme-value");
  if (!el) return;
  const current = document.documentElement.dataset.theme || "system";
  el.textContent = current.charAt(0).toUpperCase() + current.slice(1);
}

// ===== Tabs =====
function bindTabs() {
  const tabs = $$(".tab");
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
    // Roving tabindex + arrow keys (WAI-ARIA tabs pattern)
    tab.addEventListener("keydown", (e) => {
      let next = null;
      if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      tabs[next].focus();
      activateTab(tabs[next].dataset.tab);
    });
  });
}

function activateTab(name) {
  $$(".tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
  });
  $$(".tab-content").forEach((panel) => {
    const active = panel.id === `tab-${name}`;
    panel.classList.toggle("active", active);
    panel.style.display = active ? "flex" : "none";
  });
  if (name === "devices") {
    renderDevices();
  }
}

// ===== SSE =====
function connectSSE() {
  const handlers = {
    connected: (data) => {
      state.serverInfo = data.serverInfo;
      state.roomId = data.room.id;
      state.files = data.files || [];
      state.textEntries = data.textEntries || [];
      state.clipboardEntries = data.clipboardEntries || [];
      state.devices = data.devices || [];
      renderFiles();
      renderTexts();
      renderClipboards();
      renderDevices();
      updateStatusBar();
    },
    "file:added": (d) => upsertFile(d.file),
    "file:deleted": (d) => removeFile(d.fileId),
    "file:updated": (d) => upsertFile(d.file),
    "text:added": (d) => upsertText(d.entry),
    "text:updated": (d) => upsertText(d.entry),
    "text:deleted": (d) => removeText(d.entryId),
    "clipboard:updated": (d) => upsertClipboard(d.entry),
    "clipboard:deleted": (d) => removeClipboard(d.entryId),
    "device:joined": (d) => upsertDevice(d.device),
    "device:left": (d) => removeDevice(d.deviceId),
    "transfer:incoming": (d) => showTransferModal(d.transfer),
    "transfer:accepted": () => toast.show("Transfer accepted. Preparing download...", "success"),
    "transfer:declined": () => toast.show("Transfer declined by the other device.", "warning"),
    "transfer:expired": () => toast.show("Transfer expired before it was accepted.", "warning"),
    "server:shutdown": (d) => showShutdownBanner(d),
    "room:updated": () => loadRooms(),
    heartbeat: () => {},
  };

  if (state.sse) state.sse.close();
  state.sse = new SSEClient(state.roomId, handlers);

  state.sse.on("connecting", () => {
    $("#reconnect-banner").style.display = "flex";
    $("#disconnected-overlay").style.display = "none";
    setOffline(false);
    stopOfflineCountdown();
  });
  state.sse.on("reconnected", () => {
    $("#reconnect-banner").style.display = "none";
    $("#disconnected-overlay").style.display = "none";
    setOffline(false);
    stopOfflineCountdown();
    toast.show("Reconnected", "success");
    refreshAll();
  });
  state.sse.on("disconnected", () => {
    // Spec 13.9: full-page "Connection lost" overlay + countdown, controls disabled
    $("#reconnect-banner").style.display = "flex";
    $("#disconnected-overlay").style.display = "flex";
    setOffline(true);
    startOfflineCountdown();
  });

  state.sse.connect();
}

// Offline handling (spec 13.9)
let offlineTimer = null;

function setOffline(off) {
  if (off) document.body.setAttribute("data-offline", "");
  else document.body.removeAttribute("data-offline");
}

function startOfflineCountdown() {
  stopOfflineCountdown();
  const tick = () => {
    const ms = state.sse?.retryMs ?? 3000;
    const el = $("#reconnect-timer");
    if (el) el.textContent = String(Math.max(1, Math.ceil(ms / 1000)));
  };
  tick();
  offlineTimer = window.setInterval(tick, 250);
}

function stopOfflineCountdown() {
  if (offlineTimer) window.clearInterval(offlineTimer);
  offlineTimer = null;
}

// ===== Data refresh =====
let refreshingRoom = false;

async function refreshAll() {
  if (!state.refreshedOnce) renderSkeletons();
  try {
    const [files, texts, clipboards, devices] = await Promise.all([
      API.listFiles(state.roomId).catch((err) => handleListError("files", err)),
      API.listText(state.roomId).catch(() => []),
      API.listClipboard(state.roomId).catch(() => []),
      API.listDevices(state.roomId).catch(() => []),
    ]);
    state.files = files;
    state.textEntries = texts;
    state.clipboardEntries = clipboards;
    state.devices = devices;
    state.refreshedOnce = true;
    renderFiles();
    renderTexts();
    renderClipboards();
    renderDevices();
    updateStatusBar();
    $("#file-list")?.querySelector(".skeleton-row")?.remove();
  } catch (err) {
    console.error("refreshAll failed:", err);
  }
}

// Spec 13.9: "Room not found" falls back to the default room with a message
function handleListError(kind, err) {
  if (kind === "files" && err?.status === 404 && !refreshingRoom) {
    refreshingRoom = true;
    toast.show(`Room "${state.roomId}" was not found. Returning to the default room.`, "error");
    state.roomId = "default";
    localStorage.removeItem("localshare:room");
    history.replaceState(null, "", location.pathname);
    loadRooms().finally(() => {
      refreshingRoom = false;
      refreshAll();
    });
  }
  return [];
}

// Spec 13.7: skeleton rows while the first load is in flight
function renderSkeletons() {
  const list = $("#file-list");
  if (!list || list.querySelector(".skeleton-row")) return;
  $("#file-empty").style.display = "none";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 3; i++) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    row.setAttribute("aria-hidden", "true");
    row.innerHTML = `
      <div class="skeleton skeleton-circle" style="width:32px;height:32px;"></div>
      <div style="flex:1">
        <div class="skeleton" style="height:13px;width:60%;"></div>
        <div class="skeleton" style="height:11px;width:40%;margin-top:6px;"></div>
      </div>`;
    frag.appendChild(row);
  }
  list.insertBefore(frag, list.firstChild);
}

// ===== Files =====
function upsertFile(file) {
  const idx = state.files.findIndex((f) => f.id === file.id);
  if (idx >= 0) state.files[idx] = file;
  else state.files.push(file);
  renderFiles();
  updateStatusBar();
}

function removeFile(fileId) {
  state.files = state.files.filter((f) => f.id !== fileId);
  if (state.selectedFileId === fileId) {
    state.selectedFileId = null;
    closeModals();
  }
  updateStatusBar();

  // Spec 13.6: removal plays a 200ms ease-in fade, then the list re-renders
  const row = document.querySelector(`#file-list .file-row[data-file-id="${CSS.escape(fileId)}"]`);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (row && !reduced) {
    row.classList.add("removing");
    window.setTimeout(renderFiles, 220);
  } else {
    renderFiles();
  }
}

let renderedFileIds = new Set();

function renderFiles() {
  const list = $("#file-list");
  const empty = $("#file-empty");
  const dlBtn = $("#download-all-btn");

  // First real payload replaces the skeleton rows (spec 13.7)
  list?.querySelectorAll(".skeleton-row").forEach((el) => el.remove());

  // Clear previous rows, keep empty state node (and any skeleton rows)
  Array.from(list.querySelectorAll(".file-row")).forEach((el) => el.remove());

  const query = ($("#file-search")?.value || "").trim().toLowerCase();
  const visible = query
    ? state.files.filter((f) => (f.originalName || "").toLowerCase().includes(query))
    : state.files;

  if (visible.length === 0) {
    empty.style.display = "flex";
    if (dlBtn) dlBtn.disabled = true;
    renderedFileIds = new Set();
    return;
  }

  empty.style.display = "none";
  if (dlBtn) dlBtn.disabled = false;

  const frag = document.createDocumentFragment();
  const files = [...visible].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const nextIds = new Set(files.map((f) => f.id));
  const firstRender = renderedFileIds.size === 0;

  // Virtualization: for >100 files render in chunks as the user scrolls
  const VIRTUAL_THRESHOLD = 100;
  const CHUNK = 40;
  let rendered = 0;

  const renderChunk = () => {
    const end = Math.min(rendered + CHUNK, files.length);
    for (let i = rendered; i < end; i++) {
      const el = renderFileRow(files[i], {
        onPreview: () => showPreview(files[i]),
        onDownload: () => {},
        onDelete: () => deleteFile(files[i]),
        onSend: (anchor) => sendToDevice(files[i], anchor || el),
        selected: state.selectedFileId === files[i].id,
      });
      el.dataset.fileId = files[i].id;
      // Spec 13.6: newly appeared rows fade in over 200ms ease-out
      if (!firstRender && !renderedFileIds.has(files[i].id)) el.classList.add("file-row--enter");
      frag.appendChild(el);
    }
    rendered = end;
    list.appendChild(frag);
    if (rendered < files.length) {
      // Append a sentinel that triggers the next chunk on intersection
      const sentinel = document.createElement("div");
      sentinel.className = "file-sentinel";
      sentinel.style.height = "1px";
      list.appendChild(sentinel);
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          sentinel.remove();
          renderChunk();
        }
      });
      io.observe(sentinel);
    }
  };

  if (files.length > VIRTUAL_THRESHOLD) {
    renderChunk();
  } else {
    for (const f of files) {
      const el = renderFileRow(f, {
        onPreview: () => showPreview(f),
        onDownload: () => {},
        onDelete: () => deleteFile(f),
        onSend: (anchor) => sendToDevice(f, anchor || el),
        selected: state.selectedFileId === f.id,
      });
      el.dataset.fileId = f.id;
      if (!firstRender && !renderedFileIds.has(f.id)) el.classList.add("file-row--enter");
      list.appendChild(el);
    }
  }
  renderedFileIds = nextIds;
}

async function deleteFile(file) {
  if (!confirm(`Delete "${file.originalName}"?`)) return;
  try {
    await API.deleteFile(state.roomId, file.id);
    removeFile(file.id);
    toast.show(`Deleted ${file.originalName}`, "success");
  } catch (err) {
    toast.show(err.message, "error");
  }
}

function showPreview(file) {
  state.selectedFileId = file.id;
  renderFiles();
  previewFile(file, state.roomId, {
    onDelete: () => deleteFile(file),
    onSend: (anchor) => sendToDevice(file, anchor),
    onRename: async (name) => {
      // Rename is handled server-side through PATCH on download disposition; store as note fallback
      toast.show(`Renaming downloads as "${name}"`, "info");
    },
  });
}

/**
 * Spec 6.19: popover listing connected devices to push a file directly to.
 * @param {Object} file File to transfer.
 * @param {HTMLElement} [anchor] Element the popover anchors to.
 */
async function sendToDevice(file, anchor) {
  const others = (state.devices || []).filter((d) => d.id !== deviceId);
  if (others.length === 0) {
    toast.show("No other devices are connected right now.", "info");
    return;
  }
  openMenu({
    anchor,
    label: `Send ${file.originalName} to a device`,
    items: others.map((d) => ({
      label: d.name || "Unknown device",
      hint: d.deviceType || "",
      avatar: {
        initials: (d.name || "?").slice(0, 2),
        color: d.color || undefined,
      },
      onSelect: async () => {
        try {
          await API.createTransfer(state.roomId, {
            fileId: file.id,
            targetDeviceId: d.id,
          });
          toast.show(
            `Sent ${file.originalName} to ${d.name || "device"}. Awaiting acceptance…`,
            "info"
          );
        } catch (err) {
          toast.show(err.message, "error");
        }
      },
    })),
  });
}

// ===== Upload =====
function bindUpload() {
  const zone = $("#upload-zone");
  const input = $("#file-input");
  const cameraInput = $("#camera-input");

  $("#upload-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    input.click();
  });
  $("#camera-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    cameraInput.click();
  });
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });

  input.addEventListener("change", () => {
    if (input.files.length) uploadFiles(input.files);
    input.value = "";
  });
  cameraInput?.addEventListener("change", () => {
    if (cameraInput.files.length) uploadFiles(cameraInput.files);
    cameraInput.value = "";
  });
}

function setupDropOverlay() {
  const overlay = $("#drop-overlay");
  let dragDepth = 0;

  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    overlay.classList.remove("drop-overlay--inactive");
    overlay.classList.add("drop-overlay--active");
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) deactivate();
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    deactivate();
    if (e.dataTransfer?.files?.length) {
      uploadFiles(e.dataTransfer.files);
    }
  });

  function deactivate() {
    overlay.classList.remove("drop-overlay--active");
    overlay.classList.add("drop-overlay--inactive");
  }
}

async function uploadFiles(fileList) {
  const queue = $("#upload-queue");
  const uploadBtn = $("#upload-btn");
  queue.style.display = "flex";
  queue.innerHTML = "";
  uploadBtn?.classList.add("loading");
  uploadBtn?.setAttribute("aria-busy", "true");

  for (const file of Array.from(fileList)) {
    const row = document.createElement("div");
    row.className = "upload-row";
    row.innerHTML = `
      <div class="upload-row-info">
        <div class="upload-row-name"></div>
        <div class="upload-row-meta">${formatBytes(file.size)}</div>
        <progress max="100" value="0"></progress>
      </div>
      <button class="file-action-btn" aria-label="Cancel upload">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    row.querySelector(".upload-row-name").textContent = file.name;
    const progress = row.querySelector("progress");
    queue.appendChild(row);

    try {
      const formData = new FormData();
      formData.append("files[]", file, file.name);
      const meta = await API.uploadFile(state.roomId, formData, (loaded, total) => {
        progress.value = total ? (loaded / total) * 100 : 0;
        const pct = Math.round(progress.value);
        row.querySelector(".upload-row-meta").textContent =
          `${formatBytes(loaded)} / ${formatBytes(total)} (${pct}%)`;
      });
      progress.value = 100;
      row.classList.add("complete");
      row.querySelector(".upload-row-meta").textContent = `${formatBytes(file.size)} uploaded`;
      if (Array.isArray(meta)) meta.forEach(upsertFile);
      else upsertFile(meta);
      toast.show(`Uploaded ${file.name}`, "success");
    } catch (err) {
      row.classList.add("error");
      progress.value = 100;
      row.querySelector(".upload-row-meta").textContent = `Failed: ${err.message}`;
      // Inline retry instead of forcing the user to re-pick the file
      const retry = document.createElement("button");
      retry.className = "btn btn-ghost btn-sm upload-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        row.remove();
        uploadFiles([file]);
      });
      row.querySelector(".upload-row-info").appendChild(retry);
      toast.show(`Upload failed: ${err.message}`, "error");
    }
  }

  uploadBtn?.classList.remove("loading");
  uploadBtn?.removeAttribute("aria-busy");

  // Auto-hide the queue after a few seconds when everything is done
  setTimeout(() => {
    if (queue.querySelectorAll(".upload-row:not(.complete):not(.error)").length === 0) {
      queue.style.display = "none";
      queue.innerHTML = "";
    }
  }, 4000);
}

// ===== File search (spec 6.26: "/" focuses the search bar) =====
function bindFileSearch() {
  const input = $("#file-search");
  if (!input) return;
  input.addEventListener("input", () => {
    state.focusedIndex = -1;
    renderFiles();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
      renderFiles();
    }
  });
}

// ===== Download all (spec 6.16) =====
function bindDownloadAll() {
  const btn = $("#download-all-btn");
  if (!btn) return;
  const labelHtml = btn.innerHTML;
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    btn.classList.add("loading");
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = "Preparing download...";
    window.location.href = API.zipUrl(state.roomId);
    toast.show("Download starting…", "info");
    setTimeout(() => {
      btn.classList.remove("loading");
      btn.removeAttribute("aria-busy");
      btn.innerHTML = labelHtml;
    }, 1500);
  });
}

// ===== Paste to share (spec 6.26: Ctrl/Cmd+V) =====
function openPasteModal() {
  const area = $("#paste-content");
  if (!area) return;
  if (!area.value.trim()) area.value = "";
  openModal("#paste-modal");
  window.requestAnimationFrame(() => area.focus());
  // Best effort: prefill from the system clipboard when permission allows
  navigator.clipboard
    ?.readText?.()
    .then((text) => {
      if (!area.value && text) area.value = text;
    })
    .catch(() => {
      /* permission denied: the user pastes manually */
    });
}

function bindPasteModal() {
  $("#paste-share-btn")?.addEventListener("click", async () => {
    const content = $("#paste-content").value.trim();
    if (!content) {
      toast.show("Nothing to share yet", "warning");
      return;
    }
    const btn = $("#paste-share-btn");
    btn.classList.add("loading");
    btn.setAttribute("aria-busy", "true");
    try {
      const entry = await API.shareText(state.roomId, { content });
      $("#paste-content").value = "";
      upsertText(entry);
      closeModals();
      activateTab("text");
      toast.show("Text shared", "success");
    } catch (err) {
      toast.show(err.message, "error");
    } finally {
      btn.classList.remove("loading");
      btn.removeAttribute("aria-busy");
    }
  });
}

document.addEventListener("paste", (e) => {
  // Typing into a field keeps the browser's normal paste behaviour
  const target = e.target;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
  if (modalsOpen()) return;
  const text = e.clipboardData?.getData("text/plain");
  if (!text || !text.trim()) return;
  e.preventDefault();
  $("#paste-content").value = text;
  openModal("#paste-modal");
});

// ===== Text =====
function bindText() {
  $("#share-text-btn").addEventListener("click", async () => {
    const content = $("#text-content").value.trim();
    if (!content) {
      toast.show("Type some text first", "warning");
      return;
    }
    const btn = $("#share-text-btn");
    btn.classList.add("loading");
    btn.setAttribute("aria-busy", "true");
    try {
      const entry = await API.shareText(state.roomId, {
        content,
        label: $("#text-label").value.trim() || undefined,
      });
      $("#text-content").value = "";
      $("#text-label").value = "";
      upsertText(entry);
      toast.show("Text shared", "success");
    } catch (err) {
      toast.show(err.message, "error");
    } finally {
      btn.classList.remove("loading");
      btn.removeAttribute("aria-busy");
    }
  });
}

function upsertText(entry) {
  const idx = state.textEntries.findIndex((t) => t.id === entry.id);
  if (idx >= 0) state.textEntries[idx] = entry;
  else state.textEntries.unshift(entry);
  renderTexts();
}

function removeText(id) {
  state.textEntries = state.textEntries.filter((t) => t.id !== id);
  renderTexts();
}

function renderTexts() {
  const list = $("#text-list");
  const empty = $("#text-empty");
  Array.from(list.querySelectorAll(".text-entry")).forEach((el) => el.remove());
  if (state.textEntries.length === 0) {
    empty.style.display = "flex";
    return;
  }
  empty.style.display = "none";
  const sorted = [...state.textEntries].sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt));
  for (const entry of sorted) {
    list.appendChild(
      renderTextEntry(entry, {
        onDelete: async () => {
          try {
            await API.deleteText(state.roomId, entry.id);
            removeText(entry.id);
            toast.show("Text entry deleted", "success");
          } catch (err) {
            toast.show(err.message, "error");
          }
        },
      })
    );
  }
}

// ===== Clipboard =====
function onClipboardEntry(entry) {
  upsertClipboard(entry);
}

function upsertClipboard(entry) {
  const idx = state.clipboardEntries.findIndex((c) => c.id === entry.id);
  if (idx >= 0) state.clipboardEntries[idx] = entry;
  else state.clipboardEntries.unshift(entry);
  renderClipboards();
}

function removeClipboard(id) {
  state.clipboardEntries = state.clipboardEntries.filter((c) => c.id !== id);
  renderClipboards();
}

function renderClipboards() {
  const list = $("#clipboard-list");
  const empty = $("#clipboard-empty");
  Array.from(list.querySelectorAll(".text-entry")).forEach((el) => el.remove());
  if (state.clipboardEntries.length === 0) {
    empty.style.display = "flex";
    return;
  }
  empty.style.display = "none";
  const sorted = [...state.clipboardEntries].sort(
    (a, b) => new Date(b.sharedAt) - new Date(a.sharedAt)
  );
  for (const entry of sorted) {
    list.appendChild(
      renderClipboardEntry(entry, {
        onDelete: async () => {
          try {
            await API.deleteClipboard(state.roomId, entry.id);
            removeClipboard(entry.id);
          } catch (err) {
            toast.show(err.message, "error");
          }
        },
      })
    );
  }
}

// ===== Devices =====
function upsertDevice(device) {
  const idx = state.devices.findIndex((d) => d.id === device.id);
  if (idx >= 0) state.devices[idx] = device;
  else state.devices.push(device);
  renderDevices();
}

function removeDevice(id) {
  state.devices = state.devices.filter((d) => d.id !== id);
  renderDevices();
  toast.show("A device left the room", "info", { duration: 2500 });
}

function renderDevices() {
  const list = $("#device-list");
  const empty = $("#device-empty");
  Array.from(list.querySelectorAll(".device-row")).forEach((el) => el.remove());
  renderDeviceAvatars($("#device-avatars"), state.devices);
  updateStatusBar();

  if (state.devices.length === 0) {
    empty.style.display = "flex";
    return;
  }
  empty.style.display = "none";
  for (const device of state.devices) {
    list.appendChild(
      renderDeviceRow(device, {
        isSelf: device.id === deviceId,
        onRename: async (name) => {
          try {
            await API.renameDevice(state.roomId, device.id, name);
            upsertDevice({ ...device, name });
            toast.show("Device renamed", "success");
          } catch (err) {
            toast.show(err.message, "error");
          }
        },
      })
    );
  }
}
// ===== Status bar =====
function updateStatusBar() {
  const totalSize = state.files.reduce((sum, f) => sum + (f.size || 0), 0);
  $("#status-files").textContent =
    `${state.files.length} file${state.files.length === 1 ? "" : "s"}`;
  $("#status-size").textContent = formatBytes(totalSize);
  $("#status-devices").textContent =
    `${state.devices.length} device${state.devices.length === 1 ? "" : "s"}`;
}

let uptimeStart = Date.now();
function startUptimeClock() {
  uptimeStart = Date.now();
  setInterval(() => {
    const s = Math.floor((Date.now() - uptimeStart) / 1000);
    const el = $("#status-uptime");
    if (!el) return;
    if (s < 60) el.textContent = `${s}s`;
    else if (s < 3600) el.textContent = `${Math.floor(s / 60)}m ${s % 60}s`;
    else el.textContent = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }, 1000);
}

// ===== Modals =====
function bindModals() {
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-backdrop")) closeModals();
    if (e.target.closest(".modal-close")) closeModals();
  });
}

function openModal(sel) {
  openOverlay(sel);
}

function closeModals() {
  const closed = closeAll();
  // The bottom sheet reports back to its trigger for aria-expanded
  $("#menu-btn")?.setAttribute("aria-expanded", "false");
  return closed;
}

function modalsOpen() {
  return overlayOpen();
}

// ===== QR =====
async function openQRModal() {
  openModal("#qr-modal");
  const select = $("#qr-ip-select");
  try {
    const info = await API.serverInfo();
    state.serverInfo = info;
    select.innerHTML = "";
    const options = [
      {
        name: "localhost",
        url: `${location.protocol}//${location.hostname}:${location.port || 80}`,
      },
    ];
    for (const iface of info.interfaces || []) {
      options.push({
        name: iface.name,
        url: `${location.protocol}//${iface.address}:${info.port}`,
      });
    }
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.url;
      o.textContent = `${opt.name} · ${opt.url}`;
      select.appendChild(o);
    }
    const defaultUrl = options.find((o) => !o.url.includes("localhost"))?.url || options[0].url;
    select.value = defaultUrl;
    $("#qr-url").textContent = select.value;
    drawQR(select.value);
  } catch {
    const url = location.origin;
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = url;
    opt.textContent = url;
    select.appendChild(opt);
    $("#qr-url").textContent = url;
    drawQR(url);
  }

  select.onchange = () => {
    $("#qr-url").textContent = select.value;
    drawQR(select.value);
  };

  $("#copy-url-btn").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("#qr-url").textContent);
      toast.show("URL copied", "success");
    } catch {
      toast.show("Could not copy URL", "error");
    }
  };
}

function drawQR(text) {
  const host = document.getElementById("qr-code");
  if (!host) return;
  host.innerHTML = "";
  host.style.display = "block";
  // Spec 6.6: QR codes are generated client-side from the vendored qrcode.js
  if (typeof window.QRCode === "function") {
    try {
      new window.QRCode(host, {
        text,
        width: 240,
        height: 240,
        colorDark: "#18181B",
        colorLight: "#FFFFFF",
        correctLevel: window.QRCode.CorrectLevel?.M ?? 0,
      });
      return;
    } catch {
      // fall through to the server-rendered image
    }
  }
  // Fallback: server-rendered SVG endpoint if the vendored lib failed to load
  const img = document.createElement("img");
  img.width = 240;
  img.height = 240;
  img.alt = `QR code for ${text}`;
  img.src = `/api/server/qr?url=${encodeURIComponent(text)}`;
  img.onerror = () => {
    host.style.display = "none";
  };
  host.appendChild(img);
}

// ===== Transfers =====
function showTransferModal(transfer) {
  $("#transfer-message").textContent = `${transfer.sourceDeviceName} wants to send you a file.`;
  $("#transfer-file-info").textContent = `Transfer expires in 60 seconds.`;
  openModal("#transfer-modal");

  $("#transfer-accept").onclick = async () => {
    try {
      await API.respondTransfer(state.roomId, transfer.id, "accept");
      closeModals();
      toast.show("Download starting…", "success");
      window.location.href = API.transferUrl(state.roomId, transfer.id);
    } catch (err) {
      toast.show(err.message, "error");
    }
  };
  $("#transfer-decline").onclick = async () => {
    try {
      await API.respondTransfer(state.roomId, transfer.id, "decline");
      closeModals();
      toast.show("Transfer declined", "info");
    } catch (err) {
      toast.show(err.message, "error");
    }
  };
}

function showShutdownBanner(data) {
  toast.show(data.message || "Server shutting down…", "warning", { duration: 5000 });
}

// ===== Theme =====
function effectiveTheme(theme) {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function applyStoredTheme() {
  const theme = localStorage.getItem("localshare:theme") || "system";
  document.documentElement.dataset.theme = theme;
  updateThemeIcon(theme);
  syncThemeColor(theme);
  // Keep the icon honest when the OS flips while the stored pref is "system"
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    updateThemeIcon(document.documentElement.dataset.theme || "system");
  });
}

function toggleTheme() {
  const order = ["system", "light", "dark"];
  const current = document.documentElement.dataset.theme || "system";
  const next = order[(order.indexOf(current) + 1) % order.length];
  document.documentElement.dataset.theme = next;
  localStorage.setItem("localshare:theme", next);
  updateThemeIcon(next);
  syncThemeColor(next);
}

/* Browser chrome tint follows the effective theme. The media-scoped metas in
   index.html cover "system" with no JS (and track the OS live); an explicit
   light/dark pref overrides both of them until "system" is selected again. */
function syncThemeColor(theme) {
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  if (!metas.length) return;
  const effective = effectiveTheme(theme);
  const colors = ["#f7f7f8", "#09090b"]; // light, dark (spec 13.2 tokens)
  metas.forEach((meta, i) => {
    if (theme === "system") {
      meta.setAttribute("media", `(prefers-color-scheme: ${i === 0 ? "light" : "dark"})`);
      meta.setAttribute("content", colors[i]);
    } else {
      meta.removeAttribute("media");
      meta.setAttribute("content", effective === "dark" ? colors[1] : colors[0]);
    }
  });
}

function updateThemeIcon(theme) {
  const sun = document.querySelector(".icon-sun");
  const moon = document.querySelector(".icon-moon");
  if (!sun || !moon) return;
  const effective = effectiveTheme(theme);
  sun.style.display = effective === "dark" ? "none" : "block";
  moon.style.display = effective === "dark" ? "block" : "none";
}

// ===== Device name =====
// Spec 6.17/24: device names default to a generated friendly name
// (generateDeviceName) and are renamed inline in the Devices tab.
function generateDeviceName() {
  const adjectives = [
    "Swift",
    "Quiet",
    "Bright",
    "Calm",
    "Bold",
    "Warm",
    "Cool",
    "Keen",
    "Kind",
    "Proud",
  ];
  const animals = [
    "Fox",
    "Heron",
    "Otter",
    "Lynx",
    "Finch",
    "Badger",
    "Crane",
    "Marten",
    "Quokka",
    "Gecko",
  ];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const b = animals[Math.floor(Math.random() * animals.length)];
  return `${a}${b}`;
}

// ===== Keyboard shortcuts (spec 6.26) =====
function bindKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Popover menus own the keyboard while open (spec 6.19 device picker)
    if (menuOpen()) return;
    // Ignore when typing in inputs
    const tag = e.target.tagName;
    const typing =
      tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable;

    if (e.key === "Escape") {
      closeModals();
      return;
    }

    if (typing) return;

    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        const file = state.files.find((f) => f.id === state.selectedFileId);
        if (file) window.location.href = API.fileUrl(state.roomId, file.id);
      }
      if (e.key.toLowerCase() === "v") {
        // Spec 6.26: Ctrl/Cmd+V opens the paste-to-share modal
        e.preventDefault();
        openPasteModal();
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case "u":
        e.preventDefault();
        activateTab("files");
        $("#file-input").click();
        break;
      case "f":
        activateTab("files");
        break;
      case "t":
        activateTab("text");
        break;
      case "c":
        activateTab("clipboard");
        break;
      case "d":
        activateTab("devices");
        break;
      case "q":
        openQRModal();
        break;
      case "n":
        openModal("#new-room-modal");
        break;
      case "?":
        openModal("#shortcuts-modal");
        break;
      case "/":
        e.preventDefault();
        activateTab("files");
        $("#file-search")?.focus();
        break;
      case "j":
        moveSelection(1);
        break;
      case "k":
        moveSelection(-1);
        break;
      case "enter":
        if (state.selectedFileId) {
          const file = state.files.find((f) => f.id === state.selectedFileId);
          if (file) showPreview(file);
        }
        break;
      case "backspace":
        if (state.selectedFileId) {
          const file = state.files.find((f) => f.id === state.selectedFileId);
          if (file) deleteFile(file);
        }
        break;
    }
  });
}

function moveSelection(delta) {
  const rows = Array.from(document.querySelectorAll("#file-list .file-row"));
  if (rows.length === 0) return;
  state.focusedIndex = Math.max(0, Math.min(rows.length - 1, state.focusedIndex + delta));
  rows.forEach((r, i) => r.classList.toggle("selected", i === state.focusedIndex));
  const file = state.files.find((f) => f.id === rows[state.focusedIndex].dataset.fileId);
  if (file) state.selectedFileId = file.id;
  rows[state.focusedIndex].focus();
  rows[state.focusedIndex].scrollIntoView({ block: "nearest" });
}

// ===== Boot =====
boot().catch((err) => {
  console.error("Boot failed:", err);
  // Show app even on boot failure so users see something
  $("#app").style.display = "flex";
  toast.show("Failed to initialise. Some features may not work.", "error");
});
