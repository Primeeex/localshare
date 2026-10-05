/**
 * Presence regression tests (P1).
 *
 * These lock in the behaviour of the device-lifecycle fixes: a device that
 * reconnects inside the grace period must survive it, a device that really
 * left must be evicted, a reconnect must not reset its join time, and the
 * connection cap must be enforced server-wide rather than per room.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/app.js";
import { connectSSE } from "../helpers/sseClient.js";

/** Comfortably past the 5s grace period implemented by RoomManager.removeDevice(). */
const PAST_GRACE_MS = 6000;

describe("presence", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await harness.destroy();
  });

  describe("grace period", () => {
    it("keeps a device that disconnects and reconnects within 5s", async () => {
      const { url } = await harness.listen();

      const first = connectSSE(url, { roomId: "default", deviceId: "dev-1" });
      await first.waitFor("connected", 5000);
      expect(harness.rooms.getDevices("default").map((d) => d.id)).toEqual(["dev-1"]);

      // Drop the socket without waiting, then come straight back
      first.req.destroy();
      const second = connectSSE(url, { roomId: "default", deviceId: "dev-1" });
      await second.waitFor("connected", 5000);

      try {
        // WHY: wait past the whole grace period, otherwise this proves nothing
        await new Promise((resolve) => setTimeout(resolve, PAST_GRACE_MS));
        const ids = harness.rooms.getDevices("default").map((d) => d.id);
        expect(ids).toContain("dev-1");
        expect(harness.sse.hasClient("default", "dev-1")).toBe(true);
      } finally {
        second.close();
      }
    });

    it("removes a device that disconnects without reconnecting", async () => {
      const { url } = await harness.listen();

      const client = connectSSE(url, { roomId: "default", deviceId: "dev-2" });
      await client.waitFor("connected", 5000);
      expect(harness.rooms.getDevices("default")).toHaveLength(1);

      client.close();
      await new Promise((resolve) => setTimeout(resolve, 250));

      await new Promise((resolve) => setTimeout(resolve, PAST_GRACE_MS));

      expect(harness.rooms.getDevices("default")).toHaveLength(0);
      expect(harness.sse.hasClient("default", "dev-2")).toBe(false);
    });

    it("does not evict a device whose replacement socket already registered", async () => {
      // WHY: the superseded socket's close handler fires *after* the new one
      // connected, so the grace period must consult sse.hasClient()
      const { url } = await harness.listen();

      const first = connectSSE(url, { roomId: "default", deviceId: "dev-3" });
      await first.waitFor("connected", 5000);

      const second = connectSSE(url, { roomId: "default", deviceId: "dev-3" });
      await second.waitFor("connected", 5000);
      first.close();

      try {
        await new Promise((resolve) => setTimeout(resolve, PAST_GRACE_MS));
        expect(harness.sse.hasClient("default", "dev-3")).toBe(true);
        expect(harness.rooms.getDevices("default").map((d) => d.id)).toEqual(["dev-3"]);
      } finally {
        second.close();
      }
    });
  });

  describe("reconnect bookkeeping", () => {
    it("preserves joinedAt and increments sessions across a reconnect", () => {
      const first = harness.rooms.addDevice("default", {
        id: "dev-4",
        name: "Laptop",
        joinedAt: new Date().toISOString(),
      });
      const originalJoinedAt = first.joinedAt;

      // Simulate a second visit later
      const later = new Date(new Date(originalJoinedAt).getTime() + 60000).toISOString();
      const second = harness.rooms.addDevice("default", {
        id: "dev-4",
        name: "Laptop",
        joinedAt: later,
      });

      expect(second.joinedAt).toBe(originalJoinedAt);
      expect(second.sessions).toBe(2);
      // WHY: the room keeps exactly one entry per device
      expect(harness.rooms.getDevices("default")).toHaveLength(1);
    });

    it("counts sessions up across three visits", () => {
      const base = new Date().toISOString();
      harness.rooms.addDevice("default", { id: "dev-5", name: "Phone", joinedAt: base });
      harness.rooms.addDevice("default", { id: "dev-5", name: "Phone", joinedAt: base });
      const third = harness.rooms.addDevice("default", {
        id: "dev-5",
        name: "Phone",
        joinedAt: base,
      });

      expect(third.sessions).toBe(3);
      expect(third.joinedAt).toBe(base);
    });

    it("gives a brand new device sessions = 1", () => {
      const device = harness.rooms.addDevice("default", {
        id: "dev-6",
        name: "Tablet",
        joinedAt: new Date().toISOString(),
      });
      expect(device.sessions).toBe(1);
    });
  });

  describe("overlapping connections", () => {
    it("reports hasClient() true while two sockets share one deviceId", async () => {
      const { url } = await harness.listen();

      const a = connectSSE(url, { roomId: "default", deviceId: "dev-7" });
      await a.waitFor("connected", 5000);
      expect(harness.sse.hasClient("default", "dev-7")).toBe(true);

      const b = connectSSE(url, { roomId: "default", deviceId: "dev-7" });
      await b.waitFor("connected", 5000);

      try {
        expect(harness.sse.hasClient("default", "dev-7")).toBe(true);
        // WHY: the device count is per deviceId, not per socket
        expect(harness.rooms.getDevices("default")).toHaveLength(1);
        // ...but both sockets are counted against the server-wide cap
        expect(harness.sse.getTotalClientCount()).toBe(2);
      } finally {
        a.close();
        b.close();
      }
    });

    it("keeps the remaining socket alive when one duplicate is closed", async () => {
      const { url } = await harness.listen();

      const a = connectSSE(url, { roomId: "default", deviceId: "dev-8" });
      await a.waitFor("connected", 5000);
      const b = connectSSE(url, { roomId: "default", deviceId: "dev-8" });
      await b.waitFor("connected", 5000);

      a.close();
      await new Promise((resolve) => setTimeout(resolve, 300));

      try {
        expect(harness.sse.hasClient("default", "dev-8")).toBe(true);
        expect(harness.sse.getTotalClientCount()).toBe(1);
      } finally {
        b.close();
      }
    });
  });

  describe("server-wide connection cap", () => {
    it("counts clients across every room", async () => {
      const { url } = await harness.listen();
      // Create the room with the exact id the client will connect to. The
      // endpoint no longer auto-creates unknown rooms, because an
      // unauthenticated GET /events must not be a room-creation primitive.
      harness.rooms.createRoom({ id: "second", name: "Second" });

      const a = connectSSE(url, { roomId: "default", deviceId: "dev-9" });
      await a.waitFor("connected", 5000);
      const b = connectSSE(url, { roomId: "second", deviceId: "dev-10" });
      await b.waitFor("connected", 5000);

      try {
        expect(harness.sse.getTotalClientCount()).toBe(2);
        expect(harness.sse.getClientCount("default")).toBe(1);
        expect(harness.sse.getClientCount("second")).toBe(1);
      } finally {
        a.close();
        b.close();
      }
    });

    it("refuses new connections with 503 and Retry-After once the cap is hit", async () => {
      // WHY: a cap of 2 makes the third connection deterministic to test
      const small = await createTestApp({ maxConnections: 2 });
      try {
        const { url } = await small.listen();

        const a = connectSSE(url, { roomId: "default", deviceId: "dev-a" });
        await a.waitFor("connected", 5000);
        const b = connectSSE(url, { roomId: "default", deviceId: "dev-b" });
        await b.waitFor("connected", 5000);
        expect(small.sse.getTotalClientCount()).toBe(2);

        const c = connectSSE(url, { roomId: "default", deviceId: "dev-c" });
        try {
          const status = await c.waitForResponse();
          expect(status).toBe(503);
          expect(c.headers["retry-after"]).toBe("30");
          // WHY: the rejected client must not consume a slot
          expect(small.sse.getTotalClientCount()).toBe(2);
        } finally {
          c.close();
        }
      } finally {
        await small.destroy();
      }
    });

    it("releases the slot again after a client disconnects", async () => {
      const small = await createTestApp({ maxConnections: 1 });
      try {
        const { url } = await small.listen();

        const a = connectSSE(url, { roomId: "default", deviceId: "dev-a" });
        await a.waitFor("connected", 5000);

        const blocked = connectSSE(url, { roomId: "default", deviceId: "dev-b" });
        expect(await blocked.waitForResponse()).toBe(503);
        blocked.close();

        a.close();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(small.sse.getTotalClientCount()).toBe(0);

        const c = connectSSE(url, { roomId: "default", deviceId: "dev-c" });
        try {
          expect(await c.waitForResponse()).toBe(200);
        } finally {
          c.close();
        }
      } finally {
        await small.destroy();
      }
    });
  });

  describe("device list API", () => {
    it("reports a connected device over the API", async () => {
      const { url } = await harness.listen();
      const client = connectSSE(url, { roomId: "default", deviceId: "dev-11" });
      try {
        await client.waitFor("connected", 5000);
        const res = await request(harness.app).get("/api/rooms/default/devices").expect(200);
        expect(res.body.map((d) => d.id)).toContain("dev-11");
        expect(res.body[0]).toMatchObject({ sessions: 1 });
      } finally {
        client.close();
      }
    });
  });
});
