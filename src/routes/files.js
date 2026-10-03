/**
 * File upload and download routes.
 * @module routes/files
 */

import { Router } from "express";
import multer from "multer";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import mime from "mime-types";
import archiver from "archiver";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Create file routes.
 * @param {Object} deps
 * @param {import('../storage').Storage} deps.storage
 * @param {import('../rooms.js').RoomManager} deps.rooms
 * @param {import('../logger.js').Logger} deps.logger
 * @param {Object} deps.config
 * @returns {Router}
 */
export default function createFilesRouter(deps) {
  const router = Router({ mergeParams: true });
  const { storage, rooms, sse, logger, config } = deps;

  // WHY: multer config for file uploads
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxFileSize,
      files: 10, // max files per request
    },
  });

  // List files in a room
  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const files = await storage.listFiles(req.params.roomId);
      res.json(files);
    })
  );

  // Download all files as ZIP (must be declared before /:fileId routes)
  router.get(
    "/zip",
    asyncRoute(async (req, res) => {
      const files = await storage.listFiles(req.params.roomId);

      // Check total ZIP size
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > 4 * 1024 * 1024 * 1024) {
        // WHY: 4GB ZIP limit
        res.setHeader("X-Warning", "Too large to ZIP. Download files individually.");
        throw new AppError("Total file size exceeds 4GB ZIP limit", "STORAGE_FULL", 413);
      }

      const zipName = `localshare-${req.params.roomId}-${new Date().toISOString().slice(0, 10)}.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("warning", () => {});
      archive.on("error", (err) => {
        throw err;
      });
      archive.pipe(res);

      // WHY: an empty room still returns a valid (empty) zip, never an error
      const nameCount = new Map();
      for (const file of files) {
        let name = file.originalName;
        if (nameCount.has(name)) {
          const count = nameCount.get(name) + 1;
          const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
          const base = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
          name = `${base}-${count}${ext}`;
          nameCount.set(file.originalName, count);
        } else {
          nameCount.set(name, 1);
        }
        try {
          const { stream } = await storage.readFile(req.params.roomId, file.id);
          archive.append(stream, { name });
        } catch {
          // Skip missing files
        }
      }

      await archive.finalize();
      logger.info({ roomId: req.params.roomId, count: files.length }, "ZIP download started");
    })
  );

  // Upload files
  router.post(
    "/",
    upload.array("files[]", 10),
    asyncRoute(async (req, res) => {
      const roomId = req.params.roomId;
      // WHY: validate room exists
      rooms.getRoom(roomId);

      // WHY: at least one file is required
      if (!req.files || req.files.length === 0) {
        throw new AppError(
          'At least one file is required (field name "files[]")',
          "INVALID_BODY",
          400
        );
      }

      // WHY: check max files per room
      const currentFiles = await storage.listFiles(roomId);
      if (currentFiles.length + req.files.length > config.maxFilesPerRoom) {
        throw new AppError(
          `Room has reached the maximum of ${config.maxFilesPerRoom} files. Delete some files before uploading more.`,
          "ROOM_FULL",
          409
        );
      }

      // WHY: check total storage
      const totalSize = storage.calculateTotalSize();
      for (const file of req.files) {
        if (totalSize + file.size > config.maxStorage) {
          throw new AppError("Storage limit exceeded", "STORAGE_FULL", 507);
        }
      }

      const uploadedBy = req.headers["x-device-name"] || "Anonymous";
      const results = [];

      for (const file of req.files) {
        try {
          const meta = await storage.saveFile(
            roomId,
            file,
            file.originalname,
            file.size,
            file.mimetype || "application/octet-stream",
            uploadedBy,
            config.expiry
          );
          results.push(meta);
          logger.info(
            { roomId, fileId: meta.id, name: meta.originalName, size: meta.size, by: uploadedBy },
            "File uploaded"
          );
          // Broadcast to room via SSE
          sse?.broadcast(roomId, "file:added", { file: meta, by: uploadedBy });
        } catch (err) {
          if (err.code === "ENOSPC") {
            throw new AppError("Disk full", "STORAGE_FULL", 507);
          }
          throw err;
        }
      }

      res.status(201).json(results.length === 1 ? results[0] : results);
    })
  );

  // Get file metadata
  router.get(
    "/:fileId",
    asyncRoute(async (req, res) => {
      const meta = await storage.getFile(req.params.roomId, req.params.fileId);
      res.json(meta);
    })
  );

  // Update file metadata (note, pinned, expiresAt)
  router.patch(
    "/:fileId",
    asyncRoute(async (req, res) => {
      const { note, pinned, expiresAt } = req.body || {};
      const meta = await storage.updateFile(req.params.roomId, req.params.fileId, {
        ...(note !== undefined && { note }),
        ...(pinned !== undefined && { pinned }),
        ...(expiresAt !== undefined && { expiresAt }),
      });
      // Broadcast update via SSE
      logger.info({ roomId: req.params.roomId, fileId: meta.id }, "File updated");
      sse?.broadcast(req.params.roomId, "file:updated", { file: meta });
      res.json(meta);
    })
  );

  // Delete file
  router.delete(
    "/:fileId",
    asyncRoute(async (req, res) => {
      await storage.deleteFile(req.params.roomId, req.params.fileId);
      logger.info({ roomId: req.params.roomId, fileId: req.params.fileId }, "File deleted");
      sse?.broadcast(req.params.roomId, "file:deleted", { fileId: req.params.fileId });
      res.status(204).end();
    })
  );

  // Download file
  router.get(
    "/:fileId/download",
    asyncRoute(async (req, res) => {
      const { stream, metadata } = await storage.readFile(req.params.roomId, req.params.fileId);
      // Increment download count
      await storage.updateFile(req.params.roomId, req.params.fileId, {
        downloadCount: metadata.downloadCount + 1,
      });
      const mimeType = mime.lookup(metadata.originalName) || "application/octet-stream";
      // WHY: set response headers for download
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${metadata.originalName}"`);
      res.setHeader("Content-Length", metadata.size);
      // Support range requests for resumable downloads
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : metadata.size - 1;
        const chunkSize = Math.min(end - start + 1, 1024 * 1024); // 1MB chunks
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${metadata.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": mimeType,
        });
        stream.destroy(); // discard original stream
        const partialStream = createReadStream(
          join(storage.uploadsDir, req.params.roomId, metadata.storedName),
          { start, end }
        );
        partialStream.pipe(res);
        return;
      }
      stream.pipe(res);
    })
  );

  // Preview file (inline)
  router.get(
    "/:fileId/preview",
    asyncRoute(async (req, res) => {
      const { stream, metadata } = await storage.readFile(req.params.roomId, req.params.fileId);
      const mimeType = mime.lookup(metadata.originalName) || "application/octet-stream";
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `inline; filename="${metadata.originalName}"`);
      stream.pipe(res);
    })
  );

  return router;
}
