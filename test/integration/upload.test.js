/**
 * Integration tests: file upload.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readdir } from "node:fs/promises";
import { createTestApp, pinHash } from "../helpers/app.js";
import { parseSize } from "../../src/config.js";

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
      // WHY spec 12 pins the wording, so it is asserted verbatim
      expect(res.body.error.message).toBe(
        "This room has reached the maximum of 1 files. Delete some files before uploading more."
      );
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

  describe("staged uploads (no in-memory buffering, no orphans)", () => {
    /**
     * List whatever is left in the staging directory.
     * @returns {Promise<string[]>}
     */
    async function stagedFiles() {
      try {
        return await readdir(harness.storage.getTempDir());
      } catch (err) {
        // ENOENT simply means nothing was ever staged
        if (err.code === "ENOENT") return [];
        throw err;
      }
    }

    it("empties the staging directory after a successful upload", async () => {
      await request(harness.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("streamed to disk"), "a.txt")
        .expect(201);

      expect(await stagedFiles()).toHaveLength(0);
    });

    it("leaves no staged file behind when the room is full", async () => {
      const capped = await createTestApp({ maxFilesPerRoom: 1 });
      try {
        await request(capped.app)
          .post("/api/rooms/default/files")
          .attach("files[]", Buffer.from("first"), "first.txt")
          .expect(201);

        await request(capped.app)
          .post("/api/rooms/default/files")
          .attach("files[]", Buffer.from("second"), "second.txt")
          .expect(409);

        expect(await readdir(capped.storage.getTempDir())).toHaveLength(0);
        expect(await capped.storage.listFiles("default")).toHaveLength(1);
      } finally {
        await capped.destroy();
      }
    });

    it("leaves no staged file behind when the storage quota is exceeded", async () => {
      const tiny = await createTestApp({ maxStorage: 8 });
      try {
        await request(tiny.app)
          .post("/api/rooms/default/files")
          .attach("files[]", Buffer.from("more than eight bytes"), "big.txt")
          .expect(507);

        expect(await readdir(tiny.storage.getTempDir())).toHaveLength(0);
        expect(await tiny.storage.listFiles("default")).toHaveLength(0);
      } finally {
        await tiny.destroy();
      }
    });

    it("leaves no staged file behind when the room does not exist", async () => {
      await request(harness.app)
        .post("/api/rooms/missing-room/files")
        .attach("files[]", Buffer.from("x"), "x.txt")
        .expect(404);

      expect(await stagedFiles()).toHaveLength(0);
    });

    it("leaves no staged file behind when the file exceeds the size limit", async () => {
      const small = await createTestApp({ maxFileSize: 1024 });
      try {
        await request(small.app)
          .post("/api/rooms/default/files")
          .attach("files[]", Buffer.alloc(4096), "big.bin")
          .expect(413);

        expect(await readdir(small.storage.getTempDir())).toHaveLength(0);
      } finally {
        await small.destroy();
      }
    });

    it("leaves no staged file behind when no file was sent", async () => {
      await request(harness.app).post("/api/rooms/default/files").send({}).expect(400);

      expect(await stagedFiles()).toHaveLength(0);
    });

    it("cleans up the parts that were already staged when a later one fails", async () => {
      const tiny = await createTestApp({ maxStorage: 8 });
      try {
        const res = await request(tiny.app)
          .post("/api/rooms/default/files")
          .attach("files[]", Buffer.from("aaaa"), "one.txt")
          .attach("files[]", Buffer.from("bbbbbbbbbbbbbbbb"), "two.txt");

        expect(res.status).toBe(507);
        expect(await readdir(tiny.storage.getTempDir())).toHaveLength(0);
        expect(await tiny.storage.listFiles("default")).toHaveLength(0);
      } finally {
        await tiny.destroy();
      }
    });
  });

  describe("upload rate limiting", () => {
    // WHY 100/min: the server-wide /api limiter allows 100 requests per 15
    // minutes, so it never trips before the dedicated upload budget of 10/min.
    const UPLOADS_BEFORE_THROTTLE = 10;

    let limited;

    beforeEach(async () => {
      limited = await createTestApp({ rateLimit: true, maxFilesPerRoom: 1000 });
    });

    afterEach(async () => {
      await limited.destroy();
    });

    /**
     * Upload one tiny file.
     * @param {string} name
     * @returns {Promise<Object>} The supertest response
     */
    function upload(name) {
      return request(limited.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("x"), name);
    }

    it(`allows the first ${UPLOADS_BEFORE_THROTTLE} uploads and throttles the next`, async () => {
      for (let i = 0; i < UPLOADS_BEFORE_THROTTLE; i += 1) {
        const ok = await upload(`ok-${i}.txt`);
        expect(ok.status, `upload #${i + 1}`).toBe(201);
      }

      const throttled = await upload("one-too-many.txt");
      expect(throttled.status).toBe(429);
      expect(throttled.body.error.code).toBe("RATE_LIMITED");
      expect(throttled.headers["retry-after"]).toBeTruthy();
      expect(throttled.body.error.message).toMatch(/too many/i);

      // WHY: the rejected upload must not have left a staged file behind
      expect(await readdir(limited.storage.getTempDir())).toHaveLength(0);
      expect(await limited.storage.listFiles("default")).toHaveLength(UPLOADS_BEFORE_THROTTLE);
    });

    it("does not throttle downloads that share the same path prefix", async () => {
      const uploadRes = await request(limited.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("downloadable"), "dl.txt")
        .expect(201);

      // Downloads, previews, listings and the zip all live under the same
      // prefix as the upload; none of them may consume the upload budget.
      for (let i = 0; i < 15; i += 1) {
        const res = await request(limited.app).get(
          `/api/rooms/default/files/${uploadRes.body.id}/download`
        );
        expect(res.status, `download #${i + 1}`).toBe(200);
      }
      await request(limited.app).get("/api/rooms/default/files").expect(200);
      await request(limited.app).get("/api/rooms/default/files/zip").expect(200);
    });

    it("returns the standard error envelope when throttled", async () => {
      for (let i = 0; i < UPLOADS_BEFORE_THROTTLE; i += 1) await upload(`a-${i}.txt`);

      const throttled = await upload("b.txt");
      expect(throttled.status).toBe(429);
      expect(throttled.body.error).toMatchObject({
        code: "RATE_LIMITED",
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });
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
  // The quota check compared every file against the SAME pre-request total:
  //
  //   const totalSize = storage.calculateTotalSize();
  //   for (const file of staged) if (totalSize + file.size > maxStorage) ...
  //
  // so one multi-file POST could write files x maxFileSize regardless of the
  // quota. With the shipped defaults that is 10 x 2GB against a 10GB limit --
  // 2x the configured storage in a single request, repeating on every request.
  describe("storage quota", () => {
    it("counts every file in the request, not just the first", async () => {
      const small = await createTestApp({ maxStorage: parseSize("1MB") });
      try {
        const chunk = Buffer.alloc(400 * 1024, 0x61);
        const res = await request(small.app)
          .post("/api/rooms/default/files")
          .attach("files[]", chunk, "a.bin")
          .attach("files[]", chunk, "b.bin")
          .attach("files[]", chunk, "c.bin");
        // 3 x 400KB = 1.2MB against a 1MB quota: must be refused.
        expect(res.status).toBe(507);
        expect(res.body.error.code).toBe("STORAGE_FULL");

        // And nothing may have been kept.
        const files = await request(small.app).get("/api/rooms/default/files");
        expect(files.body).toHaveLength(0);
      } finally {
        await small.destroy();
      }
    });

    it("accepts a request that fits exactly", async () => {
      const small = await createTestApp({ maxStorage: parseSize("1MB") });
      try {
        const res = await request(small.app)
          .post("/api/rooms/default/files")
          .attach("files[]", Buffer.alloc(400 * 1024, 0x61), "a.bin")
          .attach("files[]", Buffer.alloc(400 * 1024, 0x61), "b.bin");
        expect(res.status).toBe(201);
      } finally {
        await small.destroy();
      }
    });
  });

  // Unvalidated, the expiry controls were a way to make files immortal:
  // `expiresAt: null` (or any non-date string, since `new Date("x") <= now`
  // is false) made the reaper skip the file forever, and `pinned: true` skipped
  // it outright -- so any room member could defeat --expiry and fill the disk
  // with files nothing would ever reclaim.
  describe("metadata validation", () => {
    let fileId;
    beforeEach(async () => {
      const res = await request(harness.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from("payload"), "note.txt");
      fileId = res.body.id;
    });

    it("accepts a real ISO date", async () => {
      const when = new Date(Date.now() + 3600_000).toISOString();
      const res = await request(harness.app)
        .patch(`/api/rooms/default/files/${fileId}`)
        .send({ expiresAt: when });
      expect(res.status).toBe(200);
      expect(res.body.expiresAt).toBe(when);
    });

    for (const bad of ["not-a-date", "", 12345, {}]) {
      it(`rejects expiresAt ${JSON.stringify(bad)}`, async () => {
        const res = await request(harness.app)
          .patch(`/api/rooms/default/files/${fileId}`)
          .send({ expiresAt: bad });
        expect(res.status).toBe(400);
      });
    }

    it("rejects a non-boolean pinned and a non-string note", async () => {
      expect(
        (
          await request(harness.app)
            .patch(`/api/rooms/default/files/${fileId}`)
            .send({ pinned: "yes" })
        ).status
      ).toBe(400);
      expect(
        (
          await request(harness.app)
            .patch(`/api/rooms/default/files/${fileId}`)
            .send({ note: { evil: true } })
        ).status
      ).toBe(400);
    });

    it("still allows an explicit null expiry", async () => {
      const res = await request(harness.app)
        .patch(`/api/rooms/default/files/${fileId}`)
        .send({ expiresAt: null });
      expect(res.status).toBe(200);
      expect(res.body.expiresAt).toBeNull();
    });
  });
});
