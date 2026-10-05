/**
 * SSE events endpoint.
 * @module routes/events
 */

import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";
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

    // WHY the HEAD probe: the client cannot read a status code off EventSource,
    // so it sends a short HEAD request to tell a 401 (room PIN) apart from a
    // network drop. It must NOT fall through to addClient() below, which would
    // register a phantom device and hold the response open as a live stream.
    if (req.method === "HEAD") {
      res.status(204).end();
      return;
    }

    // Get the room. Spec 12 requires getRoom('nonexistent') to throw
    // ROOM_NOT_FOUND and the client to show "Room not found" and fall back to
    // the default room.
    //
    // WHY this no longer auto-creates: an unauthenticated GET /events is a
    // write primitive. Auto-creating on connect let ~19 requests fill the room
    // table permanently, after which POST /api/rooms returned
    // 409 ROOM_LIMIT_REACHED forever. The empty-room reaper could not reclaim
    // them either, because each spam room still held its own SSE client.
    let room;
    try {
      room = rooms.getRoom(roomId);
    } catch {
      const err = new AppError("Room not found", "ROOM_NOT_FOUND", 404, { roomId });
      res.status(404).json({
        error: {
          code: err.code,
          message: err.message,
          requestId: req.id,
          timestamp: new Date().toISOString(),
        },
      });
      return;
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
    // WHY: a socket error fires before or alongside 'close'. Without this
    // listener an aborted mobile connection raises an unhandled error and
    // leaves the response never torn down.
    res.on("error", () => {
      sse.removeClient(roomId, deviceId, res);
      rooms.removeDevice(roomId, deviceId);
      logger.debug({ roomId, deviceId }, "SSE client errored");
    });

    req.on("close", () => {
      // WHY: 'close' can fire for a socket that has already been superseded by
      // a reconnecting one, so the room re-checks for a live connection after
      // its grace period before evicting the device.
      sse.removeClient(roomId, deviceId, res);
      rooms.removeDevice(roomId, deviceId);
      logger.debug({ roomId, deviceId }, "SSE client disconnected");
    });
  });
}

/**
 * Adjectives used by {@link generateDeviceName}.
 * Spec 6.18 requires 50+ adjectives x 50+ animals = 2500+ combinations.
 */
const DEVICE_ADJECTIVES = [
  "Agile",
  "Amber",
  "Brave",
  "Bright",
  "Calm",
  "Clever",
  "Crimson",
  "Curious",
  "Dark",
  "Eager",
  "Electric",
  "Fearless",
  "Fleet",
  "Gentle",
  "Golden",
  "Happy",
  "Jolly",
  "Keen",
  "Kind",
  "Lucky",
  "Lunar",
  "Merry",
  "Nimble",
  "Noble",
  "Open",
  "Peaceful",
  "Plucky",
  "Proud",
  "Pure",
  "Quick",
  "Quiet",
  "Rapid",
  "Royal",
  "Scarlet",
  "Silent",
  "Silver",
  "Smooth",
  "Soft",
  "Solar",
  "Sturdy",
  "Swift",
  "Tender",
  "True",
  "Vivid",
  "Warm",
  "Witty",
  "Wise",
  "Yield",
  "Zesty",
  "Zen",
];

/**
 * Animals used by {@link generateDeviceName}. See {@link DEVICE_ADJECTIVES}.
 */
const DEVICE_ANIMALS = [
  "Alpaca",
  "Badger",
  "Bear",
  "Beaver",
  "Bison",
  "Camel",
  "Capybara",
  "Chamois",
  "Cobra",
  "Crane",
  "Deer",
  "Dingo",
  "Eagle",
  "Falcon",
  "Ferret",
  "Finch",
  "Fox",
  "Gecko",
  "Giraffe",
  "Goose",
  "Hawk",
  "Heron",
  "Ibex",
  "Ibis",
  "Jaguar",
  "Jay",
  "Kite",
  "Koala",
  "Lark",
  "Llama",
  "Lynx",
  "Manatee",
  "Marmot",
  "Meerkat",
  "Mole",
  "Moth",
  "Newt",
  "Otter",
  "Owl",
  "Panda",
  "Pelican",
  "Quail",
  "Rabbit",
  "Raven",
  "Rook",
  "Salmon",
  "Seal",
  "Stag",
  "Swan",
  "Tapir",
  "Tiger",
  "Viper",
  "Walrus",
  "Whale",
  "Wolf",
  "Wombat",
  "Yak",
  "Zebra",
];

/**
 * Generate a friendly device name from a device ID.
 *
 * WHY hash-based: the same deviceId must always resolve to the same name so
 * a device keeps its identity (and avatar colour) across sessions and rooms.
 *
 * @param {string} deviceId
 * @returns {string}
 */
function generateDeviceName(deviceId) {
  // Use hash of deviceId to pick consistent names
  let hash = 0;
  for (let i = 0; i < deviceId.length; i++) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0;
  }
  const adj = DEVICE_ADJECTIVES[hash % DEVICE_ADJECTIVES.length];
  const animal = DEVICE_ANIMALS[(hash >> 8) % DEVICE_ANIMALS.length];
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
