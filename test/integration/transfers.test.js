import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/app.js";
import { connectSSE } from "../helpers/sseClient.js";

const SENDER = "device-sender";
const TARGET = "device-target";
const NOSY = "device-nosy";

describe("transfers", () => {
  let harness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  /** Register a device so the transfer route sees it as connected. */
  async function connect(deviceId) {
    const { url } = await harness.listen();
    const client = connectSSE(url, { roomId: "default", deviceId });
    await client.waitFor("connected", 5000);
    return client;
  }

  async function upload(name = "note.txt", body = "hello") {
    const res = await request(harness.app)
      .post(`/api/rooms/default/files`)
      .set("X-Device-Id", SENDER)
      .attach("files[]", Buffer.from(body), name);
    return res.body.id;
  }

  async function offer(targetDeviceId, fileId) {
    const res = await request(harness.app)
      .post(`/api/rooms/default/transfers`)
      .set("X-Device-Id", SENDER)
      .send({ fileId, targetDeviceId });
    return res.body.id;
  }

  describe("accepting", () => {
    it("serves the download to the target device with the header", async () => {
      const fileId = await upload("accept-me.txt", "accepted payload");
      await connect(TARGET);
      const transferId = await offer(TARGET, fileId);
      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .set("X-Device-Id", TARGET)
        .send({ action: "accept" })
        .expect(200);

      const res = await request(harness.app)
        .get(`/api/rooms/default/transfers/${transferId}/download`)
        .set("X-Device-Id", TARGET)
        .expect(200);
      expect(res.text).toBe("accepted payload");
    });

    it("serves the download to a plain navigation, which cannot set headers", async () => {
      // THE regression. window.location.href sends no X-Device-Id, so this is
      // exactly what the browser did and it used to 403 "Access denied".
      const fileId = await upload("accept-me.txt", "accepted payload");
      await connect(TARGET);
      const transferId = await offer(TARGET, fileId);
      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .set("X-Device-Id", TARGET)
        .send({ action: "accept" })
        .expect(200);

      const res = await request(harness.app)
        .get(`/api/rooms/default/transfers/${transferId}/download?deviceId=${TARGET}`)
        .expect(200);
      expect(res.text).toBe("accepted payload");
    });

    it("still refuses a device that is not the target", async () => {
      const fileId = await upload();
      await connect(TARGET);
      const transferId = await offer(TARGET, fileId);
      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .set("X-Device-Id", TARGET)
        .send({ action: "accept" })
        .expect(200);

      await request(harness.app)
        .get(`/api/rooms/default/transfers/${transferId}/download`)
        .set("X-Device-Id", NOSY)
        .expect(403);
      await request(harness.app)
        .get(`/api/rooms/default/transfers/${transferId}/download?deviceId=${NOSY}`)
        .expect(403);
    });
  });

  describe("declining", () => {
    it("does NOT delete the file", async () => {
      // THE data-loss regression: declining an offer to RECEIVE a file used to
      // destroy the sender's original in the shared pool.
      const fileId = await upload("precious.txt", "irreplaceable data");
      await connect(TARGET);
      const transferId = await offer(TARGET, fileId);

      const before = await request(harness.app).get(`/api/rooms/default/files`).expect(200);
      expect(before.body).toHaveLength(1);

      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .set("X-Device-Id", TARGET)
        .send({ action: "decline" })
        .expect(200);

      const after = await request(harness.app).get(`/api/rooms/default/files`).expect(200);
      expect(after.body).toHaveLength(1);
      expect(after.body[0].id).toBe(fileId);

      const res = await request(harness.app)
        .get(`/api/rooms/default/files/${fileId}/download`)
        .expect(200);
      expect(res.text).toBe("irreplaceable data");
    });
  });

  describe("what the recipient is told", () => {
    it("carries the file name and size on the transfer", async () => {
      // Spec 6.19: the modal reads "[QuickFox] wants to send you: photo.jpg
      // (2.3 MB)". Without this the recipient saw only "wants to send you a
      // file" and had no way to know what they were accepting.
      const fileId = await upload("photo.jpg", "0123456789");
      await connect(TARGET);
      const res = await request(harness.app)
        .post(`/api/rooms/default/transfers`)
        .set("X-Device-Id", SENDER)
        .send({ fileId, targetDeviceId: TARGET })
        .expect(201);
      expect(res.body.originalName).toBe("photo.jpg");
      expect(res.body.size).toBe(10);
    });
  });

  describe("only the target may answer", () => {
    it("rejects an accept from a different device with 403", async () => {
      const fileId = await upload();
      await connect(TARGET);
      const transferId = await offer(TARGET, fileId);
      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .set("X-Device-Id", NOSY)
        .send({ action: "accept" })
        .expect(403);
    });

    it("rejects a decline from a different device, leaving the transfer pending", async () => {
      // Without this check any device in the room could decline an offer made
      // to someone else and rob them of the file.
      const fileId = await upload();
      await connect(TARGET);
      const transferId = await offer(TARGET, fileId);
      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .set("X-Device-Id", NOSY)
        .send({ action: "decline" })
        .expect(403);

      // The real target can still accept it.
      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .set("X-Device-Id", TARGET)
        .send({ action: "accept" })
        .expect(200);
    });
  });

  describe("validation", () => {
    it("rejects an unknown action", async () => {
      const fileId = await upload();
      await connect(TARGET);
      const transferId = await offer(TARGET, fileId);
      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .send({ action: "maybe" })
        .expect(400);
    });

    it("404s for an unknown transfer", async () => {
      await request(harness.app).get(`/api/rooms/default/transfers/nope/download`).expect(404);
    });

    it("emits a well-formed Content-Disposition", async () => {
      // originalName is attacker-controlled and used to be interpolated raw
      // into `filename="..."`. NB `filename*=` does NOT contain the substring
      // `filename=`, so exactly one match is the correct expectation.
      const fileId = await upload("plain.txt", "x");
      await connect(TARGET);
      const transferId = await offer(TARGET, fileId);
      await request(harness.app)
        .patch(`/api/rooms/default/transfers/${transferId}`)
        .set("X-Device-Id", TARGET)
        .send({ action: "accept" })
        .expect(200);

      const res = await request(harness.app)
        .get(`/api/rooms/default/transfers/${transferId}/download?deviceId=${TARGET}`)
        .expect(200);
      const cd = res.headers["content-disposition"];
      expect(cd).toContain("attachment;");
      expect(cd.match(/filename=/g)).toHaveLength(1);
      expect(cd).toContain("filename*=UTF-8''plain.txt");
      // The ASCII fallback must carry no quote that could close the parameter.
      expect(/filename="([^"]*)"/.exec(cd)[1]).toBe("plain.txt");
    });
  });
});
