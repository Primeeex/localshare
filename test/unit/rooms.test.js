/**
 * Unit tests for room management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RoomManager } from "../../src/rooms.js";
import { Storage } from "../../src/storage.js";
import { SSEManager } from "../../src/sse.js";
import { createLogger } from "../../src/logger.js";
import { testConfig } from "../helpers/app.js";

/**
 * Run a function and return the thrown error for structured assertions.
 */
function catchErr(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("Expected function to throw, but it did not");
}

describe("rooms", () => {
  let rooms;
  let storage;
  let sse;
  let logger;

  beforeEach(() => {
    const config = testConfig();
    logger = createLogger(config);
    storage = new Storage(config.dir, config.maxFileSize, config.maxStorage);
    sse = new SSEManager(logger, config.maxConnections);
    rooms = new RoomManager(storage, sse, logger, 5, 100);
  });

  afterEach(() => {
    rooms.stop();
    vi.useRealTimers();
  });

  describe("createRoom", () => {
    it("creates a room with default values", () => {
      const room = rooms.createRoom();
      expect(room.id).toMatch(/^[a-z0-9]{8}$/);
      expect(room.name).toBe(room.id);
      expect(room.pin).toBeNull();
      expect(room.createdAt).toBeTruthy();
      expect(room.lastActivityAt).toBeTruthy();
    });

    it("uses the provided name and pin", () => {
      const room = rooms.createRoom({ name: "Team", pin: "1234" });
      expect(room.name).toBe("Team");
      expect(room.pin).toBe("1234");
      expect(rooms.getRoom(room.id).name).toBe("Team");
    });

    it("lists rooms without the pin", () => {
      rooms.createRoom({ name: "Secret", pin: "9999" });
      const listed = rooms.listRooms();
      const found = listed.find((r) => r.name === "Secret");
      expect(found).toBeTruthy();
      expect(found.pin).toBeUndefined();
      expect(found).toHaveProperty("id");
      expect(found).toHaveProperty("fileCount");
      expect(found).toHaveProperty("deviceCount");
    });

    it("enforces the room limit", () => {
      for (let i = 0; i < 4; i++) rooms.createRoom();
      // default + 4 custom = 5 = maxRooms
      expect(() => rooms.createRoom()).toThrow();
      expect(catchErr(() => rooms.createRoom())).toMatchObject({
        code: "ROOM_LIMIT_REACHED",
        status: 409,
      });
    });
  });

  describe("getRoom", () => {
    it("always returns the default room", () => {
      const room = rooms.getRoom("default");
      expect(room.id).toBe("default");
      expect(room.name).toBe("Default Room");
    });

    it("throws ROOM_NOT_FOUND for a missing room", () => {
      expect(() => rooms.getRoom("nonexistent")).toThrow();
      expect(catchErr(() => rooms.getRoom("nonexistent"))).toMatchObject({
        code: "ROOM_NOT_FOUND",
        status: 404,
      });
    });
  });

  describe("deleteRoom", () => {
    it("refuses to delete the default room", () => {
      expect(() => rooms.deleteRoom("default")).toThrow();
      expect(catchErr(() => rooms.deleteRoom("default"))).toMatchObject({
        code: "CANNOT_DELETE_DEFAULT",
        status: 400,
      });
    });

    it("throws ROOM_NOT_FOUND for a missing room", () => {
      expect(() => rooms.deleteRoom("nonexistent")).toThrow();
      expect(catchErr(() => rooms.deleteRoom("nonexistent"))).toMatchObject({
        code: "ROOM_NOT_FOUND",
      });
    });

    it("deletes a custom room", () => {
      const room = rooms.createRoom({ name: "Temp" });
      rooms.deleteRoom(room.id);
      expect(() => rooms.getRoom(room.id)).toThrow();
      expect(catchErr(() => rooms.getRoom(room.id))).toMatchObject({ code: "ROOM_NOT_FOUND" });
    });
  });

  describe("auto-delete", () => {
    it("never flags the default room", () => {
      rooms.getRoom("default");
      expect(rooms.shouldAutoDelete("default")).toBe(false);
    });

    it("flags an idle custom room after 30 minutes", () => {
      const room = rooms.createRoom({ name: "Idle" });
      room.lastActivityAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      expect(rooms.shouldAutoDelete(room.id)).toBe(true);
    });

    it("does not flag a recently active room", () => {
      const room = rooms.createRoom({ name: "Fresh" });
      room.lastActivityAt = new Date(Date.now() - 60 * 1000).toISOString();
      expect(rooms.shouldAutoDelete(room.id)).toBe(false);
    });

    it("does not flag a room with connected devices", () => {
      const room = rooms.createRoom({ name: "Busy" });
      room.lastActivityAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      rooms.addDevice(room.id, { id: "dev1", name: "Laptop", joinedAt: new Date().toISOString() });
      expect(rooms.shouldAutoDelete(room.id)).toBe(false);
    });
  });

  describe("devices", () => {
    it("adds and lists devices", () => {
      rooms.addDevice("default", { id: "a", name: "Phone", joinedAt: new Date().toISOString() });
      rooms.addDevice("default", { id: "b", name: "Laptop", joinedAt: new Date().toISOString() });
      expect(
        rooms
          .getDevices("default")
          .map((d) => d.id)
          .sort()
      ).toEqual(["a", "b"]);
    });

    it("updates a device name", () => {
      rooms.addDevice("default", { id: "a", name: "Old", joinedAt: new Date().toISOString() });
      const updated = rooms.updateDevice("default", "a", "New");
      expect(updated.name).toBe("New");
      expect(rooms.updateDevice("default", "missing", "X")).toBeNull();
    });

    it("removes a device after the grace period", () => {
      vi.useFakeTimers();
      rooms.addDevice("default", { id: "a", name: "Phone", joinedAt: new Date().toISOString() });
      rooms.removeDevice("default", "a");
      // Still present during the grace window
      expect(rooms.getDevices("default")).toHaveLength(1);
      vi.advanceTimersByTime(5100);
      expect(rooms.getDevices("default")).toHaveLength(0);
    });
  });

  describe("transfers", () => {
    it("creates a pending transfer with a 60s TTL", () => {
      const transfer = rooms.createTransfer("default", {
        fileId: "f1",
        sourceDeviceId: "src",
        sourceDeviceName: "Mac",
        targetDeviceId: "tgt",
      });
      expect(transfer.status).toBe("pending");
      expect(transfer.id).toBeTruthy();
      const ttl = new Date(transfer.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(50000);
      expect(ttl).toBeLessThanOrEqual(61000);
      expect(rooms.getTransfer("default", transfer.id)).toBeTruthy();
    });

    it("accepts a pending transfer and keeps it downloadable", () => {
      const transfer = rooms.createTransfer("default", {
        fileId: "f1",
        sourceDeviceId: "src",
        sourceDeviceName: "Mac",
        targetDeviceId: "tgt",
      });
      const handled = rooms.handleTransfer("default", transfer.id, "accept");
      expect(handled.status).toBe("accepted");
      expect(rooms.getTransfer("default", transfer.id).status).toBe("accepted");
    });

    it("declines a pending transfer", () => {
      const transfer = rooms.createTransfer("default", {
        fileId: "f1",
        sourceDeviceId: "src",
        sourceDeviceName: "Mac",
        targetDeviceId: "tgt",
      });
      const handled = rooms.handleTransfer("default", transfer.id, "decline");
      expect(handled.status).toBe("declined");
    });

    it("rejects handling a transfer twice", () => {
      const transfer = rooms.createTransfer("default", {
        fileId: "f1",
        sourceDeviceId: "src",
        sourceDeviceName: "Mac",
        targetDeviceId: "tgt",
      });
      rooms.handleTransfer("default", transfer.id, "accept");
      expect(() => rooms.handleTransfer("default", transfer.id, "accept")).toThrow();
      expect(catchErr(() => rooms.handleTransfer("default", transfer.id, "accept"))).toMatchObject({
        code: "TRANSFER_EXPIRED",
        status: 410,
      });
    });

    it("throws TRANSFER_NOT_FOUND for an unknown transfer", () => {
      expect(() => rooms.handleTransfer("default", "missing", "accept")).toThrow();
      expect(catchErr(() => rooms.handleTransfer("default", "missing", "accept"))).toMatchObject({
        code: "TRANSFER_NOT_FOUND",
        status: 404,
      });
    });

    it("expires a pending transfer after the TTL", () => {
      vi.useFakeTimers();
      const transfer = rooms.createTransfer("default", {
        fileId: "f1",
        sourceDeviceId: "src",
        sourceDeviceName: "Mac",
        targetDeviceId: "tgt",
      });
      vi.advanceTimersByTime(61000);
      expect(rooms.getTransfer("default", transfer.id)).toBeNull();
    });
  });

  describe("updateRoom", () => {
    it("renames a room", () => {
      const room = rooms.createRoom({ name: "Old" });
      const updated = rooms.updateRoom(room.id, { name: "New" });
      expect(updated.name).toBe("New");
    });

    it("throws ROOM_NOT_FOUND for a missing room", () => {
      expect(() => rooms.updateRoom("nope", { name: "x" })).toThrow();
      expect(catchErr(() => rooms.updateRoom("nope", { name: "x" }))).toMatchObject({
        code: "ROOM_NOT_FOUND",
      });
    });
  });
});
