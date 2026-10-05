/**
 * LocalShare main application module.
 * Orchestrates auth, rooms, tabs, uploads, file list, SSE, shortcuts.
 */

import API, { deviceId, setDeviceName, setRoomPin, getRoomPin } from "./api.js";
import { SSEClient } from "./sse-client.js";
import toast from "./toast.js";
import { formatBytes, formatRelativeTime, copyText } from "./util.js";
import { renderFileRow, previewFile } from "./files.js";
import { renderTextEntry } from "./text.js";
import { renderClipboardEntry, setupClipboardSync } from "./clipboard.js";
import { renderDeviceRow, avatarColors, hashIndex, deviceTypeIcon } from "./devices.js";
import { openOverlay, closeAll, overlayOpen } from "./modals.js";
import { openMenu, menuOpen } from "./menu.js";
import { createDropField, createPresenceCluster, createSparkline } from "./canvas.js";

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
  refreshedOnce: false,
  /** Room id whose PIN has already been asked for, so 4 parallel 401s prompt once. */
  pinPromptedFor: null,
  /**
   * A room we were asked to open but have NOT been admitted to yet. While this
   * is set, state.roomId still points at a room we can actually read, so the
   * user is never left sitting inside a locked room they cannot see.
   */
  pendingRoomId: null,
  // Set once the "that room does not exist" fallback has run, so the
  // fallback can never recurse into itself.
  notFoundHandled: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ===== Result helpers =====
// Spec 1811: api.js never throws; every response is a Result. These two keep
// call sites to one line instead of a try/catch per request.
/**
 * Unwrap a Result's data, logging and returning `fallback` when it failed.
 * @template T
 * @param {{ok: true, data: T}|{ok: false, error: Object}} result
 * @param {T} [fallback]
 * @returns {T}
 */
function data(result, fallback = null) {
  if (result?.ok) return result.data;
  if (result) console.warn("Request failed:", result.error);
  return fallback;
}

/** Human-readable message from a failed Result. */
function message(result, fallback = "Something went wrong") {
  return result?.error?.message || fallback;
}

/**
 * Run a bulk re-render with its live region muted.
 *
 * WHY: the four list containers are `aria-live="polite"`, which is correct -
 * a screen reader should announce a new file arriving. But `renderFiles()` and
 * friends tear down and rebuild every row, and a live region observes those
 * removals too: a full rebuild of a 500-row list gets announced as hundreds of
 * separate deletions before the new content is read. Muting the region for the
 * duration of a rebuild keeps the "something arrived" announcement while
 * dropping the churn.
 * @template T
 * @param {HTMLElement} container
 * @param {() => T} fn
 * @returns {T}
 */
function withLiveSuppressed(container, fn) {
  const previous = container?.getAttribute("aria-live");
  if (container) container.setAttribute("aria-live", "off");
  try {
    return fn();
  } finally {
    if (container) {
      if (previous === null) container.removeAttribute("aria-live");
      else container.setAttribute("aria-live", previous);
    }
  }
}

// ===== Boot =====
async function boot() {
  applyStoredTheme();
  // Reveal the shell before the first await: even if authStatus hangs, the
  // user gets the app shell instead of a blank page (otherwise the only
  // rendered element would be the off-screen skip link).
  $("#app").hidden = false;
  try {
    const auth = await API.authStatus();
    const status = data(auth, {});
    if (status.pinRequired && !status.authenticated) {
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
  // Identify this device
  const savedName = localStorage.getItem("localshare:deviceName");
  if (!savedName) {
    setDeviceName(generateDeviceName());
  } else {
    setDeviceName(savedName);
  }

  // Resolve room from URL (spec 6.17: URL param takes priority over localStorage).
  // A deep link into a PIN-protected room is treated as a REQUEST, not a move:
  // we stay in the default room and ask for the PIN before switching, so the
  // user is never dropped into a shell full of failed requests.
  const params = new URLSearchParams(location.search);
  const urlRoom = params.get("room");
  const wantedRoom = urlRoom || localStorage.getItem("localshare:room") || "default";
  state.roomId = "default";

  if (wantedRoom && wantedRoom !== "default") {
    if (getRoomPin(wantedRoom)) {
      // Verified earlier in this browser - go straight in, no round trip.
      state.roomId = wantedRoom;
    } else {
      state.pendingRoomId = wantedRoom;
      const probe = await API.getRoom(wantedRoom);
      if (probe.ok) {
        state.roomId = wantedRoom;
        state.pendingRoomId = null;
      } else if (probe.error?.status !== 401) {
        // 404 and friends are handled by ensureRoomExists() below with the
        // spec's "Room not found" messaging.
        state.roomId = wantedRoom;
        state.pendingRoomId = null;
      }
    }
  }
  if (state.roomId !== "default") {
    history.replaceState({}, "", `?room=${encodeURIComponent(state.roomId)}`);
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
  bindPresence();
  bindSwipeToDelete();
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
  // A deep link we were not admitted to: ask for the PIN now that the shell
  // is bound and interactive. state.roomId still points at the default room.
  if (state.pendingRoomId) {
    const pending = state.pendingRoomId;
    state.pendingRoomId = null;
    handleLockedRoom({ status: 401, roomId: pending });
  }
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
  const result = await API.getRoom(state.roomId);
  if (result.ok || result.error?.status !== 404) return;
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

async function loadRooms() {
  const rooms = data(await API.listRooms(), null);
  if (!rooms) return;
  populateRoomSelect($("#room-selector"), rooms);
  populateRoomSelect($("#sheet-room-select"), rooms);
  updateRoomName();
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

/**
 * Enter a room, but only after proving we are allowed in.
 *
 * WHY verify before switching: the old flow assigned state.roomId first and
 * discovered the 401 afterwards, so the user was "in" a locked room - empty
 * file list, empty presence, PIN dialog floating on top of a shell that
 * looked broken. Spec 12 treats the PIN as the door, so we knock first and
 * only walk in once the door opens.
 *
 * @param {string} roomId
 * @returns {Promise<boolean>} true when the room was actually entered
 */
async function enterRoom(roomId) {
  if (!roomId) return false;
  if (roomId === state.roomId) {
    state.pendingRoomId = null;
    return true;
  }

  // A PIN we already verified this session: skip the round trip.
  if (!getRoomPin(roomId)) {
    const probe = await API.getRoom(roomId);
    if (!probe.ok) {
      if (probe.error?.status === 401) {
        state.pendingRoomId = roomId;
        handleLockedRoom({ ...probe.error, roomId });
        return false;
      }
      if (probe.error?.status === 404) {
        toast.show(`Room "${roomId}" was not found.`, "error");
      } else if (probe.error) {
        toast.show(probe.error.message || "Could not open that room.", "error");
      }
      state.pendingRoomId = null;
      return false;
    }
  }

  state.pendingRoomId = null;
  await switchRoom(roomId);
  return true;
}

async function switchRoom(roomId) {
  state.roomId = roomId;
  // A deliberate room change gets a fresh chance to connect.
  state.notFoundHandled = false;
  // WHY: each room has its own PIN, so a room that was already asked for must
  // not suppress the prompt for the next one.
  state.pinPromptedFor = null;
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
  $("#room-selector").addEventListener("change", (e) => {
    // Route through the gate so picking a locked room asks for its PIN
    // instead of dropping the user into a shell they cannot read.
    enterRoom(e.target.value).then((entered) => {
      // Keep the selector honest: if we did not move, show where we really are.
      if (!entered) $("#room-selector").value = state.roomId;
    });
  });

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
    .addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const name = $("#new-room-name").value.trim();
      const pin = $("#new-room-pin").value.trim();
      // Busy state: creating a room round-trips, and without it a double-click
      // fires two POSTs and creates two rooms.
      btn.classList.add("loading");
      btn.setAttribute("aria-busy", "true");
      try {
        const result = await API.createRoom({ name: name || undefined, pin: pin || undefined });
        if (!result.ok) {
          toast.show(message(result, "Could not create the room"), "error");
          return;
        }
        const room = result.data;
        // WHY: keep the PIN we just set. Without it every scoped request to the
        // new room 401s and it loads empty (spec 12 room-level guard).
        if (pin) setRoomPin(room.id, pin);
        closeModals();
        $("#new-room-name").value = "";
        $("#new-room-pin").value = "";
        await loadRooms();
        await switchRoom(room.id);
        toast.show("Room created", "success");
      } finally {
        btn.classList.remove("loading");
        btn.removeAttribute("aria-busy");
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
  const isChange = $(".tab.active")?.dataset.tab !== name;
  $$(".tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
  });
  $$(".tab-content").forEach((panel) => {
    const active = panel.id === `tab-${name}`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  // Spec 13.1: the tab survives a reload and can be linked to directly, so
  // the selected tab lives in the URL. replaceState, not pushState: tab
  // switching is not a navigation the user wants to walk back through.
  if (isChange) {
    const url = new URL(location.href);
    url.searchParams.set("tab", name);
    history.replaceState(null, "", url);
  }
  if (name === "devices") {
    renderDevices();
  }
}

/** Read the initial tab from `?tab=`, falling back to Files. */
function initialTab() {
  const tab = new URLSearchParams(location.search).get("tab");
  return $(`.tab[data-tab="${CSS.escape(tab)}"]`) ? tab : "files";
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
    // Spec 6.18: announce arrivals and departures by name. Our own join is
    // echoed back to us by the server, so it is filtered out here rather than
    // making the local device toast itself.
    "device:joined": (d) => onDeviceJoined(d.device),
    "device:left": (d) => removeDevice(d.deviceId, d.name),
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
    // A retry is in flight: show the subtle banner (spec 13.7) and leave the
    // disconnect overlay/countdown exactly as they are. Hiding the overlay
    // here made the disconnect UI flicker on every retry attempt.
    $("#reconnect-banner").hidden = false;
  });
  state.sse.on("reconnected", () => {
    $("#reconnect-banner").hidden = true;
    $("#disconnected-overlay").hidden = true;
    setOffline(false);
    stopOfflineCountdown();
    toast.show("Reconnected", "success");
    refreshAll();
  });
  state.sse.on("disconnected", () => {
    // Spec 13.9: full-page "Connection lost" overlay + countdown, controls disabled
    $("#reconnect-banner").hidden = false;
    $("#disconnected-overlay").hidden = false;
    setOffline(true);
    startOfflineCountdown();
  });

  // The stream was refused for a room-PIN reason. This is not a disconnect:
  // the server is reachable and healthy, we simply are not allowed in yet.
  // Showing the "Connection lost" overlay here was the bug - it told the user
  // their network was broken and counted down a reconnect that could never
  // succeed, while the one thing that would fix it (typing a PIN) was never
  // requested. The API 401 handler raises the prompt; this just makes sure the
  // overlay is not left covering it.
  state.sse.on("locked", (info) => {
    $("#reconnect-banner").hidden = true;
    $("#disconnected-overlay").hidden = true;
    setOffline(false);
    stopOfflineCountdown();
    handleLockedRoom({ status: 401, roomId: info?.roomId });
  });

  // Spec 13.9: the SSE stream now refuses to auto-create unknown rooms, so a
  // deep link to a room that never existed 404s on the stream instead of
  // silently conjuring it. The retry loop cannot fix that -- no amount of
  // waiting makes the room exist -- so it is handled exactly like a missing
  // room discovered at startup: show the message, go back to default.
  state.sse.on("notfound", async (info) => {
    if (info?.roomId && info.roomId !== state.roomId) return;
    // Guard against re-entry: if even the default room reported missing, the
    // fallback below would reconnect into the same 404 and loop forever.
    if (state.notFoundHandled) return;
    state.notFoundHandled = true;
    $("#reconnect-banner").hidden = true;
    $("#disconnected-overlay").hidden = true;
    setOffline(false);
    stopOfflineCountdown();
    // WHY switchRoom rather than a manual close+connect: close() sets
    // `closed = true`, and connect() returns immediately while that is set --
    // so reconnecting by hand would leave the app permanently offline. Going
    // through switchRoom rebuilds the stream correctly, and it is idempotent
    // for the default room because ensureRoomExists() has already reset state.
    await ensureRoomExists();
    await switchRoom(state.roomId);
  });

  state.sse.connect();
}

// Offline handling (spec 13.9)
let offlineTimer = null;
let lastOfflineLabel = "";

/**
 * Put the app into (or take it out of) the disconnected state.
 *
 * The overlay used to be purely visual: `data-offline` disabled the mouse via
 * `pointer-events: none`, but keyboard users could still Tab through the
 * background and fire buttons on a dead connection. `inert` removes the whole
 * subtree from the focus order and from the accessibility tree in one step,
 * and is supported by every browser this app targets - which is why spec
 * 1477 ("no component may use JavaScript when CSS alone is sufficient") is not
 * in tension here: the CSS cannot express focus exclusion, only `inert` can.
 * @param {boolean} off
 */
function setOffline(off) {
  const app = $("#app");
  if (off) {
    document.body.setAttribute("data-offline", "");
    app?.setAttribute("inert", "");
    app?.setAttribute("aria-hidden", "true");
    // Spec 13.9 / WCAG 4.1.3: the alertdialog must receive focus so assistive
    // tech announces it instead of silently stranding focus on a dead button.
    $("#disconnected-overlay")?.focus?.();
  } else {
    document.body.removeAttribute("data-offline");
    app?.removeAttribute("inert");
    app?.removeAttribute("aria-hidden");
  }
}

function startOfflineCountdown() {
  stopOfflineCountdown();
  const el = $("#reconnect-timer");
  const tick = () => {
    const ms = state.sse?.retryMs ?? 3000;
    // Writing textContent unconditionally on a 250ms interval dirties the DOM
    // four times a second to display one integer. Only write on change.
    const next = String(Math.max(1, Math.ceil(ms / 1000)));
    if (next === lastOfflineLabel) return;
    lastOfflineLabel = next;
    if (el) el.textContent = next;
  };
  tick();
  offlineTimer = window.setInterval(tick, 250);
}

function stopOfflineCountdown() {
  if (offlineTimer) window.clearInterval(offlineTimer);
  offlineTimer = null;
  lastOfflineLabel = "";
  // WHY: the countdown writes into #reconnect-timer, so clearing only the
  // interval left the last digit ("3") frozen on screen after a successful
  // reconnect - the banner may be hidden, but the stale number bled into the
  // next disconnect and made the countdown look like it restarted from zero.
  const el = $("#reconnect-timer");
  if (el) el.textContent = "";
}

// ===== Data refresh =====
let refreshingRoom = false;

async function refreshAll() {
  if (!state.refreshedOnce) renderSkeletons();
  const [files, texts, clipboards, devices] = await Promise.all([
    API.listFiles(state.roomId).then((r) => {
      if (!r.ok) return handleListError("files", r.error);
      return r.data;
    }),
    API.listText(state.roomId).then((r) => data(r, [])),
    API.listClipboard(state.roomId).then((r) => data(r, [])),
    API.listDevices(state.roomId).then((r) => data(r, [])),
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
}

// ===== Locked room (spec 12) =====
// A room carrying its own PIN rejects every scoped call with
// 401 requiresRoomPin. The client used to treat that like a dead server: the
// SSE stream failed, the "connection lost" overlay came up, and the backoff
// loop retried forever with no way to supply the PIN. These helpers stop that
// and ask for the PIN instead.

/** Guards against stacking the prompt when several 401s land at once. */
let pinPromptOpen = false;

/**
 * Show a message in the PIN dialog and shake it once.
 * The attribute is re-set every time so the animation restarts on repeat
 * failures - assigning the same value would not re-trigger a CSS animation.
 * @param {HTMLElement|null} el
 * @param {string} message
 */
function setPinError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.removeAttribute("data-shake");
  // Force a reflow so the next attribute write is a fresh animation.
  void el.offsetWidth;
  el.setAttribute("data-shake", "");
}

/**
 * Ask for the current room's PIN, then retry the room with it.
 * @returns {Promise<boolean>} true when the room was unlocked
 */
function promptForRoomPin(roomId) {
  if (pinPromptOpen) return Promise.resolve(false);
  const modal = $("#room-pin-modal");
  const input = $("#room-pin-input");
  const errorEl = $("#room-pin-error");
  if (!modal || !input) return Promise.resolve(false);

  pinPromptOpen = true;
  // The overlay is redundant while we are asking for a PIN: the modal IS the
  // conversation with the user, so the "connection lost" screen would sit on
  // top of the one control that could actually fix it.
  setOffline(false);
  stopOfflineCountdown();
  $("#disconnected-overlay").hidden = true;
  $("#reconnect-banner").hidden = true;

  const hint = $("#room-pin-hint");
  if (hint) {
    hint.textContent = `Enter the PIN to open "${roomId}".`;
  }
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  input.value = "";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      pinPromptOpen = false;
      input.removeEventListener("keydown", onKey);
      $("#room-pin-submit")?.removeEventListener("click", onSubmit);
      // WHY document, not the modal: modals.js dispatches the close event on
      // document, so a listener on the modal element would never fire and
      // dismissing with Escape would hang the promise forever.
      document.removeEventListener("localshare:overlays-closed", onClosed);
      closeAll();
      resolve(value);
    };

    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit();
      }
    };
    const onSubmit = async () => {
      const pin = input.value.trim();
      if (!pin) {
        setPinError(errorEl, "Enter the room PIN.");
        input.focus();
        return;
      }
      setRoomPin(roomId, pin);
      // Verify before switching, so a wrong PIN produces an inline error
      // instead of a silent empty room.
      const probe = await API.getRoom(roomId);
      if (!probe.ok) {
        setRoomPin(roomId, null);
        setPinError(
          errorEl,
          probe.error?.code === "AUTH_INVALID"
            ? "That PIN is not correct."
            : probe.error?.message || "Could not unlock this room."
        );
        input.select();
        return;
      }
      finish(true);
      await enterRoom(roomId);
      toast.show(`Unlocked room "${roomId}"`, "success");
    };
    const onClosed = () => {
      // closeAll() fires this event for ANY overlay, including the silent
      // clear-out that openOverlay() performs when opening ours. Only treat it
      // as a dismissal once our dialog is genuinely on its way out.
      const dialog = $("#room-pin-modal");
      if (dialog && !dialog.hidden && !dialog.classList.contains("modal--closing")) return;
      finish(false);
    };

    // WHY open first, then bind: openOverlay() calls closeAll({silent:true})
    // to clear other overlays, and closeAll dispatches
    // "localshare:overlays-closed" unconditionally. Binding before the open
    // meant the dialog cancelled itself on every single open: the modal was
    // rendered with its listeners already removed and the Unlock button did
    // nothing at all.
    openModal("#room-pin-modal");
    input.addEventListener("keydown", onKey);
    $("#room-pin-submit")?.addEventListener("click", onSubmit);
    // Escape, a backdrop tap, or the close button all route through closeAll().
    document.addEventListener("localshare:overlays-closed", onClosed);
    input.focus();
  });
}

/**
 * React to a room-scoped 401.
 * @param {any} err the api error envelope
 * @returns {boolean} true when it was a locked-room rejection
 */
function handleLockedRoom(err) {
  const roomId = err?.roomId || state.roomId;
  if (err?.status !== 401 || !roomId) return false;
  // Only prompt once per room; repeated 401s from the four parallel GETs must
  // not queue four dialogs.
  if (state.pinPromptedFor === roomId) return true;
  state.pinPromptedFor = roomId;
  promptForRoomPin(roomId).then((unlocked) => {
    if (!unlocked) state.pinPromptedFor = null;
  });
  return true;
}

// Spec 13.9: "Room not found" falls back to the default room with a message
function handleListError(kind, err) {
  if (handleLockedRoom(err)) return [];
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
  $("#file-empty").hidden = true;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 3; i++) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    row.setAttribute("aria-hidden", "true");
    // Not a list item: it stands in for one visually but must not be counted
    // as one by the list's item count.
    row.setAttribute("role", "presentation");
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
  if (!list) return;

  // The file row holds the keyboard focus while the list is rebuilt (j/k
  // navigation, Enter to preview). Rebuilding destroys that element, so focus
  // would fall to <body> and the user would have to Tab back in from the top
  // after every single update. Remember it and restore it afterwards.
  const focusedId = document.activeElement?.closest?.("#file-list .file-row")?.dataset.fileId;
  const shouldRestore = focusedId && list.contains(document.activeElement);

  const previousScroll = list.scrollTop;

  withLiveSuppressed(list, () => {
    // First real payload replaces the skeleton rows (spec 13.7)
    list.querySelectorAll(".skeleton-row").forEach((el) => el.remove());

    // Clear previous rows, keep empty state node (and any skeleton rows)
    Array.from(list.querySelectorAll(".file-row")).forEach((el) => el.remove());

    const query = ($("#file-search")?.value || "").trim().toLowerCase();
    const visible = query
      ? state.files.filter((f) => (f.originalName || "").toLowerCase().includes(query))
      : state.files;

    if (visible.length === 0) {
      empty.hidden = false;
      // Spec 6.16: a disabled control must still say why it is disabled.
      if (dlBtn) {
        dlBtn.disabled = true;
        dlBtn.title = "No files to download";
      }
      renderedFileIds = new Set();
      return;
    }

    empty.hidden = true;
    if (dlBtn) {
      dlBtn.disabled = false;
      dlBtn.title = `Download all ${visible.length} file${visible.length === 1 ? "" : "s"} as a zip`;
    }

    const frag = document.createDocumentFragment();
    const files = [...visible].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const nextIds = new Set(files.map((f) => f.id));
    const firstRender = renderedFileIds.size === 0;

    // Virtualization: spec 19 caps the DOM cost of a large room. 50 rather
    // than 100 because each row is a nested focusable structure, and the
    // skeleton-free chunking keeps the scrollbar honest.
    const VIRTUAL_THRESHOLD = 50;
    const CHUNK = 40;
    let rendered = 0;

    /** Build one row. Shared by the virtualized and plain paths. */
    const buildRow = (f) => {
      const el = renderFileRow(f, {
        onPreview: () => showPreview(f),
        onDownload: () => {},
        onDelete: () => deleteFile(f),
        onSend: (anchor) => sendToDevice(f, anchor || el),
        selected: state.selectedFileId === f.id,
      });
      el.dataset.fileId = f.id;
      // Spec 13.6: newly appeared rows fade in over 200ms ease-out
      if (!firstRender && !renderedFileIds.has(f.id)) el.classList.add("file-row--enter");
      return el;
    };

    const renderChunk = () => {
      const end = Math.min(rendered + CHUNK, files.length);
      for (let i = rendered; i < end; i++) frag.appendChild(buildRow(files[i]));
      rendered = end;
      list.appendChild(frag);
      if (rendered < files.length) {
        // Append a sentinel that triggers the next chunk on intersection
        const sentinel = document.createElement("div");
        sentinel.className = "file-sentinel";
        sentinel.setAttribute("role", "presentation");
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
      for (const f of files) list.appendChild(buildRow(f));
    }
    renderedFileIds = nextIds;
  });

  list.scrollTop = previousScroll;
  list.dispatchEvent(new CustomEvent("localshare:files-rendered"));
  if (shouldRestore) {
    const target = list.querySelector(
      `#file-list .file-row[data-file-id="${CSS.escape(focusedId)}"]`
    );
    (target || empty).focus?.({ preventScroll: true });
  }
}

async function deleteFile(file) {
  if (!confirm(`Delete "${file.originalName}"?`)) return;
  const result = await API.deleteFile(state.roomId, file.id);
  if (!result.ok) {
    toast.show(message(result), "error");
    return;
  }
  removeFile(file.id);
  toast.show(`Deleted ${file.originalName}`, "success");
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
        const result = await API.createTransfer(state.roomId, {
          fileId: file.id,
          targetDeviceId: d.id,
        });
        if (!result.ok) {
          toast.show(message(result), "error");
          return;
        }
        toast.show(
          `Sent ${file.originalName} to ${d.name || "device"}. Awaiting acceptance…`,
          "info"
        );
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

/**
 * Window-wide drag target (spec 6.2).
 *
 * The overlay is driven by a depth counter rather than `dragenter`/`dragleave`
 * alone: a drag across an iframe, a scrollbar or any child element fires
 * `dragleave` without the drag actually ending, which used to flicker the
 * whole screen off mid-drag.
 */
function setupDropOverlay() {
  const overlay = $("#drop-overlay");
  const canvas = $("#drop-field");
  const field = canvas ? createDropField(canvas) : null;
  let dragDepth = 0;
  let rejectTimer = 0;

  const activate = (next = "active") => {
    overlay.classList.remove("drop-overlay--inactive", "drop-overlay--rejected");
    overlay.classList.add(next === "rejected" ? "drop-overlay--rejected" : "drop-overlay--active");
    field?.activate(next);
    window.clearTimeout(rejectTimer);
    // A rejection is transient feedback, not a new resting state: fall back
    // to the normal drop affordance so the next drop is not rejected-looking.
    if (next === "rejected") {
      rejectTimer = window.setTimeout(() => {
        if (!overlay.classList.contains("drop-overlay--active")) deactivate();
      }, 1200);
    }
  };

  function deactivate() {
    window.clearTimeout(rejectTimer);
    overlay.classList.remove("drop-overlay--active", "drop-overlay--rejected");
    overlay.classList.add("drop-overlay--inactive");
    field?.deactivate();
    dragDepth = 0;
  }

  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    activate("active");
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) deactivate();
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    // Spec 6.2 / 451: state follows what is actually under the cursor, so the
    // refusal is visible BEFORE the user releases rather than after.
    const items = e.dataTransfer?.items;
    if (!items) return;
    const hasDirectory = Array.from(items).some((i) => i.kind === "file" && i.type === "");
    activate(hasDirectory ? "rejected" : "active");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    const items = e.dataTransfer?.items;
    const hasDirectory = items && Array.from(items).some((i) => i.kind === "file" && i.type === "");
    deactivate();
    if (hasDirectory) {
      // Spec 6.2: folders are not a supported drop target; say so instead of
      // silently accepting nothing.
      toast.show("Folder upload is not supported. Please zip the folder first.", "warning");
      return;
    }
    if (e.dataTransfer?.files?.length) {
      uploadFiles(e.dataTransfer.files);
    }
  });
  // A drag that ends outside the window never fires `drop`.
  window.addEventListener("dragend", deactivate);
}

/** Max bytes a single file may be, mirroring the server limit. */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * Upload a set of files with bounded concurrency (spec 6.7).
 *
 * Four at a time, not one: the previous strictly-sequential loop meant adding
 * twenty small files took twenty sequential round trips, which reads as "the
 * app is slow" rather than "the network is slow". Bounded rather than
 * unbounded because twenty simultaneous multipart POSTs will exhaust the
 * browser's per-host connection pool and make every one of them slower.
 */
const UPLOAD_CONCURRENCY = 4;

async function uploadFiles(fileList) {
  const queue = $("#upload-queue");
  const uploadBtn = $("#upload-btn");
  const files = Array.from(fileList);

  // Client-side pre-check: the server enforces this too, but failing here
  // costs a millisecond and saves the user from uploading 3 GB to be told no.
  const rejected = files.filter((f) => f.size > MAX_FILE_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_FILE_BYTES);
  if (rejected.length) {
    toast.show(
      `${rejected[0].name} is ${formatBytes(rejected[0].size)}, which is over the ${formatBytes(MAX_FILE_BYTES)} limit.`,
      "error"
    );
  }
  if (!accepted.length) return;

  queue.hidden = false;
  if (!queue.childElementCount) queue.innerHTML = "";
  uploadBtn?.classList.add("loading");
  uploadBtn?.setAttribute("aria-busy", "true");

  /** @type {Array<Promise<void>>} */
  const tasks = accepted.map((file) => () => uploadOne(file, queue));
  await runPool(tasks, UPLOAD_CONCURRENCY);

  uploadBtn?.classList.remove("loading");
  uploadBtn?.removeAttribute("aria-busy");

  // Spec 6.7: the finished row shows green for 1.5s, then the whole queue goes.
  scheduleQueueCleanup(queue, 1500);
}

/**
 * Run `tasks` with at most `limit` in flight.
 * @param {Array<() => Promise<void>>} tasks
 * @param {number} limit
 */
async function runPool(tasks, limit) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      await task();
    }
  });
  await Promise.all(workers);
}

/**
 * Upload one file and render its row through every state.
 * @param {File} file
 * @param {HTMLElement} queue
 */
async function uploadOne(file, queue) {
  const row = document.createElement("div");
  row.className = "upload-row upload-row--active";
  row.innerHTML = `
    <div class="upload-row-info">
      <div class="upload-row-name"></div>
      <div class="upload-row-meta">${formatBytes(file.size)}</div>
      <div class="upload-row-track">
        <progress max="100" value="0" aria-label="Upload progress for ${file.name.replace(/"/g, "&quot;")}"></progress>
        <canvas class="upload-spark" aria-hidden="true" focusable="false"></canvas>
      </div>
    </div>
    <button class="file-action-btn upload-cancel" type="button" aria-label="Cancel upload of ${file.name.replace(/"/g, "&quot;")}"></button>
  `;
  row.querySelector(".upload-row-name").textContent = file.name;

  const progress = row.querySelector("progress");
  const meta = row.querySelector(".upload-row-meta");
  const cancelBtn = row.querySelector(".upload-cancel");
  cancelBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  queue.appendChild(row);

  const spark = createSparkline(row.querySelector(".upload-spark"));
  // One XHR per file, cancellable via AbortController. The cancel button was
  // previously wired to nothing at all.
  const controller = new AbortController();
  const onCancel = () => controller.abort();
  cancelBtn.addEventListener("click", onCancel);

  const fail = (msg) => {
    row.classList.remove("upload-row--active");
    row.classList.add("upload-row--error");
    progress.value = 100;
    meta.textContent = msg;
    // Inline retry instead of forcing the user to re-pick the file
    const retry = document.createElement("button");
    retry.className = "btn btn-ghost btn-sm upload-retry";
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      row.remove();
      uploadOne(file, queue);
    });
    row.querySelector(".upload-row-info").appendChild(retry);
  };

  try {
    const formData = new FormData();
    formData.append("files[]", file, file.name);
    const result = await API.uploadFile(state.roomId, formData, {
      signal: controller.signal,
      onProgress: ({ percent, speed, etaMs }) => {
        progress.value = percent;
        meta.textContent = describeUpload(percent, speed, etaMs);
        spark.push(speed);
      },
    });

    if (!result.ok) {
      if (result.error?.code === "ABORTED") {
        // Spec 6.7: cancelled is grey and final, not an error.
        row.classList.remove("upload-row--active");
        row.classList.add("upload-row--cancelled");
        cancelBtn.remove();
        meta.textContent = "Cancelled";
        return;
      }
      fail(`Failed: ${result.error.message}`);
      toast.show(`Upload failed: ${result.error.message}`, "error");
      return;
    }

    cancelBtn.remove();
    row.classList.remove("upload-row--active");
    row.classList.add("upload-row--done");
    progress.value = 100;
    meta.textContent = `${formatBytes(file.size)} uploaded`;
    const uploaded = Array.isArray(result.data) ? result.data : [result.data];
    uploaded.forEach(upsertFile);
    toast.show(`Uploaded ${file.name}`, "success");
  } finally {
    cancelBtn.removeEventListener("click", onCancel);
    spark.destroy();
  }
}

/**
 * Format one upload progress line.
 * Spec 6.7 joins the fields of its example with an em dash. This app uses a
 * pipe instead: em dashes are banned in authored copy, and a pipe reads as an
 * instrument readout, which is the register this UI is built in.
 * @param {number} percent
 * @param {number} speed bytes/sec
 * @param {number|null} etaMs
 * @returns {string}
 */
function describeUpload(percent, speed, etaMs) {
  const head = `${Math.round(percent)}%`;
  if (!Number.isFinite(speed) || speed <= 0) return head;
  const eta =
    etaMs == null || !Number.isFinite(etaMs)
      ? ""
      : ` | ETA ${etaMs < 1000 ? "<1s" : `${Math.ceil(etaMs / 1000)}s`}`;
  return `${head} | ${formatBytes(speed)}/s${eta}`;
}

/**
 * Hide the upload queue once every row has settled.
 * @param {HTMLElement} queue
 * @param {number} delay ms
 */
function scheduleQueueCleanup(queue, delay) {
  window.setTimeout(() => {
    const pending = queue.querySelectorAll(
      ".upload-row:not(.upload-row--done):not(.upload-row--error):not(.upload-row--cancelled)"
    );
    if (pending.length === 0) {
      queue.hidden = true;
      queue.innerHTML = "";
    }
  }, delay);
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
      const result = await API.shareText(state.roomId, { content });
      if (!result.ok) {
        toast.show(message(result), "error");
        return;
      }
      $("#paste-content").value = "";
      upsertText(result.data);
      closeModals();
      activateTab("text");
      toast.show("Text shared", "success");
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
      const result = await API.shareText(state.roomId, {
        content,
        label: $("#text-label").value.trim() || undefined,
      });
      if (!result.ok) {
        toast.show(message(result), "error");
        return;
      }
      $("#text-content").value = "";
      $("#text-label").value = "";
      upsertText(result.data);
      toast.show("Text shared", "success");
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
  if (!list) return;
  // See withLiveSuppressed(): a full rebuild of the live region would
  // otherwise be announced entry by entry.
  withLiveSuppressed(list, () => {
    Array.from(list.querySelectorAll(".text-entry")).forEach((el) => el.remove());
    if (state.textEntries.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const sorted = [...state.textEntries].sort(
      (a, b) => new Date(b.sharedAt) - new Date(a.sharedAt)
    );
    for (const entry of sorted) {
      list.appendChild(
        renderTextEntry(entry, {
          onDelete: async () => {
            const result = await API.deleteText(state.roomId, entry.id);
            if (!result.ok) {
              toast.show(message(result), "error");
              return;
            }
            removeText(entry.id);
            toast.show("Text entry deleted", "success");
          },
        })
      );
    }
  });
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
  if (!list) return;
  withLiveSuppressed(list, () => {
    Array.from(list.querySelectorAll(".text-entry")).forEach((el) => el.remove());
    if (state.clipboardEntries.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const sorted = [...state.clipboardEntries].sort(
      (a, b) => new Date(b.sharedAt) - new Date(a.sharedAt)
    );
    for (const entry of sorted) {
      list.appendChild(
        renderClipboardEntry(entry, {
          onDelete: async () => {
            const result = await API.deleteClipboard(state.roomId, entry.id);
            if (!result.ok) {
              toast.show(message(result), "error");
              return;
            }
            removeClipboard(entry.id);
          },
        })
      );
    }
  });
}

// ===== Devices =====
function upsertDevice(device) {
  const idx = state.devices.findIndex((d) => d.id === device.id);
  if (idx >= 0) state.devices[idx] = device;
  else state.devices.push(device);
  renderDevices();
}

/**
 * Handle a device joining.
 *
 * WHY: the server broadcasts `device:joined` to the whole room including the
 * device that just connected, and it fires again on every reconnect. Neither
 * is a "someone arrived" event worth a toast, so both are filtered out - the
 * arrival only means something when it is a device we were not already
 * tracking.
 * @param {Object} device
 */
function onDeviceJoined(device) {
  if (!device) return;
  const known = state.devices.some((d) => d.id === device.id);
  upsertDevice(device);
  if (known || device.id === deviceId) return;
  toast.show(`${device.name || "A device"} joined the room`, "info", { duration: 2500 });
}

function removeDevice(id, name) {
  const device = state.devices.find((d) => d.id === id);
  const label = name || device?.name || "A device";
  state.devices = state.devices.filter((d) => d.id !== id);
  renderDevices();
  toast.show(`${label} left the room`, "info", { duration: 2500 });
}

function renderDevices() {
  const list = $("#device-list");
  const empty = $("#device-empty");
  if (!list) return;
  withLiveSuppressed(list, () => {
    Array.from(list.querySelectorAll(".device-row")).forEach((el) => el.remove());

    if (state.devices.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const device of state.devices) {
      list.appendChild(
        renderDeviceRow(device, {
          isSelf: device.id === deviceId,
          onRename: async (name) => {
            const result = await API.renameDevice(state.roomId, device.id, name);
            if (!result.ok) {
              toast.show(message(result), "error");
              return;
            }
            upsertDevice({ ...device, name });
            toast.show("Device renamed", "success");
          },
        })
      );
    }
  });
  presence?.repaint();
  renderDevicePopover();
  updateStatusBar();
}

// ===== Presence cluster (spec 6.18) =====
let presence = null;
let presencePopover = false;

/**
 * Wire the header presence cluster and its roster popover.
 *
 * The header button is a live summary drawn on a canvas (so the header never
 * changes height as devices come and go); the popover is the accessible,
 * focusable full list behind it.
 */
function bindPresence() {
  const button = $("#device-avatars");
  const canvas = $("#presence-canvas");
  if (canvas) {
    presence = createPresenceCluster(canvas, {
      getDevices: () => state.devices,
      selfId: deviceId,
    });
  }
  button?.addEventListener("click", () => {
    if (presencePopover) closeDevicePopover();
    else openDevicePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && presencePopover) {
      e.stopPropagation();
      closeDevicePopover();
    }
  });
  document.addEventListener("click", (e) => {
    if (!presencePopover) return;
    if (e.target.closest("#device-popover") || e.target.closest("#device-avatars")) return;
    closeDevicePopover();
  });
}

function openDevicePopover() {
  const popover = $("#device-popover");
  if (!popover) return;
  renderDevicePopover();
  popover.hidden = false;
  $("#device-avatars")?.setAttribute("aria-expanded", "true");
  presencePopover = true;
  // Spec 13.4 dropdown behaviour, WCAG 2.4.3: focus moves in on open and
  // returns to the trigger on close.
  popover.querySelector(".device-popover-row, .device-popover-list")?.focus?.();
}

function closeDevicePopover() {
  const popover = $("#device-popover");
  if (!popover || !presencePopover) return;
  popover.hidden = true;
  $("#device-avatars")?.setAttribute("aria-expanded", "false");
  presencePopover = false;
  $("#device-avatars")?.focus?.();
}

function renderDevicePopover() {
  const list = $("#device-popover-list");
  const count = $("#device-popover-count");
  if (!list) return;
  list.innerHTML = "";
  const sorted = [...state.devices].sort((a, b) =>
    a.id === deviceId ? -1 : b.id === deviceId ? 1 : a.name?.localeCompare(b.name || "") || 0
  );
  if (count) {
    const n = state.devices.length;
    count.textContent = n === 1 ? "1 device" : `${n} devices`;
  }
  for (const device of sorted) {
    const isSelf = device.id === deviceId;
    const row = document.createElement("div");
    row.className = "device-popover-row";
    row.setAttribute("role", "listitem");

    // Avatar
    const avatar = document.createElement("div");
    const colorIndex = device.color ? avatarColors.indexOf(device.color) : hashIndex(device.id);
    avatar.className = `device-popover-avatar device-avatar device-avatar--${colorIndex >= 0 ? colorIndex : 0}`;
    avatar.textContent = (device.name || "?").slice(0, 2);
    avatar.setAttribute("aria-hidden", "true");

    // Info
    const info = document.createElement("div");
    info.className = "device-popover-info";

    const name = document.createElement("span");
    name.className = "device-popover-name";
    name.textContent = device.name || "Unnamed device";
    if (isSelf) {
      const you = document.createElement("span");
      you.className = "device-popover-you";
      you.textContent = "(you)";
      name.appendChild(you);
    }
    info.appendChild(name);

    // Since / joined time
    const since = document.createElement("span");
    since.className = "device-popover-since";
    since.textContent = device.joinedAt ? `since ${formatRelativeTime(device.joinedAt)}` : "";
    info.appendChild(since);

    // Device type badge
    if (device.deviceType) {
      const typeBadge = document.createElement("span");
      typeBadge.className = "device-popover-device-type";
      // WHY innerHTML, not append(): deviceTypeIcon returns an SVG *string*.
      // Element.append() with a string creates a TEXT node, so the raw
      // "<svg width=...>" markup was painted as visible text in the popover.
      const typeIcon = document.createElement("span");
      typeIcon.className = "device-popover-device-icon";
      typeIcon.innerHTML = deviceTypeIcon(device.deviceType);
      typeBadge.append(typeIcon, document.createTextNode(device.deviceType));
      info.appendChild(typeBadge);
    }

    row.append(avatar, info);
    list.appendChild(row);
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
/**
 * Rank a candidate address by how likely it is to be the LAN address a phone
 * can actually reach.
 *
 * WHY: `netServerInfo` can report several interfaces (docker0, virbr0, a VPN
 * tap, a Wi-Fi and an Ethernet), and the first one in the list is frequently
 * not the one a person standing in the room would type. Private ranges are
 * ordered by how common they are in consumer networks.
 * @param {string} address
 * @returns {number} Higher is better; -1 means "not a usable LAN address".
 */
function rankLanAddress(address) {
  if (/^192\.168\./.test(address)) return 3;
  if (/^10\./.test(address)) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 1;
  return -1;
}

async function openQRModal() {
  openModal("#qr-modal");
  const select = $("#qr-ip-select");
  const setUrl = (url) => {
    $("#qr-url").textContent = url;
    drawQR(url);
  };

  const info = data(await API.serverInfo(), null);
  state.serverInfo = info;
  select.innerHTML = "";
  const options = [
    {
      name: "localhost",
      url: `${location.protocol}//${location.hostname}:${location.port || 80}`,
      rank: 0,
    },
  ];
  for (const iface of info?.interfaces || []) {
    options.push({
      name: iface.name,
      url: `${location.protocol}//${iface.address}:${info.port}`,
      rank: rankLanAddress(iface.address),
    });
  }
  // Best LAN candidate first, then everything else in server order.
  options.sort((a, b) => b.rank - a.rank);
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.url;
    o.textContent = `${opt.name} · ${opt.url}`;
    select.appendChild(o);
  }

  if (!options.length) {
    const url = location.origin;
    const opt = document.createElement("option");
    opt.value = url;
    opt.textContent = url;
    select.appendChild(opt);
    select.value = url;
    setUrl(url);
  } else {
    // Spec 6.6: default to the address another device can reach, not to
    // localhost, which is useless to the person scanning the code.
    select.value = options[0].url;
    setUrl(select.value);
  }

  select.onchange = () => setUrl(select.value);

  $("#copy-url-btn").onclick = async () => {
    // copyText works over plain-HTTP LAN too (execCommand fallback, spec 24.1)
    if (await copyText($("#qr-url").textContent)) {
      toast.show("URL copied", "success");
    } else {
      toast.show("Could not copy URL", "error");
    }
  };
}

function drawQR(text) {
  const host = document.getElementById("qr-code");
  if (!host) return;
  host.innerHTML = "";
  host.hidden = false;
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
    host.hidden = true;
  };
  host.appendChild(img);
}

// ===== Transfers =====
function showTransferModal(transfer) {
  $("#transfer-message").textContent = `${transfer.sourceDeviceName} wants to send you a file.`;
  $("#transfer-file-info").textContent = `Transfer expires in 60 seconds.`;
  openModal("#transfer-modal");

  const accept = $("#transfer-accept");
  const decline = $("#transfer-decline");

  // One response per offer. Without a busy state, an impatient double-click on
  // Accept sent two responses and the server had to arbitrate which one won.
  const respond = async (decision) => {
    accept.disabled = true;
    decline.disabled = true;
    accept.setAttribute("aria-busy", "true");
    try {
      const result = await API.respondTransfer(state.roomId, transfer.id, decision);
      if (!result.ok) {
        toast.show(message(result), "error");
        return;
      }
      closeModals();
      if (decision === "accept") {
        toast.show("Download starting…", "success");
        window.location.href = API.transferUrl(state.roomId, transfer.id);
      } else {
        toast.show("Transfer declined", "info");
      }
    } finally {
      accept.disabled = false;
      decline.disabled = false;
      accept.removeAttribute("aria-busy");
    }
  };

  accept.onclick = () => respond("accept");
  decline.onclick = () => respond("decline");
}

function showShutdownBanner(data) {
  toast.show(data.message || "Server shutting down…", "warning", { duration: 5000 });
}

// ===== Theme =====
// WHY 3 states instead of a 2 state toggle: spec 6.10 asks for a system / light /
// dark cycle. A 3 state cycle with no per state affordance looks broken, because
// one of the three clicks lands on a visually identical result (on a dark OS,
// "system" and "dark" render the same). So every state gets an identity:
// the button announces the mode it switches TO, the pressed state is exposed
// for assistive tech, and the icon crossfades instead of hard swapping.
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABELS = {
  system: { next: "Light", nextShort: "Light", current: "System" },
  light: { next: "Dark", nextShort: "Dark", current: "Light" },
  dark: { next: "System", nextShort: "System", current: "Dark" },
};

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
  const current = document.documentElement.dataset.theme || "system";
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  document.documentElement.dataset.theme = next;
  localStorage.setItem("localshare:theme", next);
  updateThemeIcon(next);
  syncThemeColor(next);
  popThemeIcon();
}

/* Restart the glyph pop on every click, even when the swap lands on the same
   glyph (dark -> system on a dark OS). Without this, one of the three states
   changes nothing visible and the button feels broken. */
function popThemeIcon() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.classList.remove("theme-pop");
  void btn.offsetWidth;
  btn.classList.add("theme-pop");
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
  const btn = document.getElementById("theme-toggle");
  const sun = document.querySelector(".icon-sun");
  const moon = document.querySelector(".icon-moon");
  const labels = THEME_LABELS[theme] || THEME_LABELS.system;

  // Announce what the next click does, so no click ever looks like a no-op.
  if (btn) {
    btn.setAttribute("aria-label", `Theme: ${labels.current}. Switch to ${labels.next}`);
    btn.setAttribute("title", `Theme: ${labels.current}. Switch to ${labels.next}`);
    btn.dataset.themeState = theme;
  }

  if (!sun || !moon) return;
  const effective = effectiveTheme(theme);
  const isDark = effective === "dark";
  // WHY a CSS class and not the `hidden` attribute: `hidden` is an HTMLElement
  // IDL property, so `svg.hidden` is undefined on an SVGElement and assigning
  // it only creates an expando property - the attribute was never reflected,
  // so the glyph never actually hid. classList works identically on both
  // element types and is driven by the `.icon-hidden` rule in components.css.
  sun.classList.toggle("icon-hidden", isDark);
  moon.classList.toggle("icon-hidden", !isDark);
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

/**
 * Swipe-to-delete on touch (spec 13.1, PROMPT.md:1405).
 *
 * WHY a JS gesture at all: the spec asks for swipe-to-delete "via CSS overflow
 * trick", and the CSS part IS CSS - `.file-row--swiping` slides a delete action
 * in from the right and CSS animates it. JavaScript is needed for only the two
 * things CSS cannot do: reading the pointer, and committing the delete. It is
 * bound to the Files list only, and only when the primary pointer is coarse, so
 * it can never intercept a desktop click or a mouse drag-to-select.
 */
/**
 * Create a stylesheet we can insert and delete single rules in, without
 * touching inline `style` attributes (which the CSP forbids).
 *
 * WHY the fallback: `document.adoptedStyleSheets` does not exist in Safari and
 * iOS Safari before 16.4, nor in older Android WebViews. Spreading an
 * `undefined` property threw a TypeError inside bindSwipeToDelete(), and since
 * startApp() calls its bind*() helpers in sequence with no try/catch, that one
 * throw aborted everything after it - no presence canvas, no drop field, no
 * room load, no SSE. A <style> element's own sheet exposes the same
 * insertRule/deleteRule API, so the swipe feature degrades to "works on
 * everything" instead of "kills the whole app".
 *
 * @returns {{sheet: CSSStyleSheet, dispose: () => void}}
 */
function createRuleSheet() {
  const supportsConstructable =
    typeof CSSStyleSheet === "function" &&
    typeof CSSStyleSheet.prototype.replaceSync === "function" &&
    Array.isArray(document.adoptedStyleSheets);

  if (supportsConstructable) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return { sheet, dispose: () => {} };
  }

  // Fallback: a plain <style> tag is CSP-safe (stylesheets are allowed by
  // style-src) and its .sheet gives us the same rule API.
  const el = document.createElement("style");
  el.setAttribute("data-swipe", "");
  document.head.appendChild(el);
  return {
    sheet: el.sheet,
    dispose: () => el.remove(),
  };
}

function bindSwipeToDelete() {
  const list = $("#file-list");
  if (!list) return;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  if (finePointer) return;

  const SWIPE_TRIGGER = 88; // px before the row commits to open
  const MAX_SWIPE = 132;
  let active = null;

  // Constructable stylesheet for swipe transforms (CSP-compliant, no inline styles).
  // We insert/delete a single rule for the currently-swiping row by its data-file-id.
  // Applies transform directly to the row (not a child) since the whole row slides.
  const { sheet: swipeSheet } = createRuleSheet();

  function updateSwipeRule(fileId, delta) {
    // Remove old rule if any
    if (swipeSheet.cssRules.length > 0) swipeSheet.deleteRule(0);
    // Insert new rule for this specific row
    swipeSheet.insertRule(
      `.file-row[data-file-id="${CSS.escape(fileId)}"].swiping { transform: translateX(${delta}px); }`,
      0
    );
  }

  function clearSwipeRule() {
    if (swipeSheet.cssRules.length > 0) swipeSheet.deleteRule(0);
  }

  const closeRow = (row) => {
    row.classList.remove("swiping");
    clearSwipeRule();
  };

  list.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" || !e.isPrimary) return;
      const row = e.target.closest(".file-row");
      if (!row || e.target.closest("button")) return;
      active = { row, startX: e.clientX, delta: 0, committed: false };
    },
    { passive: true }
  );

  list.addEventListener(
    "pointermove",
    (e) => {
      if (!active) return;
      const delta = e.clientX - active.startX;
      if (delta < 6 && !active.row.classList.contains("swiping")) return; // vertical intent
      active.delta = Math.max(-MAX_SWIPE, Math.min(0, delta));
      active.row.classList.add("swiping");
      updateSwipeRule(active.row.dataset.fileId, active.delta);
    },
    { passive: true }
  );

  const finish = () => {
    if (!active) return;
    const { row, delta } = active;
    const opened = row.classList.contains("swiping") && -delta >= SWIPE_TRIGGER;
    active = null;
    if (!opened) {
      closeRow(row);
      return;
    }
    // Snap fully open, then delete: the confirmation is the existing
    // confirm() dialog, so a stray swipe never destroys a file unasked.
    updateSwipeRule(row.dataset.fileId, -MAX_SWIPE);
    const file = state.files.find((f) => f.id === row.dataset.fileId);
    if (file) deleteFile(file);
    else closeRow(row);
  };

  list.addEventListener("pointerup", finish, { passive: true });
  list.addEventListener(
    "pointercancel",
    () => {
      if (active) closeRow(active.row);
      active = null;
    },
    { passive: true }
  );

  // Re-rendering the list drops any half-open row.
  list.addEventListener("localshare:files-rendered", () => {
    list.querySelectorAll(".file-row.swiping").forEach(closeRow);
  });
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
  // `nearest` so the row moves the minimum distance needed; scroll-margin-top
  // (layout.css) keeps the sticky 56px header from covering it.
  rows[state.focusedIndex].scrollIntoView({ block: "nearest" });
}

/**
 * Warn before discarding an unsent draft.
 *
 * The text composer has no autosave: closing the tab loses whatever was
 * typed. A native confirm is the one honest way to say so, and it costs
 * nothing when the field is empty (which is the overwhelmingly common case).
 */
function bindUnsavedGuard() {
  window.addEventListener("beforeunload", (e) => {
    const dirty = ["#text-content", "#paste-content", "#new-room-name", "#new-room-pin"].some(
      (sel) => $(sel)?.value?.trim()
    );
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

// ===== Boot =====
bindUnsavedGuard();
activateTab(initialTab());
boot().catch((err) => {
  console.error("Boot failed:", err);
  // Show app even on boot failure so users see something
  $("#app").hidden = false;
  toast.show("Failed to initialise. Some features may not work.", "error");
});
