/**
 * Integration tests: text sharing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createTestApp } from "../helpers/app.js";

describe("text", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("POST creates a text entry and returns 201", async () => {
    const res = await request(harness.app)
      .post("/api/rooms/default/text")
      .set("X-Device-Id", "dev-1")
      .set("X-Device-Name", "Phone")
      .send({ content: "npm run build", label: "snippet" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      content: "npm run build",
      label: "snippet",
      roomId: "default",
      sharedBy: "dev-1",
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body.sharedAt).toBeTruthy();
  });

  it("GET returns the list including the new entry", async () => {
    const created = await request(harness.app)
      .post("/api/rooms/default/text")
      .send({ content: "hello room" })
      .expect(201);

    const res = await request(harness.app).get("/api/rooms/default/text");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(created.body.id);
  });

  it("POST without content returns 400 INVALID_BODY", async () => {
    const res = await request(harness.app).post("/api/rooms/default/text").send({ label: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
  });

  it("POST with too-long content returns 400 TEXT_TOO_LONG", async () => {
    const res = await request(harness.app)
      .post("/api/rooms/default/text")
      .send({ content: "x".repeat(100001) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TEXT_TOO_LONG");
  });

  it("DELETE removes the entry with 204", async () => {
    const created = await request(harness.app)
      .post("/api/rooms/default/text")
      .send({ content: "delete me" })
      .expect(201);

    const res = await request(harness.app).delete(`/api/rooms/default/text/${created.body.id}`);
    expect(res.status).toBe(204);

    const list = await request(harness.app).get("/api/rooms/default/text");
    expect(list.body).toHaveLength(0);
  });

  it("DELETE of a missing entry returns 404", async () => {
    const res = await request(harness.app).delete("/api/rooms/default/text/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TEXT_NOT_FOUND");
  });

  it("PATCH updates entry content", async () => {
    const created = await request(harness.app)
      .post("/api/rooms/default/text")
      .send({ content: "old" })
      .expect(201);

    const res = await request(harness.app)
      .patch(`/api/rooms/default/text/${created.body.id}`)
      .send({ content: "new" });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("new");
    expect(res.body.size).toBe(3);
  });

  it("returns 404 ROOM_NOT_FOUND for a missing room", async () => {
    const res = await request(harness.app).get("/api/rooms/ghost/text");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROOM_NOT_FOUND");
  });
});

describe("clipboard", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("POST creates a clipboard entry with 201", async () => {
    const res = await request(harness.app)
      .post("/api/rooms/default/clipboard")
      .send({ content: "copied text", type: "text" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ content: "copied text", type: "text" });
    expect(res.body.expiresAt).toBeTruthy();
  });

  it("rejects content longer than 5000 characters", async () => {
    const res = await request(harness.app)
      .post("/api/rooms/default/clipboard")
      .send({ content: "y".repeat(5001) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
  });

  it("lists and deletes entries", async () => {
    const created = await request(harness.app)
      .post("/api/rooms/default/clipboard")
      .send({ content: "temp" })
      .expect(201);

    const list = await request(harness.app).get("/api/rooms/default/clipboard");
    expect(list.body).toHaveLength(1);

    await request(harness.app)
      .delete(`/api/rooms/default/clipboard/${created.body.id}`)
      .expect(204);

    const empty = await request(harness.app).get("/api/rooms/default/clipboard");
    expect(empty.body).toHaveLength(0);
  });

  it("deleting an unknown entry returns 404 instead of crashing", async () => {
    const res = await request(harness.app).delete("/api/rooms/default/clipboard/missing");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CLIPBOARD_NOT_FOUND");
  });
});

describe("rooms API", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("lists rooms including default", async () => {
    const res = await request(harness.app).get("/api/rooms");
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.id === "default")).toBe(true);
  });

  it("creates, reads, renames and deletes a room", async () => {
    const created = await request(harness.app).post("/api/rooms").send({ name: "Kitchen" });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Kitchen");

    const got = await request(harness.app).get(`/api/rooms/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.name).toBe("Kitchen");

    const renamed = await request(harness.app)
      .patch(`/api/rooms/${created.body.id}`)
      .send({ name: "Garage" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Garage");

    await request(harness.app).delete(`/api/rooms/${created.body.id}`).expect(204);
    await request(harness.app).get(`/api/rooms/${created.body.id}`).expect(404);
  });

  it("refuses to delete the default room", async () => {
    const res = await request(harness.app).delete("/api/rooms/default");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CANNOT_DELETE_DEFAULT");
  });

  it("returns 404 for a missing room", async () => {
    const res = await request(harness.app).get("/api/rooms/ghost");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROOM_NOT_FOUND");
  });
});

describe("server API", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("GET /api/server/health returns ok", async () => {
    const res = await request(harness.app).get("/api/server/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /api/server/info returns server metadata", async () => {
    const res = await request(harness.app).get("/api/server/info");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hostname: "test-host", version: "1.0.0" });
    expect(res.body).toHaveProperty("interfaces");
    expect(res.body).toHaveProperty("roomCount");
  });

  it("GET /api/server/qr returns an SVG QR code", async () => {
    const res = await request(harness.app)
      .get("/api/server/qr")
      .query({ url: "http://192.168.1.7:3000" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    // WHY: supertest buffers image/* as a Buffer rather than text
    const svg = Buffer.isBuffer(res.body) ? res.body.toString() : res.text;
    expect(svg).toContain("<svg");
  });

  it("GET /api/server/qr rejects non-http URLs", async () => {
    const res = await request(harness.app)
      .get("/api/server/qr")
      .query({ url: "javascript:alert(1)" });
    expect(res.status).toBe(400);
  });

  it("returns the SPA shell for unknown non-API paths", async () => {
    const res = await request(harness.app).get("/some/deep/link");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<html");
  });

  it("returns structured 404 for unknown API paths", async () => {
    const res = await request(harness.app).get("/api/definitely-not-here");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: expect.any(String),
      requestId: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it("returns structured 404 for unsupported methods on API paths", async () => {
    const res = await request(harness.app).put("/api/rooms/default/clipboard");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error).toMatchObject({
      code: "NOT_FOUND",
      requestId: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it("returns structured 404 for non-GET requests outside the API", async () => {
    const res = await request(harness.app).post("/some/deep/link");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("sets security headers via helmet", async () => {
    const res = await request(harness.app).get("/api/server/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("CSP hash-allowlists the spec 6.10 inline theme script exactly", async () => {
    const res = await request(harness.app).get("/api/server/health");
    const csp = res.headers["content-security-policy"];
    for (const file of ["public/index.html", "public/pin.html"]) {
      const html = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
      const match = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(match, `no inline <script> in ${file}`).toBeTruthy();
      const hash = createHash("sha256").update(match[1], "utf8").digest("base64");
      expect(csp, `${file} inline script hash missing from CSP`).toContain(`'sha256-${hash}'`);
    }
    // No escape hatches: the spec forbids unsafe-inline for scripts
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});
