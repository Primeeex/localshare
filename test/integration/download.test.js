/**
 * Integration tests: download, preview, ranges and ZIP.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/app.js";

const CONTENT = "the quick brown fox jumps over the lazy dog";

describe("download", () => {
  let harness;
  let fileId;

  beforeEach(async () => {
    harness = await createTestApp();
    const res = await request(harness.app)
      .post("/api/rooms/default/files")
      .attach("files[]", Buffer.from(CONTENT), "sample.txt", { contentType: "text/plain" });
    fileId = res.body.id;
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("returns the file stream with a download disposition", async () => {
    const res = await request(harness.app)
      .get(`/api/rooms/default/files/${fileId}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("sample.txt");
    expect(res.body.toString()).toBe(CONTENT);
  });

  it("increments the download count", async () => {
    await request(harness.app).get(`/api/rooms/default/files/${fileId}/download`).expect(200);
    const meta = await request(harness.app).get(`/api/rooms/default/files/${fileId}`);
    expect(meta.body.downloadCount).toBe(1);
  });

  it("returns 404 FILE_NOT_FOUND for an invalid fileId", async () => {
    const res = await request(harness.app).get("/api/rooms/default/files/doesnotexist/download");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("FILE_NOT_FOUND");
  });

  it("returns 206 partial content for a Range header", async () => {
    const res = await request(harness.app)
      .get(`/api/rooms/default/files/${fileId}/download`)
      .set("Range", "bytes=4-8")
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 4-8/${CONTENT.length}`);
    expect(res.body.toString()).toBe("quick");
  });

  it("serves an inline preview", async () => {
    const res = await request(harness.app)
      .get(`/api/rooms/default/files/${fileId}/preview`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.body.toString()).toBe(CONTENT);
  });

  it("returns a ZIP stream containing the file", async () => {
    const res = await request(harness.app)
      .get("/api/rooms/default/files/zip")
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain(".zip");
    // ZIP local file header magic
    expect(res.body.slice(0, 2).toString()).toBe("PK");
    expect(res.body.length).toBeGreaterThan(22);
  });

  it("returns 200 with an empty ZIP for an empty room", async () => {
    const res = await request(harness.app)
      .get("/api/rooms/fresh-room/files/zip")
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    // End-of-central-directory magic for an empty archive
    expect(res.body.slice(0, 2).toString()).toBe("PK");
    expect(res.body.length).toBe(22);
  });

  it("updates file metadata with PATCH", async () => {
    const res = await request(harness.app)
      .patch(`/api/rooms/default/files/${fileId}`)
      .send({ note: "shared notes", pinned: true });

    expect(res.status).toBe(200);
    expect(res.body.note).toBe("shared notes");
    expect(res.body.pinned).toBe(true);
  });

  it("returns 404 for PATCH on a missing file", async () => {
    const res = await request(harness.app)
      .patch("/api/rooms/default/files/missing")
      .send({ note: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("FILE_NOT_FOUND");
  });
});
