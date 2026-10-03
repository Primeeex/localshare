/**
 * Integration tests: file upload.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, pinHash } from "../helpers/app.js";

describe("upload", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("POST with a valid file returns 201 and metadata", async () => {
    const res = await request(harness.app)
      .post("/api/rooms/default/files")
      .set("X-Device-Id", "dev-a")
      .set("X-Device-Name", "TestLaptop")
      .attach("files[]", Buffer.from("hello localshare"), "hello.txt", {
        contentType: "text/plain",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      originalName: "hello.txt",
      size: 16,
      roomId: "default",
      mimeType: "text/plain",
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body.expiresAt).toBeTruthy();
  });

  it("POST with an oversized file returns 413 FILE_TOO_LARGE", async () => {
    const small = await createTestApp({ maxFileSize: 1024 });
    try {
      const res = await request(small.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.alloc(4096), "big.bin", {
          contentType: "application/octet-stream",
        });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe("FILE_TOO_LARGE");
      expect(res.body.error).toMatchObject({
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    } finally {
      await small.destroy();
    }
  });

  it("POST without a file returns 400 INVALID_BODY", async () => {
    const res = await request(harness.app).post("/api/rooms/default/files").send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
  });

  it("POST with multiple files returns an array of metadata", async () => {
    const res = await request(harness.app)
      .post("/api/rooms/default/files")
      .attach("files[]", Buffer.from("one"), "one.txt", { contentType: "text/plain" })
      .attach("files[]", Buffer.from("two"), "two.txt", { contentType: "text/plain" });

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((f) => f.originalName).sort()).toEqual(["one.txt", "two.txt"]);
  });

  it("POST to a missing room returns 404 ROOM_NOT_FOUND", async () => {
    const res = await request(harness.app)
      .post("/api/rooms/missing-room/files")
      .attach("files[]", Buffer.from("x"), "x.txt");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROOM_NOT_FOUND");
  });

  it("rejects uploads beyond the per-room file cap", async () => {
    const capped = await createTestApp({ maxFilesPerRoom: 1 });
    try {
      await request(capped.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("first"), "first.txt")
        .expect(201);
      const res = await request(capped.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("second"), "second.txt");
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ROOM_FULL");
    } finally {
      await capped.destroy();
    }
  });

  it("returns 507 STORAGE_FULL when the storage limit is exceeded", async () => {
    const tiny = await createTestApp({ maxStorage: 8 });
    try {
      const res = await request(tiny.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("more than eight bytes"), "big.txt");
      expect(res.status).toBe(507);
      expect(res.body.error.code).toBe("STORAGE_FULL");
    } finally {
      await tiny.destroy();
    }
  });

  it("lists uploaded files", async () => {
    await request(harness.app)
      .post("/api/rooms/default/files")
      .attach("files[]", Buffer.from("listed"), "listed.txt")
      .expect(201);

    const res = await request(harness.app).get("/api/rooms/default/files");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].originalName).toBe("listed.txt");
  });

  it("deletes a file with 204", async () => {
    const upload = await request(harness.app)
      .post("/api/rooms/default/files")
      .attach("files[]", Buffer.from("temp"), "temp.txt")
      .expect(201);

    const res = await request(harness.app).delete(`/api/rooms/default/files/${upload.body.id}`);
    expect(res.status).toBe(204);
    const list = await request(harness.app).get("/api/rooms/default/files");
    expect(list.body).toHaveLength(0);
  });

  describe("with PIN protection", () => {
    let pinned;

    beforeEach(async () => {
      pinned = await createTestApp({ pin: pinHash("1234") });
    });

    afterEach(async () => {
      await pinned.destroy();
    });

    it("rejects uploads without a session cookie with 401 AUTH_REQUIRED", async () => {
      const res = await request(pinned.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("secret"), "secret.txt");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_REQUIRED");
    });

    it("accepts uploads with a valid session cookie", async () => {
      const agent = request.agent(pinned.app);
      await agent.post("/api/auth/verify").send({ pin: "1234" }).expect(200);

      const res = await agent
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("secret"), "secret.txt");
      expect(res.status).toBe(201);
      expect(res.body.originalName).toBe("secret.txt");
    });
  });
});
