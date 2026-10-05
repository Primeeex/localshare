/**
 * Unit tests: error response formatting.
 *
 * The code was collapsed to INTERNAL_ERROR but the *message* was copied
 * through verbatim, so a filesystem error came back as
 * `EACCES: permission denied, open '/var/lib/localshare/uploads/<room>/<id>.meta.json'`
 * -- disclosing the absolute uploads path, the room directory layout and the
 * on-disk file naming to anyone who can reach a room.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/app.js";

describe("error responses", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("never leaks an absolute filesystem path", async () => {
    // A file id that passes the id regex but does not exist on disk, so
    // storage throws a real ENOENT carrying the full path.
    const res = await request(harness.app).delete("/api/rooms/default/files/does-not-exist");

    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/\/tmp\/localshare-test-/);
    expect(body).not.toMatch(/\.meta\.json/);
    expect(body).not.toMatch(/ENOENT|EACCES|ENOSPC/);
  });

  it("keeps a known application message readable", async () => {
    const res = await request(harness.app).get("/api/rooms/no-such-room");
    expect(res.status).toBe(404);
    // A deliberate, hand-written message is useful to the client and reveals
    // nothing -- only raw Node/fs errors are masked.
    expect(typeof res.body.error.message).toBe("string");
    expect(res.body.error.message.length).toBeGreaterThan(0);
    expect(res.body.error.message).not.toMatch(/\/tmp\/|\/var\/|\/home\//);
  });

  it("still returns a request id and timestamp for correlation", async () => {
    const res = await request(harness.app).get("/api/rooms/no-such-room");
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.body.error.timestamp).toBeTruthy();
  });
});
