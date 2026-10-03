/**
 * File expiry and cleanup scheduler.
 * @module cleanup
 */

/**
 * Cleanup manager for LocalShare.
 */
export class CleanupManager {
  /**
   * @param {import('./storage').Storage} storage
   * @param {import('./rooms.js').RoomManager} rooms
   * @param {import('./sse.js').SSEManager} sse
   * @param {import('./logger.js').Logger} logger
   */
  constructor(storage, rooms, sse, logger) {
    this.storage = storage;
    this.rooms = rooms;
    this.sse = sse;
    this.logger = logger;
    this._interval = null;
  }

  /**
   * Start the cleanup interval (runs every 60 seconds).
   */
  start() {
    this._interval = setInterval(() => this._run(), 60000);
    // WHY: run immediately on start to catch any expired files from before restart
    this._run();
  }

  /**
   * Stop the cleanup interval.
   */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /**
   * Run the cleanup sweep.
   */
  async _run() {
    try {
      const now = new Date();
      for (const [roomId, fileMap] of this.storage.index.entries()) {
        for (const [fileId, file] of fileMap.entries()) {
          // Skip pinned files
          if (file.pinned) continue;
          // Check expiry
          if (file.expiresAt && new Date(file.expiresAt) <= now) {
            await this._deleteExpiredFile(roomId, fileId, file);
          }
        }
      }
    } catch (err) {
      this.logger.warn({ error: err.message }, "Cleanup job failed");
    }
  }

  /**
   * Delete an expired file and notify clients.
   * @param {string} roomId
   * @param {string} fileId
   * @param {Object} file
   */
  async _deleteExpiredFile(roomId, fileId, file) {
    try {
      await this.storage.deleteFile(roomId, fileId);
      this.sse.broadcast(roomId, "file:deleted", { fileId });
      this.logger.debug({ roomId, fileId, name: file.originalName }, "Expired file cleaned up");
    } catch (err) {
      this.logger.warn({ roomId, fileId, error: err.message }, "Failed to clean up expired file");
    }
  }
}
