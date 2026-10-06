/**
 * In-memory room state management for LocalShare.
 * @module rooms
 */

import { customAlphabet } from "nanoid";
import { randomUUID } from "node:crypto";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);

/**
 * Room data model:
 * {
 *   id: string,
 *   name: string,
 *   createdAt: ISO8601,
 *   pin: string | null,
 *   lastActivityAt: ISO8601,
 * }
 */

/**
 * Device data model:
 * {
 *   id: string,
 *   name: string,
 *   joinedAt: ISO8601,
 *   lastSeenAt: ISO8601,
 *   userAgent: string,
 *   deviceType: 'desktop'|'mobile'|'tablet',
 *   deviceIcon: 'laptop'|'phone'|'tablet',
 *   color: string,
 * }
 */

/**
 * Transfer data model:
 * {
 *   id: string,
 *   roomId: string,
 *   fileId: string,
 *   sourceDeviceId: string,
 *   sourceDeviceName: string,
 *   targetDeviceId: string,
 *   createdAt: ISO8601,
 *   expiresAt: ISO8601,
 *   status: 'pending'|'accepted'|'declined'|'expired',
 * }
 */

const DEFAULT_ROOM_ID = "default";
const DEFAULT_ROOM_NAME = "Default Room";
const AUTO_DELETE_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const TRANSFER_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Room manager for LocalShare.
 */
export class RoomManager {
  /**
   * @param {import('./storage').Storage} storage
   * @param {import('./sse').SSEManager} sse
   * @param {import('./logger.js').Logger} logger
   * @param {number} maxRooms
   * @param {number} maxFilesPerRoom
   */
  constructor(storage, sse, logger, maxRooms = 20, maxFilesPerRoom = 200) {
    this.storage = storage;
    this.sse = sse;
    this.logger = logger;
    this.maxRooms = maxRooms;
    this.maxFilesPerRoom = maxFilesPerRoom;
    // Map<roomId, Room>
    this.rooms = new Map();
    // Map<roomId, Map<deviceId, Device>>
    this.devices = new Map();
    // Map<roomId, Map<transferId, Transfer>>
    this.transfers = new Map();
    // Cleanup interval
    this._cleanupInterval = null;
    this._startCleanup();
    // Ensure default room exists
    this._ensureDefaultRoom();
  }

  _ensureDefaultRoom() {
    if (!this.rooms.has(DEFAULT_ROOM_ID)) {
      this.rooms.set(DEFAULT_ROOM_ID, this._createRoomObject(DEFAULT_ROOM_ID, DEFAULT_ROOM_NAME));
    }
  }

  /**
   * Create a new room.
   * @param {Object} options
   * @param {string} [options.name]
   * @param {string} [options.pin]
   * @returns {Object} The created room
   */
  createRoom(options = {}) {
    this._ensureDefaultRoom();
    if (this.rooms.size >= this.maxRooms) {
      throw Object.assign(new Error(`Maximum number of rooms (${this.maxRooms}) reached`), {
        code: "ROOM_LIMIT_REACHED",
        status: 409,
      });
    }
    const id = options.id || nanoid();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw Object.assign(new Error("Invalid room id"), { code: "INVALID_BODY", status: 400 });
    }
    if (this.rooms.has(id)) {
      throw Object.assign(new Error(`Room already exists: ${id}`), {
        code: "ROOM_EXISTS",
        status: 409,
      });
    }
    const room = this._createRoomObject(id, options.name || id, options.pin || null);
    this.rooms.set(id, room);
    this.devices.set(id, new Map());
    this.transfers.set(id, new Map());
    this.logger.info({ room: id, name: room.name }, "Room created");
    return room;
  }

  /**
   * Get a room by ID.
   * @param {string} roomId
   * @returns {Object}
   */
  getRoom(roomId) {
    this._ensureDefaultRoom();
    const room = this.rooms.get(roomId);
    if (!room) {
      throw Object.assign(new Error(`Room not found: ${roomId}`), {
        code: "ROOM_NOT_FOUND",
        status: 404,
      });
    }
    return room;
  }

  /**
   * List all rooms (without sensitive data).
   * @returns {Array<Object>}
   */
  listRooms() {
    this._ensureDefaultRoom();
    return Array.from(this.rooms.values()).map((room) => ({
      id: room.id,
      name: room.name,
      fileCount: room.files.size,
      deviceCount: (this.devices.get(room.id) || new Map()).size,
      createdAt: room.createdAt,
    }));
  }

  /**
   * Update a room's name or PIN.
   * @param {string} roomId
   * @param {Object} updates
   * @param {string} [updates.name]
   * @param {string|null} [updates.pin]
   * @returns {Object}
   */
  updateRoom(roomId, updates) {
    const room = this.getRoom(roomId);
    if (updates.name !== undefined) room.name = updates.name;
    if (updates.pin !== undefined) {
      room.pin = updates.pin || null;
    }
    room.lastActivityAt = new Date().toISOString();
    this.rooms.set(roomId, room);
    this.sse.broadcast(roomId, "room:updated", { room: { id: room.id, name: room.name } });
    return room;
  }

  /**
   * Delete a room (cannot delete default).
   *
   * WHY async: spec 6.17 makes DELETE /api/rooms/:roomId delete the room *and
   * all its files*. Deferring the disk sweep to the cleanup job only ever
   * walked the in-memory index, so uploads/<roomId>/ survived the room and the
   * quota was never released.
   *
   * @param {string} roomId
   * @returns {Promise<void>}
   */
  async deleteRoom(roomId) {
    if (roomId === DEFAULT_ROOM_ID) {
      throw Object.assign(new Error("Cannot delete the default room"), {
        code: "CANNOT_DELETE_DEFAULT",
        status: 400,
      });
    }
    const room = this.rooms.get(roomId);
    if (!room) {
      throw Object.assign(new Error(`Room not found: ${roomId}`), {
        code: "ROOM_NOT_FOUND",
        status: 404,
      });
    }
    // Remove all devices
    this.devices.delete(roomId);
    // Remove all transfers
    this.transfers.delete(roomId);
    // WHY: drop the room's text and clipboard state explicitly so the entries
    // are released before the room object itself goes away
    room.textEntries?.clear?.();
    room.textEntries = null;
    room.clipboardEntries = null;
    // WHY: wipe uploads/<roomId>/ recursively and release the quota accounting
    await this.storage.removeRoomDir(roomId);
    // Remove from index
    this.rooms.delete(roomId);
    this.logger.info({ room: roomId }, "Room deleted");
  }

  /**
   * Add a device to a room.
   * @param {string} roomId
   * @param {Object} device
   * @returns {Object}
   */
  addDevice(roomId, device) {
    this._ensureDefaultRoom();
    if (!this.devices.has(roomId)) {
      this.devices.set(roomId, new Map());
    }
    const devMap = this.devices.get(roomId);
    const existing = devMap.get(device.id);
    if (existing) {
      // WHY: this is a reconnect, not a new visit. Keep the original join time
      // so "connected 12m ago" stays truthful and the >30s departure rule in
      // removeDevice() is measured against the real session length.
      device.joinedAt = existing.joinedAt;
      device.sessions = (existing.sessions || 1) + 1;
    } else {
      device.sessions = 1;
    }
    devMap.set(device.id, device);
    // Update room last activity
    const room = this.rooms.get(roomId);
    if (room) room.lastActivityAt = new Date().toISOString();
    // WHY: broadcast reaches the whole room, including the device that just joined
    this.sse.broadcast(roomId, "device:joined", { device });
    return device;
  }

  /**
   * Remove a device from a room (with grace period for reconnects).
   * @param {string} roomId
   * @param {string} deviceId
   */
  removeDevice(roomId, deviceId) {
    const devMap = this.devices.get(roomId);
    if (!devMap || !devMap.has(deviceId)) return;
    const device = devMap.get(deviceId);
    // WHY: 5s grace period to handle brief reconnects
    setTimeout(() => {
      // WHY: the close handler for a superseded socket fires *after* its
      // replacement has already registered, so by the time this grace period
      // expires the device may well be connected again. Evicting it anyway is
      // what makes a healthy device silently disappear from every other
      // screen's device list while it is still connected. Only a device with no
      // live connection left has actually left.
      if (this.sse.hasClient(roomId, deviceId)) {
        this.logger.debug({ roomId, deviceId }, "Device reconnected during grace period");
        return;
      }
      const current = this.devices.get(roomId);
      if (!current || !current.has(deviceId)) return;
      current.delete(deviceId);
      // Check if device was present for > 30s before showing leave toast
      const joinedAt = new Date(device.joinedAt).getTime();
      const elapsed = Date.now() - joinedAt;
      if (elapsed > 30000) {
        this.sse.broadcast(roomId, "device:left", { deviceId, name: device.name });
      }
      this.logger.debug({ roomId, deviceId, elapsed }, "Device removed from room");
    }, 5000);
  }

  /**
   * Get all devices in a room.
   * @param {string} roomId
   * @returns {Object[]}
   */
  getDevices(roomId) {
    return Array.from((this.devices.get(roomId) || new Map()).values());
  }

  /**
   * Update a device's name.
   * @param {string} roomId
   * @param {string} deviceId
   * @param {string} newName
   * @returns {Object|null}
   */
  updateDevice(roomId, deviceId, newName) {
    const devMap = this.devices.get(roomId);
    if (!devMap || !devMap.has(deviceId)) return null;
    const device = devMap.get(deviceId);
    device.name = newName;
    device.lastSeenAt = new Date().toISOString();
    this.sse.broadcast(roomId, "device:joined", { device });
    return device;
  }

  /**
   * Create a pending transfer.
   * @param {string} roomId
   * @param {Object} transfer
   * @returns {Object}
   */
  createTransfer(roomId, transfer) {
    this._ensureDefaultRoom();
    if (!this.transfers.has(roomId)) {
      this.transfers.set(roomId, new Map());
    }
    const transferId = randomUUID().slice(0, 10);
    const entry = {
      id: transferId,
      roomId,
      fileId: transfer.fileId,
      // WHY denormalised: the receiving modal must name the file and its size
      // (spec 6.19), and it renders purely from the SSE payload -- there is no
      // room to look the metadata up on the target device.
      originalName: transfer.originalName ?? null,
      size: transfer.size ?? null,
      mimeType: transfer.mimeType ?? null,
      sourceDeviceId: transfer.sourceDeviceId,
      sourceDeviceName: transfer.sourceDeviceName,
      targetDeviceId: transfer.targetDeviceId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TRANSFER_TTL_MS).toISOString(),
      status: "pending",
    };
    this.transfers.get(roomId).set(transferId, entry);
    // Send to target device
    this.sse.broadcastToDevice(roomId, transfer.targetDeviceId, "transfer:incoming", {
      transfer: entry,
    });
    // Schedule auto-expiry
    setTimeout(() => this._expireTransfer(roomId, transferId), TRANSFER_TTL_MS);
    return entry;
  }

  /**
   * Handle transfer accept/decline.
   * @param {string} roomId
   * @param {string} transferId
   * @param {string} action - 'accept' | 'decline'
   * @param {string} [actorDeviceId] - The device answering. When supplied it
   *   must be the transfer's target: a transfer is a private offer, and
   *   without this check any device in the room could decline it and rob the
   *   intended recipient of the file.
   * @returns {Object}
   */
  handleTransfer(roomId, transferId, action, actorDeviceId) {
    const transferMap = this.transfers.get(roomId);
    if (!transferMap || !transferMap.has(transferId)) {
      throw Object.assign(new Error("Transfer not found"), {
        code: "TRANSFER_NOT_FOUND",
        status: 404,
      });
    }
    const transfer = transferMap.get(transferId);
    if (transfer.status !== "pending") {
      throw Object.assign(new Error("Transfer already handled or expired"), {
        code: "TRANSFER_EXPIRED",
        status: 410,
      });
    }
    if (actorDeviceId && actorDeviceId !== transfer.targetDeviceId) {
      throw Object.assign(new Error("Access denied"), {
        code: "FORBIDDEN",
        status: 403,
      });
    }
    // WHY: keep the entry in the map so the target can still download it
    // until the TTL sweep removes it
    transfer.status = action === "accept" ? "accepted" : "declined";
    transfer.handledAt = new Date().toISOString();
    const eventType = action === "accept" ? "transfer:accepted" : "transfer:declined";
    this.sse.broadcastToDevice(roomId, transfer.sourceDeviceId, eventType, { transferId });
    // WHY no deletion here: spec 6.19 says a declined transfer is "deleted",
    // but that refers to the copy the server stages in its temporary
    // "pending transfers" area. This implementation never stages one - the
    // client sends a file that is already in the room's shared pool - so
    // `transfer.fileId` is the sender's real, pooled file. Deleting it here
    // destroyed the original for every device in the room: declining an offer
    // to receive a file silently wiped it out of existence.
    return transfer;
  }

  /**
   * Expire a transfer.
   * @param {string} roomId
   * @param {string} transferId
   */
  _expireTransfer(roomId, transferId) {
    const transferMap = this.transfers.get(roomId);
    if (!transferMap || !transferMap.has(transferId)) return;
    const transfer = transferMap.get(transferId);
    if (transfer.status === "pending") {
      transfer.status = "expired";
      this.sse.broadcastToDevice(roomId, transfer.sourceDeviceId, "transfer:expired", {
        transferId,
      });
      // WHY no deletion here, same as on decline: `transfer.fileId` is a file
      // already in the room's shared pool, not a staged copy. This timer fires
      // whenever a recipient simply does not answer within 60s - walk away,
      // lock the phone, lose connection - and deleting here made the sender's
      // file vanish from the room for everyone. Expiring an offer must cost
      // the recipient nothing and the sender nothing.
    }
    transferMap.delete(transferId);
  }

  /**
   * Get a transfer by ID.
   * @param {string} roomId
   * @param {string} transferId
   * @returns {Object|null}
   */
  getTransfer(roomId, transferId) {
    return this.transfers.get(roomId)?.get(transferId) || null;
  }

  /**
   * Check if a room needs auto-deletion (idle custom room).
   * Called by the cleanup job.
   * @param {string} roomId
   * @returns {boolean}
   */
  shouldAutoDelete(roomId) {
    if (roomId === DEFAULT_ROOM_ID) return false;
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const deviceCount = (this.devices.get(roomId) || new Map()).size;
    const fileCount = room.files.size;
    // WHY spec 6.17: a room is auto-deleted only when files AND text entries
    // AND devices are all zero. Ignoring text/clipboard reaped rooms that
    // still held live content.
    const textCount = room.textEntries?.size || 0;
    const clipboardCount = room.clipboardEntries?.length || 0;
    // Auto-delete if idle (no devices, no files, no text, no clipboard) for 30 minutes
    if (deviceCount === 0 && fileCount === 0 && textCount === 0 && clipboardCount === 0) {
      const idleTime = Date.now() - new Date(room.lastActivityAt).getTime();
      return idleTime > AUTO_DELETE_IDLE_MS;
    }
    return false;
  }

  /**
   * Start the auto-cleanup interval.
   */
  _startCleanup() {
    // WHY: the sweep is async now (deleting a room removes its files), so the
    // timer callback swallows its own rejection instead of leaking one.
    this._cleanupInterval = setInterval(() => {
      this._runCleanup().catch((err) => {
        this.logger.warn({ error: err.message }, "Room cleanup sweep failed");
      });
    }, 60000);
  }

  /**
   * Run the auto-cleanup sweep.
   * @returns {Promise<void>}
   */
  async _runCleanup() {
    for (const roomId of this.rooms.keys()) {
      if (!this.shouldAutoDelete(roomId)) continue;
      try {
        this.logger.info({ room: roomId }, "Auto-deleting idle room");
        await this.deleteRoom(roomId);
      } catch (err) {
        // WHY: one undeletable room must not abort the whole sweep
        this.logger.warn({ room: roomId, error: err.message }, "Failed to auto-delete room");
      }
    }
  }

  /**
   * Stop the cleanup interval.
   */
  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  // --- Private ---

  _createRoomObject(id, name, pin = null) {
    return {
      id,
      name,
      pin,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      files: new Map(),
    };
  }
}
