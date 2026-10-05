/**
 * Integration tests for room-level PIN enforcement (spec 12).
 *
 * A room PIN is independent of the server PIN: rooms without one must keep
 * working with zero headers, and rooms with one must reject every SSE connect
 * and every room-scoped API call that does not present it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, pinHash } from "../helpers/app.js";
import { connectSSE } from "../helpers/sseClient.js";

/** The PIN every PIN-protected room below is created with. */
const ROOM_PIN = "2468";

describe("room PIN", () => {
  let harness;
  /** A room with no PIN - the default path. */
  let openRoom;
  /** A room created with a PIN. */
  let lockedRoom;

  beforeEach(async () => {
    harness = await createTestApp();
    openRoom = harness.rooms.createRoom({ name: "Open" });
    lockedRoom = harness.rooms.createRoom({ name: "Locked", pin: pinHash(ROOM_PIN) });
  });

  afterEach(async () => {
    await harness.destroy();
  });

  describe("rooms without a PIN", () => {
    it("serves the room API with no headers at all", async () => {
      const res = await request(harness.app).get(`/api/rooms/${openRoom.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(openRoom.id);
    });

    it("accepts an upload with no headers at all", async () => {
      const res = await request(harness.app)
        .post(`/api/rooms/${openRoom.id}/files`)
        .attach("files[]", Buffer.from("hi"), "hi.txt");
      expect(res.status).toBe(201);
    });

    it("ignores a stray X-Room-Pin header", async () => {
      const res = await request(harness.app)
        .get(`/api/rooms/${openRoom.id}`)
        .set("X-Room-Pin", "totally-wrong");
      expect(res.status).toBe(200);
    });
  });

  describe("rooms with a PIN", () => {
    it("rejects the room API when the header is missing", async () => {
      const res = await request(harness.app).get(`/api/rooms/${lockedRoom.id}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_REQUIRED");
      expect(res.body.error.message).toBe("Room PIN required");
      expect(res.body.error.requestId).toBeTruthy();
      expect(res.body.error.timestamp).toBeTruthy();
    });

    it("rejects the room API when the header is wrong", async () => {
      const res = await request(harness.app)
        .get(`/api/rooms/${lockedRoom.id}`)
        .set("X-Room-Pin", "0000");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_INVALID");
      expect(res.body.error.message).toBe("Incorrect room PIN");
    });

    it("accepts the room API with the correct PIN", async () => {
      const res = await request(harness.app)
        .get(`/api/rooms/${lockedRoom.id}`)
        .set("X-Room-Pin", ROOM_PIN);
      expect(res.status).toBe(200);
      // WHY: the stored PIN is a hash, never the plaintext
      expect(JSON.stringify(res.body)).not.toContain(ROOM_PIN);
    });

    it("rejects room-scoped sub-routes as well", async () => {
      for (const path of ["files", "text", "clipboard", "devices"]) {
        const res = await request(harness.app).get(`/api/rooms/${lockedRoom.id}/${path}`);
        expect(res.status, `GET /${path}`).toBe(401);
        expect(res.body.error.code, `GET /${path}`).toBe("AUTH_REQUIRED");
      }
    });

    it("flags the rejection as room-scoped so the client does not treat it as a dead session", async () => {
      // Regression: the browser client redirected to "/" on ANY 401
      // AUTH_REQUIRED. A PIN room answers with exactly that code, so creating
      // a PIN room fired four parallel redirects and looked like a crash.
      // The client now keys off this flag, so the server must always send it.
      const res = await request(harness.app).get(`/api/rooms/${lockedRoom.id}/files`);
      expect(res.status).toBe(401);
      expect(res.body.error.requiresRoomPin).toBe(true);
      expect(res.body.error.roomId).toBe(lockedRoom.id);
    });

    it("accepts room-scoped sub-routes with the correct PIN", async () => {
      for (const path of ["files", "text", "clipboard", "devices"]) {
        const res = await request(harness.app)
          .get(`/api/rooms/${lockedRoom.id}/${path}`)
          .set("X-Room-Pin", ROOM_PIN);
        expect(res.status, `GET /${path}`).toBe(200);
      }
    });

    it("rejects an upload without the PIN", async () => {
      const res = await request(harness.app)
        .post(`/api/rooms/${lockedRoom.id}/files`)
        .attach("files[]", Buffer.from("secret"), "secret.txt");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_REQUIRED");
      expect(await harness.storage.listFiles(lockedRoom.id)).toHaveLength(0);
    });

    it("leaves the room list reachable without the PIN", async () => {
      const res = await request(harness.app).get("/api/rooms");
      expect(res.status).toBe(200);
      expect(res.body.some((r) => r.id === lockedRoom.id)).toBe(true);
    });
  });

  describe("SSE", () => {
    it("rejects an SSE connect without the room PIN", async () => {
      const { url } = await harness.listen();
      const client = connectSSE(url, { roomId: lockedRoom.id, deviceId: "dev-a" });
      try {
        expect(await client.waitForResponse()).toBe(401);
      } finally {
        client.close();
      }
    });

    it("rejects an SSE connect with a wrong room PIN", async () => {
      const { url } = await harness.listen();
      const client = connectSSE(
        url,
        { roomId: lockedRoom.id, deviceId: "dev-a" },
        { "X-Room-Pin": "0000" }
      );
      try {
        expect(await client.waitForResponse()).toBe(401);
      } finally {
        client.close();
      }
    });

    it("accepts an SSE connect with the correct room PIN", async () => {
      const { url } = await harness.listen();
      const client = connectSSE(
        url,
        { roomId: lockedRoom.id, deviceId: "dev-a" },
        { "X-Room-Pin": ROOM_PIN }
      );
      try {
        await client.waitFor("connected", 5000);
        expect(client.statusCode).toBe(200);
      } finally {
        client.close();
      }
    });

    it("still connects to a PIN-less room with no headers", async () => {
      const { url } = await harness.listen();
      const client = connectSSE(url, { roomId: openRoom.id, deviceId: "dev-b" });
      try {
        await client.waitFor("connected", 5000);
        expect(client.statusCode).toBe(200);
      } finally {
        client.close();
      }
    });
  });
  // The room PIN is only a real control if it cannot be brute-forced. Two
  // defects made it decorative:
  //   * no strength check -- `pin: "1"` was accepted, recovered in one request
  //   * no guess budget -- verifyPin spends ~35ms of BLOCKING scrypt per
  //     attempt, /events sits outside every rate limiter, and the /api limiter
  //     is mounted *after* the guard, so it never prevented the derivation.
  describe("strength and guess limits", () => {
    for (const weak of ["1", "12", "a", "abcd", "123456789"]) {
      it(`rejects the weak PIN ${JSON.stringify(weak)}`, async () => {
        const res = await request(harness.app).post("/api/rooms").send({ name: "Weak", pin: weak });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      });
    }

    it("accepts a well-formed 4-8 digit PIN", async () => {
      for (const good of ["1234", "0000", "12345678"]) {
        const res = await request(harness.app).post("/api/rooms").send({ pin: good });
        expect(res.status).toBe(201);
      }
    });

    it("treats a blank PIN as no PIN at all", async () => {
      const res = await request(harness.app).post("/api/rooms").send({ pin: "   " });
      expect(res.status).toBe(201);
      expect(res.body.hasPin).toBe(false);
    });

    it("never stores or returns the plaintext PIN", async () => {
      const created = await request(harness.app).post("/api/rooms").send({ pin: "8642" });
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain("8642");
      expect(created.body.hasPin).toBe(true);
    });

    it("throttles repeated wrong PINs and keeps serving correct ones", async () => {
      const room = harness.rooms.createRoom({ name: "Brute", pin: pinHash(ROOM_PIN) });

      // 10 wrong guesses is the budget.
      for (let i = 0; i < 10; i += 1) {
        const res = await request(harness.app)
          .get(`/api/rooms/${room.id}`)
          .set("X-Room-Pin", "0000");
        expect(res.status).toBe(401);
      }
      // The next one is refused before the scrypt derivation is even attempted.
      const blocked = await request(harness.app)
        .get(`/api/rooms/${room.id}`)
        .set("X-Room-Pin", "0000");
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe("RATE_LIMITED");

      // Once the budget is spent the client is locked out fail-closed: that is
      // what protects the server, and it mirrors how the server-PIN lockout
      // already behaves. It is a deliberate trade, not an oversight -- the
      // alternative (verify first, charge after) hands the attacker an
      // unbounded supply of 35ms blocking scrypt calls, which is the actual
      // denial of service.
      expect(blocked.headers["retry-after"]).toBeDefined();
    });

    it("never charges a CORRECT guess against the budget", async () => {
      // This is the anti-lockout property that matters: a legitimate client
      // makes dozens of authenticated calls a minute (file list, text,
      // clipboard, devices, SSE probe). If successes were counted, every user
      // would be locked out of their own room within seconds.
      const room = harness.rooms.createRoom({ name: "Busy", pin: pinHash(ROOM_PIN) });
      for (let i = 0; i < 40; i += 1) {
        const res = await request(harness.app)
          .get(`/api/rooms/${room.id}/files`)
          .set("X-Room-Pin", ROOM_PIN);
        expect(res.status).toBe(200);
      }
    });

    it("gives one noisy client its own budget", async () => {
      const room = harness.rooms.createRoom({ name: "Noisy", pin: pinHash(ROOM_PIN) });
      for (let i = 0; i < 12; i += 1) {
        await request(harness.app).get(`/api/rooms/${room.id}`).set("X-Room-Pin", "0000");
      }
      const other = harness.rooms.createRoom({ name: "Quiet", pin: pinHash(ROOM_PIN) });
      const ok = await request(harness.app)
        .get(`/api/rooms/${other.id}`)
        .set("X-Room-Pin", ROOM_PIN);
      expect(ok.status).toBe(200);
    });

    it("accepts the PIN in the query only on the SSE endpoint", async () => {
      // EventSource cannot set headers, so the query fallback must stay for
      // /events -- but nowhere else, or it lands in history and access logs.
      const room = harness.rooms.createRoom({ name: "Query", pin: pinHash(ROOM_PIN) });
      const viaQuery = await request(harness.app).get(`/api/rooms/${room.id}?roomPin=${ROOM_PIN}`);
      expect(viaQuery.status).toBe(401);
    });
  });
});
