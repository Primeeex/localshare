/**
 * API client module for LocalShare.
 * All fetch calls go through here.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Device identity, persisted in sessionStorage so a tab reload keeps its id. */
export const deviceId = (() => {
  let id = sessionStorage.getItem("localshare:deviceId");
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    sessionStorage.setItem("localshare:deviceId", id);
  }
  return id;
})();

export let deviceName = localStorage.getItem("localshare:deviceName") || "";
export function setDeviceName(name) {
  deviceName = name;
  localStorage.setItem("localshare:deviceName", name);
}

function deviceHeaders(extra = {}) {
  return { "X-Device-Id": deviceId, "X-Device-Name": deviceName || "Unknown", ...extra };
}

async function request(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = res.statusText;
    let code = "INTERNAL_ERROR";
    try {
      const body = await res.json();
      message = body.error?.message || message;
      code = body.error?.code || code;
    } catch {
      /* ignore body parse errors */
    }
    // Session missing or expired: bounce to the server, which serves pin.html
    if (res.status === 401 && code === "AUTH_REQUIRED" && !path.startsWith("/api/auth/")) {
      window.location.replace("/");
    }
    const err = new Error(message);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
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
  uploadFile: (roomId, formData, onProgress) =>
    uploadWithProgress(`/api/rooms/${roomId}/files`, formData, onProgress),
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

/**
 * XHR-based upload so we can report real progress.
 * fetch() cannot report request upload progress.
 */
function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("X-Device-Id", deviceId);
    xhr.setRequestHeader("X-Device-Name", deviceName || "Unknown");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || "{}"));
        } catch {
          resolve({});
        }
      } else {
        let message = "Upload failed";
        let code = "INTERNAL_ERROR";
        try {
          const body = JSON.parse(xhr.responseText);
          message = body.error?.message || message;
          code = body.error?.code || code;
        } catch {
          /* ignore */
        }
        const err = new Error(message);
        err.code = code;
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(formData);
  });
}

export default API;
export { request, deviceHeaders };
