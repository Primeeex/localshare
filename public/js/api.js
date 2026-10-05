/**
 * API client module for LocalShare.
 * All fetch calls go through here.
 *
 * ## Result contract (spec PROMPT.md §17 "Client-Side")
 *
 * `request()` and every `API.*` helper RESOLVE, they never reject:
 *
 * ```js
 * { ok: true,  data: <parsed body | null> }
 * { ok: false, error: { code: string|null, message: string, status: number } }
 * ```
 *
 * - `data` is the parsed JSON body (`null` for `204 No Content`).
 * - `error.code` is the server's error code, or `null` when unknown
 *   (network failure / abort).
 * - `error.status` is the HTTP status, or `0` for a transport failure.
 *
 * Callers branch on `result.ok`; they must not wrap these in try/catch.
 *
 * @module api
 */

import { toast } from "./toast.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

const ROOM_PIN_KEY = "localshare:roomPins";

/**
 * Remember the PIN for each room this browser created or unlocked.
 *
 * WHY: the server guards a PIN room with `X-Room-Pin` on every scoped request
 * (spec 12). Creating a room returned the new id but the client discarded the
 * PIN it had just typed, so every follow-up call - the four refreshAll() GETs
 * and the SSE stream - came back 401 and the room looked empty/broken.
 * Keyed by room id so switching between rooms uses the right PIN each time.
 */
function readRoomPins() {
  try {
    return JSON.parse(localStorage.getItem(ROOM_PIN_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

/** @param {string} roomId @param {string|null} pin */
export function setRoomPin(roomId, pin) {
  const pins = readRoomPins();
  if (pin) pins[roomId] = pin;
  else delete pins[roomId];
  try {
    localStorage.setItem(ROOM_PIN_KEY, JSON.stringify(pins));
  } catch {
    /* storage unavailable - the PIN is still used for this page's lifetime */
  }
}

/** @param {string} roomId @returns {string|null} */
export function getRoomPin(roomId) {
  return readRoomPins()[roomId] || null;
}

/**
 * Read a storage value without letting a blocked storage area kill the module.
 * Safari private mode and some hardened LAN browsers throw on access.
 */
function readStorage(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(store, key, value) {
  try {
    store.setItem(key, value);
  } catch {
    /* storage unavailable - the session simply will not be remembered */
  }
}

const DEVICE_ID_KEY = "localshare_deviceId";
const LEGACY_DEVICE_ID_KEY = "localshare:deviceId";

/**
 * Device identity.
 *
 * Spec 24.4 wants `localStorage["localshare_deviceId"]` so a new tab (or a new
 * browser session) keeps the SAME identity instead of appearing as a stranger.
 * The previous key lived in `sessionStorage`, so every fresh tab looked like a
 * brand new device.
 *
 * Migration: read the new key; if absent, adopt the old sessionStorage id so
 * an already-open tab keeps its identity; only then generate a new one.
 */
export const deviceId = (() => {
  let id = readStorage(localStorage, DEVICE_ID_KEY);
  if (!id) {
    id = readStorage(sessionStorage, LEGACY_DEVICE_ID_KEY);
    if (!id) id = randomId();
    writeStorage(localStorage, DEVICE_ID_KEY, id);
  }
  return id;
})();

/**
 * 12 hex chars, matching what `crypto.randomUUID()` yields after the strip.
 * WHY the fallback: `crypto.randomUUID()` is secure-context-only, so on a LAN
 * device opening http://<lan-ip>:3000 (plain HTTP) it is `undefined` and this
 * module threw at import time, killing the whole app (no theme toggle, no
 * uploads - only the skip link rendered). `crypto.getRandomValues` works in
 * insecure contexts.
 */
function randomId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export let deviceName = readStorage(localStorage, "localshare:deviceName") || "";
export function setDeviceName(name) {
  deviceName = name;
  writeStorage(localStorage, "localshare:deviceName", name);
}

function deviceHeaders(extra = {}) {
  return { "X-Device-Id": deviceId, "X-Device-Name": deviceName || "Unknown", ...extra };
}

/**
 * Human message for an HTTP status with no usable error envelope.
 * @param {number} status HTTP status code.
 * @param {string} [statusText] Status text from the response.
 * @returns {string}
 */
function statusMessage(status, statusText) {
  if (status === 0) return "Network unreachable";
  const byCode = {
    400: "Bad request",
    401: "Authentication required",
    403: "Not allowed",
    404: "Not found",
    409: "Conflict",
    413: "File too large",
    422: "Unprocessable request",
    429: "Too many requests",
    500: "Server error",
    507: "Server is out of storage",
  };
  return byCode[status] || statusText || `Request failed (${status})`;
}

/**
 * Pull `{ok, data, error}` out of a server response body.
 * @param {any} body Parsed body, or `null` when unparseable.
 * @returns {{code: string|null, message: string, data: any}}
 */
function fromEnvelope(body) {
  const error = body && typeof body === "object" ? body.error : null;
  return {
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : "",
    data: body && typeof body === "object" && "data" in body ? body.data : body,
  };
}

/**
 * Parse a response body, tolerating empty and non-JSON payloads.
 * @param {Response} res Fetch response.
 * @returns {Promise<{parsed: any, failed: boolean}>}
 */
async function readBody(res) {
  if (res.status === 204) return { parsed: null, failed: false };
  try {
    const text = await res.text();
    if (!text) return { parsed: null, failed: false };
    return { parsed: JSON.parse(text), failed: false };
  } catch {
    return { parsed: null, failed: true };
  }
}

/**
 * Perform an API request and wrap the outcome in a Result.
 *
 * NEVER rejects - network failures, aborts, non-2xx statuses and unparseable
 * bodies all resolve to `{ ok: false, error }`.
 *
 * @param {string} path Request path beginning with `/`.
 * @param {RequestInit & {silent?: boolean}} [options]
 *   `silent: true` suppresses the error toast (the caller toasts it instead).
 * @returns {Promise<{ok: true, data: any} | {ok: false, error: {code: string|null, message: string, status: number}}>}
 */
function withRoomPin(path, init = {}) {
  // WHY this wrapper: every room-scoped call must present the room PIN, but
  // only when one is known. Attaching it centrally means a new endpoint
  // cannot forget the header and silently 401.
  const match = /^\/api\/rooms\/([^/?]+)/.exec(path);
  if (!match) return init;
  const pin = getRoomPin(decodeURIComponent(match[1]));
  if (!pin) return init;
  return { ...init, headers: { ...(init.headers || {}), "X-Room-Pin": pin } };
}

async function request(path, options = {}) {
  const { silent = false, ...rest } = options;
  const init = withRoomPin(path, rest);
  const method = init.method || "GET";
  let res;

  try {
    res = await fetch(path, init);
  } catch (err) {
    // Network failure, DNS error, CORS rejection or an abort.
    const aborted = err?.name === "AbortError";
    const error = {
      code: aborted ? "ABORTED" : "NETWORK_ERROR",
      message: aborted ? "Request cancelled" : "Network unreachable",
      status: 0,
    };
    console.warn(`[api] ${method} ${path} failed:`, error.code, err?.message || err);
    if (!silent && !aborted) toast?.show?.(error.message, "error");
    return { ok: false, error };
  }

  const { parsed, failed } = await readBody(res);

  if (!res.ok) {
    const env = fromEnvelope(parsed);
    const code = env.code || "INTERNAL_ERROR";
    const message = env.message || statusMessage(res.status, res.statusText);
    console.warn(`[api] ${method} ${path} -> ${res.status} ${code}: ${message}`);

    // WHY the roomPin carve-out: a room-level PIN (spec 12) is a *room* guard,
    // not the server session. It answers 401 AUTH_REQUIRED too, so the session
    // branch below used to fire and `location.replace("/")` the moment you
    // created a PIN room - four parallel 401s each navigating away, which read
    // as an instant crash. Only the server session should bounce to the PIN page.
    const isRoomPinRejection = res.status === 401 && parsed?.error?.requiresRoomPin === true;
    if (
      res.status === 401 &&
      code === "AUTH_REQUIRED" &&
      !isRoomPinRejection &&
      !path.startsWith("/api/auth/")
    ) {
      window.location.replace("/");
    }
    // WHY no toast here: refreshAll() fires four scoped calls in parallel, so a
    // locked room would stack four identical "Room PIN required" toasts. The
    // PIN prompt is the user-facing message; this is only its cause.
    if (!silent && !isRoomPinRejection) toast?.show?.(message, "error");
    // WHY surface roomId + requiresRoomPin: the UI needs to tell a locked ROOM
    // apart from other 401s in order to prompt for the PIN instead of showing
    // an error the user cannot act on.
    return {
      ok: false,
      error: {
        code,
        message,
        status: res.status,
        roomId: parsed?.error?.roomId,
        requiresRoomPin: isRoomPinRejection,
      },
    };
  }

  if (failed) {
    const message = statusMessage(res.status, res.statusText);
    console.warn(`[api] ${method} ${path} -> ${res.status}: response body was not JSON`);
    if (!silent) toast?.show?.(message, "error");
    return { ok: false, error: { code: "INVALID_RESPONSE", message, status: res.status } };
  }

  // Unwrap the `{ok, data, error}` envelope the server uses on success.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in parsed) {
    return { ok: true, data: parsed.data };
  }
  return { ok: true, data: parsed };
}

const API = {
  // Server
  serverInfo: () => request("/api/server/info"),
  health: () => request("/api/server/health"),

  // Auth
  authStatus: () => request("/api/auth/status"),
  verifyPin: (pin) =>
    request("/api/auth/verify", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ pin }),
    }),
  logout: () => request("/api/auth/logout", { method: "POST" }),

  // Rooms
  listRooms: () => request("/api/rooms"),
  createRoom: (data) =>
    request("/api/rooms", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(data) }),
  getRoom: (roomId) => request(`/api/rooms/${roomId}`),
  deleteRoom: (roomId) => request(`/api/rooms/${roomId}`, { method: "DELETE" }),

  // Files
  listFiles: (roomId) => request(`/api/rooms/${roomId}/files`),
  /**
   * Upload one or more files.
   * @param {string} roomId
   * @param {FormData} formData
   * @param {Object|Function} [opts] `{onProgress, signal}` - a legacy
   *   `(loaded, total)` callback is also accepted so an older `app.js` keeps working.
   * @returns {Promise<{ok: true, data: any} | {ok: false, error: object}>}
   */
  uploadFile: (roomId, formData, opts) =>
    uploadWithProgress(`/api/rooms/${roomId}/files`, formData, normaliseUploadOptions(opts)),
  updateFile: (roomId, fileId, data) =>
    request(`/api/rooms/${roomId}/files/${fileId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    }),
  deleteFile: (roomId, fileId) =>
    request(`/api/rooms/${roomId}/files/${fileId}`, { method: "DELETE" }),
  fileUrl: (roomId, fileId, mode = "download") => `/api/rooms/${roomId}/files/${fileId}/${mode}`,
  zipUrl: (roomId) => `/api/rooms/${roomId}/files/zip`,

  // Text
  listText: (roomId) => request(`/api/rooms/${roomId}/text`),
  shareText: (roomId, data) =>
    request(`/api/rooms/${roomId}/text`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    }),
  updateText: (roomId, id, data) =>
    request(`/api/rooms/${roomId}/text/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    }),
  deleteText: (roomId, id) => request(`/api/rooms/${roomId}/text/${id}`, { method: "DELETE" }),

  // Clipboard
  listClipboard: (roomId) => request(`/api/rooms/${roomId}/clipboard`),
  addClipboard: (roomId, data) =>
    request(`/api/rooms/${roomId}/clipboard`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    }),
  deleteClipboard: (roomId, id) =>
    request(`/api/rooms/${roomId}/clipboard/${id}`, { method: "DELETE" }),

  // Devices
  listDevices: (roomId) => request(`/api/rooms/${roomId}/devices`),
  renameDevice: (roomId, deviceId, name) =>
    request(`/api/rooms/${roomId}/devices/${deviceId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name }),
    }),

  // Transfers
  createTransfer: (roomId, data) =>
    request(`/api/rooms/${roomId}/transfers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    }),
  respondTransfer: (roomId, id, action) =>
    request(`/api/rooms/${roomId}/transfers/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action }),
    }),
  transferUrl: (roomId, id) => `/api/rooms/${roomId}/transfers/${id}/download`,
};

/** Number of samples in the rolling speed window. */
const SPEED_WINDOW = 5;

/**
 * Accept both the current `({onProgress, signal})` options object and the
 * legacy `(loaded, total)` progress callback, normalising to the object form.
 * @param {Object|Function|undefined} opts
 * @returns {{onProgress?: Function, signal?: AbortSignal}}
 */
function normaliseUploadOptions(opts) {
  if (typeof opts === "function") return { onProgress: (p) => opts(p.loaded, p.total) };
  return opts && typeof opts === "object" ? opts : {};
}

/**
 * Upload with byte-level progress.
 *
 * XHR, not `fetch`: `fetch()` cannot observe request-body upload progress,
 * and `XMLHttpRequest.upload.onprogress` is the only browser API that does.
 *
 * Resolves (never rejects) with `{ok:true, data}` on 2xx, or
 * `{ok:false, error:{code, message, status}}` otherwise - including
 * `{code:"ABORTED", message:"Upload cancelled", status:0}` when `signal`
 * aborts.
 *
 * @param {string} url Target URL.
 * @param {FormData} formData Body.
 * @param {Object} [opts]
 * @param {(p: {loaded: number, total: number, percent: number, speed: number|null, etaMs: number|null}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: true, data: any} | {ok: false, error: object}>}
 */
function uploadWithProgress(url, formData, opts = {}) {
  const { onProgress, signal } = opts;

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(abortResult());
      return;
    }

    const xhr = new XMLHttpRequest();
    /** Rolling (time, loaded) samples used for the transfer speed. */
    const samples = [];
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      detachSignal();
      resolve(result);
    };

    const onAbort = () => {
      xhr.abort();
      finish(abortResult());
    };

    function detachSignal() {
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    function abortResult() {
      return {
        ok: false,
        error: { code: "ABORTED", message: "Upload cancelled", status: 0 },
      };
    }

    xhr.open("POST", url, true);
    xhr.setRequestHeader("X-Device-Id", deviceId);
    xhr.setRequestHeader("X-Device-Name", deviceName || "Unknown");

    xhr.upload.onprogress = (e) => {
      if (!onProgress || !e.lengthComputable || settled) return;
      const total = e.total;
      const loaded = e.loaded;

      const now = e.timeStamp || performance.now();
      samples.push({ t: now, loaded });
      if (samples.length > SPEED_WINDOW) samples.shift();

      // Average over the oldest retained sample, recomputed on every event so
      // a stalled window decays instead of freezing the number forever.
      const first = samples[0];
      const elapsedMs = now - first.t;
      const speed =
        samples.length >= 2 && elapsedMs > 0 ? (loaded - first.loaded) / (elapsedMs / 1000) : 0;

      const validSpeed = Number.isFinite(speed) && speed > 0 ? speed : null;
      const remaining = total - loaded;
      // Guard: a zero/NaN speed must never surface as Infinity.
      const etaMs =
        validSpeed && remaining > 0
          ? Math.max(0, Math.round((remaining / validSpeed) * 1000))
          : null;

      onProgress({
        loaded,
        total,
        percent: total ? Math.round((loaded / total) * 100) : 0,
        speed: validSpeed,
        etaMs,
      });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          console.warn(`[api] POST ${url} -> ${xhr.status}: response body was not JSON`);
          data = null;
        }
        // Unwrap the server envelope when it is present.
        if (data && typeof data === "object" && !Array.isArray(data) && "data" in data) {
          data = data.data;
        }
        finish({ ok: true, data });
        return;
      }
      let code = null;
      let message = "";
      try {
        const env = fromEnvelope(JSON.parse(xhr.responseText));
        code = env.code;
        message = env.message;
      } catch {
        /* body was not JSON - synthesise from the status below */
      }
      const error = {
        code: code || "INTERNAL_ERROR",
        message: message || statusMessage(xhr.status, xhr.statusText),
        status: xhr.status,
      };
      console.warn(`[api] POST ${url} -> ${xhr.status} ${error.code}: ${error.message}`);
      finish({ ok: false, error });
    };

    xhr.onerror = () => {
      console.warn(`[api] POST ${url} -> network error`);
      finish({
        ok: false,
        error: { code: "NETWORK_ERROR", message: "Network unreachable", status: 0 },
      });
    };

    xhr.ontimeout = () => {
      finish({
        ok: false,
        error: { code: "TIMEOUT", message: "Upload timed out", status: 0 },
      });
    };

    xhr.onabort = () => finish(abortResult());

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
      xhr.send(formData);
    } catch (err) {
      console.warn(`[api] POST ${url} could not be sent:`, err?.message || err);
      finish({
        ok: false,
        error: { code: "NETWORK_ERROR", message: "Upload could not be started", status: 0 },
      });
    }
  });
}

export default API;
export { request, deviceHeaders, uploadWithProgress };
