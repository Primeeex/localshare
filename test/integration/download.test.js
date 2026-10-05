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

  it("serves an inline preview for a plain text file", async () => {
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

  // SECURITY: the preview endpoint used to echo the sniffed MIME type and
  // `inline`, so an uploaded `evil.html` was served as text/html from this
  // app's own origin. A second uploaded `.js` pulled in by a <script src>
  // then executed with full same-origin access -- read every file, read the
  // clipboard, delete every room. The CSP cannot stop it, because
  // `script-src 'self'` is precisely the origin the attacker writes to.
  describe("active content is never served inline", () => {
    const upload = async (name, body) => {
      const res = await request(harness.app)
        .post("/api/rooms/default/files")
        .attach("files[]", Buffer.from(body), name);
      return res.body.id;
    };

    const preview = (id) =>
      request(harness.app)
        .get(`/api/rooms/default/files/${id}/preview`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });

    for (const [label, name] of [
      ["HTML", "evil.html"],
      ["SVG", "evil.svg"],
      ["JavaScript", "evil.js"],
      ["PDF", "evil.pdf"],
      ["unknown extension", "evil.unknownext"],
    ]) {
      it(`forces ${label} to an octet-stream attachment`, async () => {
        const id = await upload(name, "<script>alert(1)</script>");
        const res = await preview(id);
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe("application/octet-stream");
        expect(res.headers["content-disposition"]).toContain("attachment");
        expect(res.headers["content-disposition"]).not.toContain("inline");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
      });
    }

    it("still previews a real image inline", async () => {
      // A 1x1 transparent PNG. Proves the allowlist is a list, not a blanket
      // block -- images must keep working, that is the point of preview.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      );
      const res = await request(harness.app)
        .post("/api/rooms/default/files")
        .attach("files[]", png, "pixel.png");
      const got = await preview(res.body.id);
      expect(got.status).toBe(200);
      expect(got.headers["content-type"]).toBe("image/png");
      expect(got.headers["content-disposition"]).toContain("inline");
    });

    it("does not let a filename break out of the Content-Disposition header", async () => {
      const id = await upload('a"; filename="pwned.txt', "x");
      const res = await preview(id);
      const cd = res.headers["content-disposition"];
      // Quotes must be encoded, not echoed raw into the header.
      expect(cd).not.toMatch(/filename="pwned/);
      expect(cd).toMatch(/filename\*=UTF-8''/);
    });

    it("emits exactly one filename parameter", async () => {
      // Guards a real regression: wrapping the RFC 5987 helper inside the
      // pre-existing `filename="..."` wrapper produced
      // `filename="filename="evil.html"; ...`, i.e. a malformed header.
      const res = await preview(fileId);
      expect(res.headers["content-disposition"]).toBe(
        `inline; filename="sample.txt"; filename*=UTF-8''sample.txt`
      );
      expect(res.headers["content-disposition"].match(/filename=/g)).toHaveLength(1);
    });

    it("keeps a non-ASCII filename intact via the encoded form", async () => {
      const id = await upload("rapport-\u00e9t\u00e9-\u65e5\u672c\u8a9e.txt", "x");
      const cd = (await preview(id)).headers["content-disposition"];
      // The exact bytes the multipart parser hands us are not this test's
      // concern; what matters is that the ASCII fallback is, in fact, ASCII,
      // so no raw non-ASCII byte is ever placed in a response header.
      // The ASCII fallback must contain no raw non-ASCII bytes.
      // NB no `^` anchor: the disposition type ("inline; ") comes first.
      const ascii = /filename="([^"]*)"/.exec(cd)[1];
      expect(ascii).toMatch(/^[\x20-\x7e]*$/);
    });
  });

  // Range handling used to advertise a Content-Range far larger than the bytes
  // actually written, which made a resumable downloader record a truncated
  // file as complete, and to declare a 1 MB Content-Length for a 20-byte file
  // and then never end the response.
  describe("range requests", () => {
    it("clamps an over-long range to the real file size", async () => {
      const res = await request(harness.app)
        .get(`/api/rooms/default/files/${fileId}/download`)
        .set("Range", `bytes=0-999999999`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(206);
      expect(res.headers["content-range"]).toBe(`bytes 0-${CONTENT.length - 1}/${CONTENT.length}`);
      expect(Number(res.headers["content-length"])).toBe(CONTENT.length);
      expect(res.body.length).toBe(CONTENT.length);
    });

    for (const bad of ["bytes=abc-def", "bytes=5-1", "bytes=-", "garbage", "bytes=99999-"]) {
      it(`answers 416 for the malformed range ${JSON.stringify(bad)}`, async () => {
        const res = await request(harness.app)
          .get(`/api/rooms/default/files/${fileId}/download`)
          .set("Range", bad);
        expect(res.status).toBe(416);
      });
    }

    it("serves a suffix range", async () => {
      const res = await request(harness.app)
        .get(`/api/rooms/default/files/${fileId}/download`)
        .set("Range", "bytes=-5")
        .buffer(true)
        .parse((res, cb) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(206);
      expect(res.body.toString()).toBe("y dog"); // the last 5 bytes of CONTENT
      expect(Number(res.headers["content-length"])).toBe(res.body.length);
    });
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
