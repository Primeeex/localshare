/**
 * Integration tests for the room REST API (spec 6.17).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createTestApp } from "../helpers/app.js";

describe("rooms API", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  describe("DELETE /api/rooms/:roomId", () => {
    it("deletes the room and removes its uploads directory", async () => {
      const created = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Doomed" })
        .expect(201);
      const roomId = created.body.id;

      const uploads = await request(harness.app)
        .post(`/api/rooms/${roomId}/files`)
        .attach("files[]", Buffer.from("some bytes"), "a.txt")
        .expect(201);

      const roomDir = join(harness.dir, roomId);
      await expect(stat(roomDir)).resolves.toBeTruthy();
      expect(uploads.body.storedName).toBeTruthy();

      await request(harness.app).delete(`/api/rooms/${roomId}`).expect(204);

      // WHY: the directory must be gone, not merely emptied
      await expect(stat(roomDir)).rejects.toMatchObject({ code: "ENOENT" });
      await request(harness.app).get(`/api/rooms/${roomId}`).expect(404);
      expect(await harness.storage.listFiles(roomId)).toHaveLength(0);
      // WHY: the quota accounting has to follow the deletion
      expect(harness.storage.calculateTotalSize()).toBe(0);
    });

    it("releases the file quota so the freed space can be reused", async () => {
      const created = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Reuse" })
        .expect(201);
      const roomId = created.body.id;

      await request(harness.app)
        .post(`/api/rooms/${roomId}/files`)
        .attach("files[]", Buffer.from("occupies space"), "a.txt")
        .expect(201);

      await request(harness.app).delete(`/api/rooms/${roomId}`).expect(204);

      const fresh = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Reuse" })
        .expect(201);
      await request(harness.app)
        .post(`/api/rooms/${fresh.body.id}/files`)
        .attach("files[]", Buffer.from("occupies space"), "a.txt")
        .expect(201);
    });

    it("refuses to delete the default room", async () => {
      const res = await request(harness.app).delete("/api/rooms/default");
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown room", async () => {
      const res = await request(harness.app).delete("/api/rooms/nope");
      expect(res.status).toBe(404);
    });
  });

  describe("room name", () => {
    it("accepts a 32-character name", async () => {
      const res = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "a".repeat(32) })
        .expect(201);
      expect(res.body.name).toHaveLength(32);
    });

    it("rejects a name longer than 32 characters on create", async () => {
      const res = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "a".repeat(33) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_BODY");
      expect(res.body.error.message).toBe("Room name must be 32 characters or fewer");
    });

    it("rejects a name longer than 32 characters on update", async () => {
      const created = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Short" })
        .expect(201);

      const res = await request(harness.app)
        .patch(`/api/rooms/${created.body.id}`)
        .send({ name: "b".repeat(33) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_BODY");
    });

    it("accepts a 32-character name on update", async () => {
      const created = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Short" })
        .expect(201);

      const res = await request(harness.app)
        .patch(`/api/rooms/${created.body.id}`)
        .send({ name: "c".repeat(32) })
        .expect(200);
      expect(res.body.name).toHaveLength(32);
    });

    it("rejects an empty or non-string name", async () => {
      const empty = await request(harness.app).post("/api/rooms").send({ name: "   " });
      expect(empty.status).toBe(400);
      expect(empty.body.error.code).toBe("INVALID_BODY");

      const wrongType = await request(harness.app).post("/api/rooms").send({ name: 42 });
      expect(wrongType.status).toBe(400);
      expect(wrongType.body.error.code).toBe("INVALID_BODY");
    });

    it("counts characters, not bytes, for a multibyte name", async () => {
      const res = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "測".repeat(32) })
        .expect(201);
      expect(res.body.name).toHaveLength(32);

      const tooLong = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "測".repeat(33) });
      expect(tooLong.status).toBe(400);
    });

    it("still allows creating a room with no name at all", async () => {
      const res = await request(harness.app).post("/api/rooms").send({}).expect(201);
      expect(res.body.id).toBeTruthy();
    });
  });

  describe("PIN handling", () => {
    it("never echoes a room PIN back to the client", async () => {
      const res = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Secret", pin: "4321" })
        .expect(201);

      expect(JSON.stringify(res.body)).not.toContain("4321");
      expect(res.body.pin).toBeUndefined();

      const stored = harness.rooms.getRoom(res.body.id);
      expect(stored.pin).toBeTruthy();
      expect(stored.pin).not.toBe("4321");
    });

    it("hashes a PIN supplied on update", async () => {
      const created = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Secret" })
        .expect(201);

      await request(harness.app)
        .patch(`/api/rooms/${created.body.id}`)
        .send({ pin: "4321" })
        .expect(200);

      const stored = harness.rooms.getRoom(created.body.id);
      expect(stored.pin).toBeTruthy();
      expect(stored.pin).not.toBe("4321");
    });

    it("ignores a client-supplied id so an existing room cannot be clobbered", async () => {
      // Regression: createRoom used to receive `{ ...req.body }`, which let a
      // caller pick the room id and overwrite an existing room's record.
      const created = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Original" })
        .expect(201);

      await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Hijack", id: created.body.id })
        .expect(201);

      const survivor = harness.rooms.getRoom(created.body.id);
      expect(survivor.name).toBe("Original");
    });

    it("does not let arbitrary body fields reach the stored room", async () => {
      // Regression: the raw body spread also injected unknown keys into the
      // room object, which serializeRoom then echoed back to clients.
      const res = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Clean", evilKey: "pwned", files: [] })
        .expect(201);

      expect(res.body.evilKey).toBeUndefined();
      expect(harness.rooms.getRoom(res.body.id).evilKey).toBeUndefined();
    });

    it("leaves the PIN alone when an update carries no PIN", async () => {
      const created = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Secret", pin: "4321" })
        .expect(201);
      const pinBefore = harness.rooms.getRoom(created.body.id).pin;

      await request(harness.app)
        .patch(`/api/rooms/${created.body.id}`)
        .set("X-Room-Pin", "4321")
        .send({ name: "Renamed" })
        .expect(200);

      expect(harness.rooms.getRoom(created.body.id).pin).toBe(pinBefore);
      // WHY: the PIN must still open the room after a PIN-less rename
      await request(harness.app)
        .get(`/api/rooms/${created.body.id}`)
        .set("X-Room-Pin", "4321")
        .expect(200);
    });
  });

  describe("listing", () => {
    it("creates and lists rooms", async () => {
      await request(harness.app).post("/api/rooms").send({ name: "Listed" }).expect(201);

      const res = await request(harness.app).get("/api/rooms").expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((r) => r.name === "Listed")).toBe(true);
    });

    it("serves the default room", async () => {
      const res = await request(harness.app).get("/api/rooms/default").expect(200);
      expect(res.body.id).toBe("default");
    });
  });

  describe("sanity", () => {
    it("keeps a PIN-protected room reachable through the room PIN", async () => {
      const created = await request(harness.app)
        .post("/api/rooms")
        .send({ name: "Locked", pin: "9876" })
        .expect(201);

      await request(harness.app).get(`/api/rooms/${created.body.id}`).expect(401);
      await request(harness.app)
        .get(`/api/rooms/${created.body.id}`)
        .set("X-Room-Pin", "9876")
        .expect(200);
    });
  });
});
