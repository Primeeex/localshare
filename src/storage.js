/**
 * File storage abstraction: in-memory index + disk persistence with sidecar metadata.
 *
 * Uploads are never held in memory: multer streams every multipart part into
 * the staging directory and Storage only ever moves (rename) those finished
 * files into their room directory. Spec 19 "DO NOT read entire files into
 * memory. Always stream."
 * @module storage
 */

import {
  mkdir,
  writeFile,
  readFile,
  access,
  unlink,
  rename,
  copyFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Hard cap for a stored filename, in UTF-8 bytes (spec 18 "DoS Protection").
 */
export const MAX_FILENAME_BYTES = 255;

/**
 * Directory (inside the uploads root) that in-flight uploads are streamed into.
 * A leading dot keeps it out of the room namespace and out of the rebuild
 * sweep, which only indexes directories that contain sidecar files.
 */
const TEMP_DIR_NAME = ".tmp";

/**
 * Truncate a filename to a byte budget without splitting a UTF-8 code point
 * and without losing the extension.
 * @param {string} name
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToBytes(name, maxBytes) {
  const bytes = Buffer.from(name, "utf-8");
  if (bytes.length <= maxBytes) return name;

  // WHY: keep the extension so "report.<very long>.pdf" stays a .pdf
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0;
  const ext = hasExt ? name.slice(dot) : "";
  const stem = hasExt ? name.slice(0, dot) : name;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ext, "utf-8"));

  // WHY: Buffer#toString turns a split multi-byte sequence into U+FFFD, so
  // dropping the trailing replacement chars lands the cut on a code point.
  const cut = Buffer.from(stem, "utf-8").subarray(0, budget).toString("utf-8").replace(/�+$/, "");
  return `${cut}${ext}` || "unnamed_file";
}

/**
 * Sanitize a filename to prevent path traversal and invalid characters,
 * then cap it at {@link MAX_FILENAME_BYTES} UTF-8 bytes.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  // WHY: strip path components and disallow dangerous characters
  const sanitized = name.replace(/[/\\:*?"<>|]/g, "_").replace(/\.\./g, "");
  // WHY: ensure non-empty result; fallback to unnamed_file
  const safe = sanitized || "unnamed_file";
  return truncateToBytes(safe, MAX_FILENAME_BYTES);
}

/**
 * Build the on-disk name `<fileId>-<safeName>`, kept within the filesystem
 * limit so a maximal safeName can never produce an ENAMETOOLONG write.
 * @param {string} fileId
 * @param {string} safeName - Already sanitized and length-capped
 * @returns {string}
 */
function buildStoredName(fileId, safeName) {
  const prefix = `${fileId}-`;
  return `${prefix}${truncateToBytes(safeName, MAX_FILENAME_BYTES - prefix.length)}`;
}

/**
 * Move a staged upload into its final location without reading it.
 * @param {string} sourcePath - Absolute path of the staged file
 * @param {string} destPath - Absolute destination path
 * @returns {Promise<void>}
 */
async function promoteTempFile(sourcePath, destPath) {
  try {
    await rename(sourcePath, destPath);
    return;
  } catch (err) {
    // WHY EXDEV: the staging directory and the room directory can sit on
    // different mounts, where rename is not allowed. Fall back to a copy.
    if (err.code !== "EXDEV") throw err;
  }
  await copyFile(sourcePath, destPath);
  try {
    await unlink(sourcePath);
  } catch {
    /* already gone */
  }
}

/**
 * Validate an ID against the allowed pattern.
 * @param {string} id
 * @returns {boolean}
 */
function isValidId(id) {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(id);
}

/**
 * Storage manager for LocalShare files.
 */
export class Storage {
  /**
   * @param {string} uploadsDir - Absolute path to the uploads directory
   * @param {number} maxFileSize - Maximum file size in bytes
   * @param {number} maxStorage - Maximum total storage in bytes
   */
  constructor(uploadsDir, maxFileSize, maxStorage) {
    this.uploadsDir = resolve(uploadsDir);
    this.maxFileSize = maxFileSize;
    this.maxStorage = maxStorage;
    // Map<roomId, Map<fileId, FileMetadata>>
    this.index = new Map();
    // Track total bytes used per room
    this.storageUsed = new Map();
  }

  /**
   * Ensure the uploads directory and a room's subdirectory exist.
   * @param {string} roomId
   */
  async ensureRoomDir(roomId) {
    const roomDir = join(this.uploadsDir, roomId);
    await mkdir(roomDir, { recursive: true });
    return roomDir;
  }

  /**
   * Absolute path of the staging directory used for in-flight uploads.
   * @returns {string}
   */
  getTempDir() {
    return join(this.uploadsDir, TEMP_DIR_NAME);
  }

  /**
   * Ensure the staging directory exists.
   * @returns {Promise<string>} The staging directory path
   */
  async ensureTempDir() {
    const tempDir = this.getTempDir();
    await mkdir(tempDir, { recursive: true });
    return tempDir;
  }

  /**
   * Remove a staged upload that never made it into a room directory.
   * Never throws: a file that was already promoted away is a success here.
   * @param {string} tempPath - Absolute path of the staged file
   * @returns {Promise<boolean>} True when a file was actually removed
   */
  async discardTempFile(tempPath) {
    try {
      await unlink(tempPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a room's whole upload directory and drop it from the index.
   * Missing directories are not an error.
   * @param {string} roomId
   * @returns {Promise<void>}
   */
  async removeRoomDir(roomId) {
    this.index.delete(roomId);
    this.storageUsed.delete(roomId);
    await rm(join(this.uploadsDir, roomId), { recursive: true, force: true });
  }

  /**
   * Save an uploaded file to disk and add it to the index.
   *
   * WHY a source path and not a buffer: the multipart body is streamed into
   * the staging directory by multer, so this call only promotes the finished
   * bytes with a rename. The file is never fully resident in memory.
   *
   * @param {string} roomId
   * @param {string} sourcePath - Absolute path of the staged (already written) file
   * @param {string} originalName
   * @param {number} size
   * @param {string} mimeType
   * @param {string} uploadedBy
   * @param {number|null} expiryMs - Duration until expiry, or null for never
   * @returns {Promise<Object>} The saved file metadata
   */
  async saveFile(roomId, sourcePath, originalName, size, mimeType, uploadedBy, expiryMs) {
    if (!isValidId(roomId))
      throw Object.assign(new Error("Invalid room ID"), { code: "INVALID_ID", status: 400 });
    // WHY: enforce per-file limit at the storage layer too, not just multer
    if (size > this.maxFileSize) {
      throw Object.assign(
        new Error(`File exceeds the maximum allowed size of ${this.maxFileSize} bytes`),
        { code: "FILE_TOO_LARGE", status: 413 }
      );
    }
    const fileId = randomUUID().slice(0, 10);
    const storedName = buildStoredName(fileId, sanitizeFilename(originalName));
    const expiresAt = expiryMs ? new Date(Date.now() + expiryMs).toISOString() : null;

    const roomDir = await this.ensureRoomDir(roomId);
    const destPath = join(roomDir, storedName);

    // WHY: the bytes are already on disk, so promoting an upload is a move
    await promoteTempFile(sourcePath, destPath);

    // Write sidecar metadata
    const meta = {
      id: fileId,
      roomId,
      originalName,
      storedName,
      mimeType,
      size,
      uploadedAt: new Date().toISOString(),
      uploadedBy,
      expiresAt,
      note: null,
      downloadCount: 0,
      pinned: false,
    };
    const metaPath = join(roomDir, `${fileId}.meta.json`);
    try {
      await writeFile(metaPath, JSON.stringify(meta, null, 2));
    } catch (err) {
      // WHY: never leave an unindexed blob behind - the cleanup sweep only
      // ever walks the in-memory index
      await unlink(destPath).catch(() => {});
      throw err;
    }

    // Update in-memory index
    await this._addToIndex(roomId, meta);
    return meta;
  }

  /**
   * Read a file's contents as a readable stream.
   * @param {string} roomId
   * @param {string} fileId
   * @returns {Promise<{stream: import('node:stream').Readable, metadata: Object}>}
   */
  async readFile(roomId, fileId) {
    const meta = await this._getMeta(roomId, fileId);
    const filePath = join(this.uploadsDir, roomId, meta.storedName);
    try {
      await access(filePath);
    } catch {
      throw Object.assign(new Error(`File not found: ${fileId}`), {
        code: "FILE_NOT_FOUND",
        status: 404,
      });
    }
    const stream = createReadStream(filePath);
    return { stream, metadata: meta };
  }

  /**
   * Delete a file and its sidecar metadata from disk and index.
   * @param {string} roomId
   * @param {string} fileId
   */
  async deleteFile(roomId, fileId) {
    const meta = await this._getMeta(roomId, fileId);
    const roomDir = join(this.uploadsDir, roomId);
    const filePath = join(roomDir, meta.storedName);
    const metaPath = join(roomDir, `${fileId}.meta.json`);

    // WHY: use safe unlink that ignores ENOENT
    // WHY: safe unlink ignores ENOENT when the file is already gone
    try {
      await unlink(filePath);
    } catch {
      /* already removed */
    }
    try {
      await unlink(metaPath);
    } catch {
      /* already removed */
    }

    await this._removeFromIndex(roomId, fileId);
  }

  /**
   * List all files in a room.
   * @param {string} roomId
   * @returns {Promise<Object[]>}
   */
  async listFiles(roomId) {
    const room = this.index.get(roomId);
    if (!room) return [];
    return Array.from(room.values());
  }

  /**
   * Get metadata for a single file.
   * @param {string} roomId
   * @param {string} fileId
   * @returns {Promise<Object>}
   */
  async getFile(roomId, fileId) {
    return this._getMeta(roomId, fileId);
  }

  /**
   * Update file metadata (note, pinned, expiresAt).
   * @param {string} roomId
   * @param {string} fileId
   * @param {Object} updates
   * @returns {Promise<Object>}
   */
  async updateFile(roomId, fileId, updates) {
    const meta = await this._getMeta(roomId, fileId);
    const updated = { ...meta, ...updates };
    // WHY: re-save metadata to sidecar for persistence
    const metaPath = join(this.uploadsDir, roomId, `${fileId}.meta.json`);
    await writeFile(metaPath, JSON.stringify(updated, null, 2));
    await this._updateInIndex(roomId, fileId, updated);
    return updated;
  }

  /**
   * Rebuild the in-memory index from disk on server startup.
   */
  async rebuildIndexFromDisk() {
    this.index.clear();
    this.storageUsed.clear();

    try {
      const roomIds = await readdir(this.uploadsDir);
      for (const roomId of roomIds) {
        // WHY: the staging directory is not a room and must never be indexed
        if (roomId === TEMP_DIR_NAME) continue;
        const roomPath = join(this.uploadsDir, roomId);
        const stats = await stat(roomPath);
        if (!stats.isDirectory()) continue;

        const files = new Map();
        let roomSize = 0;
        const entries = await readdir(roomPath);

        for (const entry of entries) {
          // WHY: only process .meta.json files to reconstruct index
          if (!entry.endsWith(".meta.json")) continue;
          const metaPath = join(roomPath, entry);
          try {
            const raw = await readFile(metaPath, "utf-8");
            const meta = JSON.parse(raw);
            meta.size = meta.size || 0; // fallback
            files.set(meta.id, meta);
            roomSize += meta.size;
          } catch {
            // Skip corrupted sidecar files
          }
        }

        if (files.size > 0) {
          this.index.set(roomId, files);
          this.storageUsed.set(roomId, roomSize);
        }
      }
    } catch (err) {
      // Uploads dir may not exist yet on first start
      if (err.code !== "ENOENT") throw err;
    }
  }

  /**
   * Calculate total storage used across all rooms.
   * @returns {number}
   */
  calculateTotalSize() {
    let total = 0;
    for (const size of this.storageUsed.values()) total += size;
    return total;
  }

  // --- Private helpers ---

  async _getMeta(roomId, fileId) {
    const room = this.index.get(roomId);
    if (!room || !room.has(fileId)) {
      throw Object.assign(new Error(`File not found: ${fileId}`), {
        code: "FILE_NOT_FOUND",
        status: 404,
      });
    }
    return room.get(fileId);
  }

  async _addToIndex(roomId, meta) {
    if (!this.index.has(roomId)) {
      this.index.set(roomId, new Map());
      this.storageUsed.set(roomId, 0);
    }
    const room = this.index.get(roomId);
    room.set(meta.id, meta);
    this.storageUsed.set(roomId, (this.storageUsed.get(roomId) || 0) + meta.size);
  }

  async _removeFromIndex(roomId, fileId) {
    const room = this.index.get(roomId);
    if (!room) return;
    const meta = room.get(fileId);
    if (meta) {
      room.delete(fileId);
      this.storageUsed.set(roomId, Math.max(0, (this.storageUsed.get(roomId) || 0) - meta.size));
    }
  }

  async _updateInIndex(roomId, fileId, updated) {
    const room = this.index.get(roomId);
    if (!room) return;
    const existing = room.get(fileId);
    if (existing) {
      const sizeDiff = updated.size - existing.size;
      room.set(fileId, updated);
      this.storageUsed.set(roomId, Math.max(0, (this.storageUsed.get(roomId) || 0) + sizeDiff));
    }
  }
}
