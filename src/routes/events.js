/**
 * SSE events endpoint.
 * @module routes/events
 */

import { asyncRoute } from "../middleware/asyncRoute.js";
import { randomUUID } from "node:crypto";
import os from "node:os";

/**
 * Create SSE events route.
 * @param {Object} deps
 * @param {import('../rooms.js').RoomManager} deps.rooms
 * @param {import('../sse.js').SSEManager} deps.sse
 * @param {import('../logger.js').Logger} deps.logger
 * @param {Object} deps.config
 * @returns {Function} Express route handler
 */
export default function createEventsRoute(deps) {
  const { rooms, sse, logger, config } = deps;

  return asyncRoute(async (req, res) => {
    const roomId = req.query.roomId || "default";
    // WHY: EventSource cannot send custom headers, so identity rides query params
    const deviceId = req.query.deviceId || req.headers["x-device-id"] || randomUUID().slice(0, 12);

    // Get or create room
    // WHY: the room id comes from the URL, so it must stay stable across visits
    let room;
    try {
      room = rooms.getRoom(roomId);
    } catch {
      room = rooms.createRoom({ id: roomId, name: roomId });
    }

    // Add SSE client
    const client = sse.addClient(roomId, res, deviceId);
    if (!client) return; // Client was rejected (max connections)

    // WHY: announce device joined
    const device = {
      id: deviceId,
      name: req.query.deviceName || req.headers["x-device-name"] || generateDeviceName(deviceId),
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      userAgent: req.headers["user-agent"] || "",
      deviceType: detectDeviceType(req.headers["user-agent"]),
      deviceIcon: detectDeviceIcon(req.headers["user-agent"]),
      color: hashColor(deviceId),
    };
    rooms.addDevice(roomId, device);

    // Send initial state
    const files = await deps.storage.listFiles(roomId);
    const textEntries = Array.from(room.textEntries?.values() || []);
    const clipboardEntries = Array.from(room.clipboardEntries || []);
    const devices = rooms.getDevices(roomId);

    sse.broadcastToDevice(roomId, deviceId, "connected", {
      serverInfo: {
        version: config.version,
        hostname: config.hostname || os.hostname(),
      },
      room: { id: room.id, name: room.name },
      files,
      textEntries,
      clipboardEntries,
      devices,
    });

    // Handle client disconnect
    req.on("close", () => {
      sse.removeClient(roomId, deviceId);
      rooms.removeDevice(roomId, deviceId);
      logger.debug({ roomId, deviceId }, "SSE client disconnected");
    });
  });
}

/**
 * Generate a friendly device name from a device ID.
 * @param {string} deviceId
 * @returns {string}
 */
function generateDeviceName(deviceId) {
  const adjectives = [
    "Quick",
    "Brave",
    "Calm",
    "Dark",
    "Eager",
    "Fast",
    "Gentle",
    "Happy",
    "Kind",
    "Loud",
    "Nice",
    "Open",
    "Pure",
    "Quiet",
    "Rapid",
    "Soft",
    "Tender",
    "Vivid",
    "Warm",
    "Yield",
  ];
  const animals = [
    "Fox",
    "Otter",
    "Bear",
    "Wolf",
    "Deer",
    "Hawk",
    "Lynx",
    "Raven",
    "Stag",
    "Swan",
    "Tiger",
    "Viper",
    "Whale",
    "Zebra",
    "Crane",
    "Falcon",
    "Goose",
    "Heron",
    "Ibis",
    "Jay",
    "Kite",
    "Lark",
    "Moth",
    "Newt",
    "Owl",
    "Panda",
    "Quail",
    "Rook",
    "Salmon",
    "Trout",
  ];
  // Use hash of deviceId to pick consistent names
  let hash = 0;
  for (let i = 0; i < deviceId.length; i++) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0;
  }
  const adj = adjectives[hash % adjectives.length];
  const animal = animals[(hash >> 8) % animals.length];
  return `${adj}${animal}`;
}

/**
 * Detect device type from user agent.
 * @param {string} ua
 * @returns {string}
 */
function detectDeviceType(ua) {
  if (!ua) return "desktop";
  const lower = ua.toLowerCase();
  if (lower.includes("mobile") || lower.includes("android") || lower.includes("iphone"))
    return "mobile";
  if (lower.includes("tablet") || lower.includes("ipad")) return "tablet";
  return "desktop";
}

/**
 * Detect device icon from user agent.
 * @param {string} ua
 * @returns {string}
 */
function detectDeviceIcon(ua) {
  const type = detectDeviceType(ua);
  return type === "mobile" ? "phone" : type === "tablet" ? "tablet" : "laptop";
}

/**
 * Hash a device ID to a consistent color.
 * @param {string} id
 * @returns {string} Hex color
 */
function hashColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  // Pick from a palette of nice colors
  // Palette chosen so white 12px initials keep >= 4.5:1 contrast (spec 6.30)
  const colors = [
    "#B91C1C",
    "#9F1239",
    "#9A3412",
    "#854D0E",
    "#A16207",
    "#166534",
    "#0F766E",
    "#155E75",
    "#1E40AF",
    "#1D4ED8",
    "#4338CA",
    "#3730A3",
    "#6D28D9",
    "#7E22CE",
  ];
  return colors[hash % colors.length];
}
