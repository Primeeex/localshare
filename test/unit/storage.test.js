/**
 * Unit tests for the storage layer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, sanitizeFilename, MAX_FILENAME_BYTES } from "../../src/storage.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_STORAGE = 10 * 1024 * 1024; // 10MB

let stagedCount = 0;

/**
 * Stage bytes into the storage staging directory, the way the upload route
 * hands a completed multipart part to saveFile.
 * @param {Storage} storage
 * @param {string|Buffer} content
 * @returns {Promise<string>} The staged path
 */
async function stageFile(storage, content) {
  await storage.ensureTempDir();
  stagedCount += 1;
  const path = join(storage.getTempDir(), `staged-${stagedCount}-${randomSuffix()}`);
  await writeFile(path, content);
  return path;
}

/**
 * Produce a suffix that will not collide between staged files.
 * @returns {string}
 */
function randomSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

describe("storage", () => {
  let dir;
  let storage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "localshare-storage-"));
    storage = new Storage(dir, MAX_FILE_SIZE, MAX_STORAGE);
    await storage.rebuildIndexFromDisk();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("sanitizeFilename", () => {
    it("strips path traversal", () => {
      const result = sanitizeFilename("../../etc/passwd");
      expect(result).toBe("__etc_passwd");
      expect(result).not.toContain("..");
      expect(result).not.toContain("/");
    });

    it("replaces dangerous characters with underscores", () => {
      expect(sanitizeFilename('a:b*c?"d<>e|f')).toBe("a_b_c__d__e_f");
    });

    it("falls back to unnamed_file for empty names", () => {
      expect(sanitizeFilename("")).toBe("unnamed_file");
      expect(sanitizeFilename("..")).toBe("unnamed_file");
    });

    it("keeps normal names intact", () => {
      expect(sanitizeFilename("report-2024.final.pdf")).toBe("report-2024.final.pdf");
    });

    it("caps a 300-character name at 255 UTF-8 bytes", () => {
      const result = sanitizeFilename(`${"a".repeat(300)}.txt`);
      expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
      expect(result.endsWith(".txt")).toBe(true);
      expect(result.length).toBe(255);
    });

    it("caps a name at 255 bytes while preserving the extension", () => {
      const result = sanitizeFilename(`${"x".repeat(400)}.pdf`);
      expect(Buffer.byteLength(result, "utf-8")).toBe(MAX_FILENAME_BYTES);
      expect(result.endsWith(".pdf")).toBe(true);
    });

    it("caps multibyte CJK names by bytes, not code points", () => {
      const result = sanitizeFilename(`${"測試中文字".repeat(200)}.txt`);
      expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
      expect(result.endsWith(".txt")).toBe(true);
      expect(result).not.toContain("�");
    });

    it("caps emoji names without splitting a surrogate pair", () => {
      const result = sanitizeFilename(`${"🎉🎊".repeat(200)}.bin`);
      expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
      expect(result.endsWith(".bin")).toBe(true);
      expect(result).not.toContain("�");
    });
  });

  describe("saveFile", () => {
    it("writes the file and sidecar to the room directory", async () => {
      const meta = await storage.saveFile(
        "default",
        await stageFile(storage, "hello world"),
        "hello.txt",
        11,
        "text/plain",
        "tester",
        null
      );
      expect(meta.id).toBeTruthy();
      expect(meta.originalName).toBe("hello.txt");
      expect(meta.size).toBe(11);
      expect(meta.expiresAt).toBeNull();
      const onDisk = await readFile(join(dir, "default", meta.storedName), "utf-8");
      expect(onDisk).toBe("hello world");
      const sidecar = JSON.parse(
        await readFile(join(dir, "default", `${meta.id}.meta.json`), "utf-8")
      );
      expect(sidecar.originalName).toBe("hello.txt");
    });

    it("computes expiresAt from the expiry duration", async () => {
      const meta = await storage.saveFile(
        "default",
        await stageFile(storage, "x"),
        "x.txt",
        1,
        "text/plain",
        "t",
        60000
      );
      const expires = new Date(meta.expiresAt).getTime();
      expect(expires).toBeGreaterThan(Date.now());
      expect(expires).toBeLessThanOrEqual(Date.now() + 61000);
    });

    it("rejects files larger than the per-file limit", async () => {
      const big = { buffer: Buffer.alloc(MAX_FILE_SIZE + 1) };
      await expect(
        storage.saveFile(
          "default",
          big,
          "big.bin",
          MAX_FILE_SIZE + 1,
          "application/octet-stream",
          "t",
          null
        )
      ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    });

    it("rejects invalid room IDs", async () => {
      await expect(
        storage.saveFile(
          "../evil",
          await stageFile(storage, "x"),
          "x.txt",
          1,
          "text/plain",
          "t",
          null
        )
      ).rejects.toMatchObject({ code: "INVALID_ID" });
    });
  });

  describe("readFile / getFile / updateFile", () => {
    it("returns a stream and metadata for an existing file", async () => {
      const meta = await storage.saveFile(
        "default",
        await stageFile(storage, "stream me"),
        "s.txt",
        8,
        "text/plain",
        "t",
        null
      );
      const { stream, metadata } = await storage.readFile("default", meta.id);
      expect(stream).toBeTruthy();
      expect(metadata.id).toBe(meta.id);
      stream.destroy();
    });

    it("throws FILE_NOT_FOUND for a missing file", async () => {
      await expect(storage.readFile("default", "nope")).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
      });
      await expect(storage.getFile("default", "nope")).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
      });
    });

    it("updates metadata and persists it to the sidecar", async () => {
      const meta = await storage.saveFile(
        "default",
        await stageFile(storage, "abc"),
        "a.txt",
        3,
        "text/plain",
        "t",
        null
      );
      const updated = await storage.updateFile("default", meta.id, {
        note: "team doc",
        pinned: true,
      });
      expect(updated.note).toBe("team doc");
      expect(updated.pinned).toBe(true);
      const sidecar = JSON.parse(
        await readFile(join(dir, "default", `${meta.id}.meta.json`), "utf-8")
      );
      expect(sidecar.note).toBe("team doc");
      const listed = await storage.listFiles("default");
      expect(listed[0].pinned).toBe(true);
    });
  });

  describe("listFiles / deleteFile", () => {
    it("lists files for a room and an empty room", async () => {
      await storage.saveFile(
        "default",
        await stageFile(storage, "one"),
        "one.txt",
        3,
        "text/plain",
        "t",
        null
      );
      await storage.saveFile(
        "default",
        await stageFile(storage, "two"),
        "two.txt",
        3,
        "text/plain",
        "t",
        null
      );
      const files = await storage.listFiles("default");
      expect(files).toHaveLength(2);
      expect(await storage.listFiles("empty-room")).toHaveLength(0);
    });

    it("deletes the file and its sidecar", async () => {
      const meta = await storage.saveFile(
        "default",
        await stageFile(storage, "bye"),
        "bye.txt",
        3,
        "text/plain",
        "t",
        null
      );
      await storage.deleteFile("default", meta.id);
      await expect(storage.getFile("default", meta.id)).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
      });
      await expect(readFile(join(dir, "default", `${meta.id}.meta.json`))).rejects.toThrow();
      expect(await storage.listFiles("default")).toHaveLength(0);
    });
  });

  describe("rebuildIndexFromDisk", () => {
    it("reconstructs metadata from sidecars after a restart", async () => {
      const meta = await storage.saveFile(
        "default",
        await stageFile(storage, "persist me"),
        "p.txt",
        10,
        "text/plain",
        "t",
        null
      );

      const fresh = new Storage(dir, MAX_FILE_SIZE, MAX_STORAGE);
      await fresh.rebuildIndexFromDisk();
      const files = await fresh.listFiles("default");
      expect(files).toHaveLength(1);
      expect(files[0].id).toBe(meta.id);
      expect(files[0].originalName).toBe("p.txt");
      expect(fresh.calculateTotalSize()).toBe(10);
    });

    it("skips corrupted sidecar files gracefully", async () => {
      await mkdir(join(dir, "default"), { recursive: true });
      await writeFile(join(dir, "default", "bad.meta.json"), "not json {");
      const fresh = new Storage(dir, MAX_FILE_SIZE, MAX_STORAGE);
      await expect(fresh.rebuildIndexFromDisk()).resolves.toBeUndefined();
      expect(await fresh.listFiles("default")).toHaveLength(0);
    });

    it("handles a missing uploads directory on first start", async () => {
      const missing = join(dir, "does-not-exist");
      const fresh = new Storage(missing, MAX_FILE_SIZE, MAX_STORAGE);
      await expect(fresh.rebuildIndexFromDisk()).resolves.toBeUndefined();
    });
  });

  describe("calculateTotalSize", () => {
    it("sums file sizes across rooms", async () => {
      expect(storage.calculateTotalSize()).toBe(0);
      await storage.saveFile(
        "default",
        await stageFile(storage, "12345"),
        "a.txt",
        5,
        "text/plain",
        "t",
        null
      );
      await storage.saveFile(
        "default",
        await stageFile(storage, "123"),
        "b.txt",
        3,
        "text/plain",
        "t",
        null
      );
      await storage.saveFile(
        "other",
        await stageFile(storage, "1"),
        "c.txt",
        1,
        "text/plain",
        "t",
        null
      );
      expect(storage.calculateTotalSize()).toBe(9);
    });
  });
});
