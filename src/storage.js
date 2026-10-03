/**
 * File storage abstraction: in-memory index + disk persistence with sidecar metadata.
 * @module storage
 */

import { mkdir, writeFile, readFile, access, unlink, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Sanitize a filename to prevent path traversal and invalid characters.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  // WHY: strip path components and disallow dangerous characters
  const sanitized = name.replace(/[/\\:*?"<>|]/g, "_").replace(/\.\./g, "");
  // WHY: ensure non-empty result; fallback to unnamed_file
  return sanitized || "unnamed_file";
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
   * Save an uploaded file to disk and add it to the index.
   * @param {string} roomId
   * @param {Object} file - File metadata from multer
   * @param {string} originalName
   * @param {number} size
   * @param {string} mimeType
   * @param {string} uploadedBy
   * @param {number|null} expiryMs - Duration until expiry, or null for never
   * @returns {Promise<Object>} The saved file metadata
   */
  async saveFile(roomId, file, originalName, size, mimeType, uploadedBy, expiryMs) {
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
    const storedName = `${fileId}-${sanitizeFilename(originalName)}`;
    const expiresAt = expiryMs ? new Date(Date.now() + expiryMs).toISOString() : null;

    const roomDir = await this.ensureRoomDir(roomId);
    const destPath = join(roomDir, storedName);

    // WHY: stream file directly from multer buffer to disk
    await writeFile(destPath, file.buffer);

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
    await writeFile(metaPath, JSON.stringify(meta, null, 2));

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
