/**
 * Integration tests: PIN authentication flow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, pinHash } from "../helpers/app.js";
import { clearRateLimits } from "../../src/auth.js";

describe("auth", () => {
  let harness;

  beforeEach(async () => {
    clearRateLimits();
    harness = await createTestApp({ pin: pinHash("4829") });
  });

  afterEach(async () => {
    clearRateLimits();
    await harness.destroy();
  });

  it("serves only the PIN page before authentication", async () => {
    const res = await request(harness.app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<html");
    expect(res.text).toContain("Enter PIN");
    // The app markup must not ship before the session cookie exists
    expect(res.text).not.toContain('id="app"');
  });

  it("serves the PIN page for deep links too", async () => {
    const res = await request(harness.app).get("/some/deep/link");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Enter PIN");
  });

  it("keeps the PIN page assets public", async () => {
    const script = await request(harness.app).get("/js/pin.js");
    expect(script.status).toBe(200);
    const css = await request(harness.app).get("/css/tokens.css");
    expect(css.status).toBe(200);
  });

  it("returns 401 AUTH_REQUIRED on API routes without a cookie", async () => {
    const routes = [
      "/api/server/info",
      "/api/rooms",
      "/api/rooms/default/files",
      "/api/rooms/default/text",
      "/api/rooms/default/clipboard",
      "/api/rooms/default/devices",
    ];
    for (const route of routes) {
      const res = await request(harness.app).get(route);
      expect(res.status, route).toBe(401);
      expect(res.body.error.code, route).toBe("AUTH_REQUIRED");
      expect(res.body.error.requestId).toBeTruthy();
      expect(res.body.error.timestamp).toBeTruthy();
    }
  });

  it("returns 401 on the SSE endpoint without a cookie", async () => {
    const res = await request(harness.app).get("/events?roomId=default");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("exposes auth status without a cookie", async () => {
    const res = await request(harness.app).get("/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false, pinRequired: true });
  });

  it("rejects a missing PIN body with 400", async () => {
    const res = await request(harness.app).post("/api/auth/verify").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
  });

  it("returns 401 AUTH_INVALID with retriesLeft for a wrong PIN", async () => {
    const res = await request(harness.app).post("/api/auth/verify").send({ pin: "0000" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_INVALID");
    expect(res.body.error.retriesLeft).toBe(2);
  });

  it("locks out after 3 wrong attempts with a 429", async () => {
    await request(harness.app).post("/api/auth/verify").send({ pin: "0000" }).expect(401);
    await request(harness.app).post("/api/auth/verify").send({ pin: "0000" }).expect(401);

    const res = await request(harness.app).post("/api/auth/verify").send({ pin: "0000" });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("AUTH_LOCKED");
    expect(res.body.error.lockoutDuration).toBeGreaterThan(0);

    // Even the correct PIN is refused while locked
    const duringLock = await request(harness.app).post("/api/auth/verify").send({ pin: "4829" });
    expect(duringLock.status).toBe(429);
    expect(duringLock.body.error.code).toBe("AUTH_LOCKED");
  });

  it("sets a session cookie for the correct PIN", async () => {
    const res = await request(harness.app).post("/api/auth/verify").send({ pin: "4829" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(res.headers["set-cookie"][0]).toContain("localshare_session=");
    expect(res.headers["set-cookie"][0]).toContain("HttpOnly");
  });

  it("allows API access with the session cookie", async () => {
    const agent = request.agent(harness.app);
    await agent.post("/api/auth/verify").send({ pin: "4829" }).expect(200);

    const shell = await agent.get("/");
    expect(shell.status).toBe(200);
    expect(shell.text).toContain('id="app"');
    expect(shell.text).not.toContain("Enter PIN");

    const info = await agent.get("/api/server/info");
    expect(info.status).toBe(200);

    const status = await agent.get("/api/auth/status");
    expect(status.body).toEqual({ authenticated: true, pinRequired: true });

    const upload = await agent
      .post("/api/rooms/default/files")
      .attach("files[]", Buffer.from("with cookie"), "cookie.txt");
    expect(upload.status).toBe(201);
  });

  it("logs out and drops access", async () => {
    const agent = request.agent(harness.app);
    await agent.post("/api/auth/verify").send({ pin: "4829" }).expect(200);
    await agent.post("/api/auth/logout").expect(200);

    const res = await agent.get("/api/rooms");
    expect(res.status).toBe(401);
  });

  it("rejects a forged cookie", async () => {
    const res = await request(harness.app)
      .get("/api/rooms")
      .set("Cookie", "localshare_session=deadbeef.eyJmYWtlIjp0cnVlfQ==");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });
});

describe("auth disabled", () => {
  let harness;

  beforeEach(async () => {
    clearRateLimits();
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("reports pinRequired false and allows access", async () => {
    const status = await request(harness.app).get("/api/auth/status");
    expect(status.body).toEqual({ authenticated: false, pinRequired: false });

    const rooms = await request(harness.app).get("/api/rooms");
    expect(rooms.status).toBe(200);
  });
});
