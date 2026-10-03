/**
 * Integration tests: server-sent events.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/app.js";
import { connectSSE } from "../helpers/sseClient.js";

describe("sse", () => {
  let harness;
  let base;
  const clients = [];

  beforeAll(async () => {
    harness = await createTestApp();
    const listening = await harness.listen();
    base = listening.url;
  });

  afterAll(async () => {
    await harness.destroy();
  });

  afterEach(() => {
    while (clients.length) {
      const client = clients.pop();
      try {
        client.close();
      } catch {
        /* already closed */
      }
    }
  });

  function open(params) {
    const client = connectSSE(base, params);
    clients.push(client);
    return client;
  }

  it("serves text/event-stream for /events", async () => {
    // WHY: raw client instead of supertest, since an SSE response never ends
    const client = open({ roomId: "default", deviceId: "probe" });
    await client.waitFor("connected", 2000);
    expect(client.statusCode).toBe(200);
    expect(client.headers["content-type"]).toContain("text/event-stream");
    expect(client.headers["cache-control"]).toContain("no-cache");
    expect(client.headers.connection).toContain("keep-alive");
  });

  it("sends a connected event within 1 second", async () => {
    const client = open({ roomId: "default", deviceId: "dev-conn", deviceName: "ConnPhone" });
    const entry = await client.waitFor("connected", 1000);

    expect(entry.data.type).toBe("connected");
    expect(entry.data.room.id).toBe("default");
    expect(entry.data).toHaveProperty("files");
    expect(entry.data).toHaveProperty("textEntries");
    expect(entry.data).toHaveProperty("clipboardEntries");
    expect(entry.data).toHaveProperty("devices");
    expect(entry.data.serverInfo).toHaveProperty("version");
    expect(entry.id).toBeTruthy();
  });

  it("lists the connected device for other clients", async () => {
    const client = open({ roomId: "default", deviceId: "dev-listed", deviceName: "ListedLaptop" });
    await client.waitFor("connected", 2000);

    const res = await request(harness.app).get("/api/rooms/default/devices");
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.id)).toContain("dev-listed");
  });

  it("broadcasts file:added when a file is uploaded", async () => {
    const listener = open({ roomId: "default", deviceId: "dev-watch", deviceName: "Watcher" });
    await listener.waitFor("connected", 2000);

    const upload = await request(harness.app)
      .post("/api/rooms/default/files")
      .set("X-Device-Id", "dev-uploader")
      .attach("files[]", Buffer.from("broadcast me"), "broadcast.txt");
    expect(upload.status).toBe(201);

    const entry = await listener.waitFor("file:added", 3000);
    expect(entry.data.file.originalName).toBe("broadcast.txt");
    expect(entry.data.file.id).toBe(upload.body.id);
    expect(entry.data.type).toBe("file:added");
    expect(entry.data.roomId).toBe("default");
  });

  it("broadcasts file:deleted when a file is removed", async () => {
    const listener = open({ roomId: "default", deviceId: "dev-watch2", deviceName: "Watcher2" });
    await listener.waitFor("connected", 2000);

    const upload = await request(harness.app)
      .post("/api/rooms/default/files")
      .attach("files[]", Buffer.from("temp"), "temp-delete.txt")
      .expect(201);

    await listener.waitFor("file:added", 3000);

    await request(harness.app).delete(`/api/rooms/default/files/${upload.body.id}`).expect(204);

    const entry = await listener.waitFor("file:deleted", 3000);
    expect(entry.data.fileId).toBe(upload.body.id);
  });

  it("broadcasts text:added when text is shared", async () => {
    const listener = open({ roomId: "default", deviceId: "dev-text", deviceName: "TextWatcher" });
    await listener.waitFor("connected", 2000);

    await request(harness.app)
      .post("/api/rooms/default/text")
      .send({ content: "broadcast text" })
      .expect(201);

    const entry = await listener.waitFor("text:added", 3000);
    expect(entry.data.entry.content).toBe("broadcast text");
  });

  it("sends a heartbeat ping within 20 seconds", async () => {
    const client = open({ roomId: "default", deviceId: "dev-heartbeat", deviceName: "Heartbeat" });
    await client.waitFor("connected", 2000);

    // Heartbeat interval is 15s; allow the full 20s window from spec
    const deadline = Date.now() + 19000;
    while (Date.now() < deadline && !client.raw.includes(": ping")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(client.raw).toContain(": ping");
  }, 25000);

  it("creates the room when connecting to an unknown roomId", async () => {
    const client = open({ roomId: "brand-new-room", deviceId: "dev-creator" });
    const entry = await client.waitFor("connected", 2000);
    expect(entry.data.room.id).toBe("brand-new-room");

    const res = await request(harness.app).get("/api/rooms/brand-new-room");
    expect(res.status).toBe(200);
  });

  it("registers devices through the room device list", async () => {
    const client = open({ roomId: "default", deviceId: "dev-final", deviceName: "FinalPhone" });
    await client.waitFor("connected", 2000);

    const devices = await request(harness.app).get("/api/rooms/default/devices");
    const device = devices.body.find((d) => d.id === "dev-final");
    expect(device).toBeTruthy();
    expect(device.name).toBe("FinalPhone");
    expect(device.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(device.deviceIcon).toBeTruthy();
  });
});
