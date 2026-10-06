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
 * Slow-read mitigation from spec 18: a client that stops reading mid-download
 * must not be able to hold a socket open indefinitely.
 */
const DOWNLOAD_SOCKET_TIMEOUT_MS = 30000;

/** Cap on a free-text per-file note, matching the client-side field. */
const MAX_NOTE_LENGTH = 500;

/**
 * Types that may be rendered inline in a browser tab without becoming active
 * content on this origin. Deliberately narrow: plain text, raster images and
 * media. Anything scriptable, document-shaped or unknown is an attachment.
 */
const INLINE_SAFE_MIME =
  /^(text\/plain|image\/(png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|wav|webm))$/i;

/**
 * RFC 5987 filename so non-ASCII names survive the header, with an ASCII
 * fallback for clients that only understand the plain `filename=`.
 * @param {string} name
 * @returns {string}
 */
export function encodeRFC5987(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // WHY the extra escaping: encodeURIComponent leaves !'()* unescaped, and RFC
  // 5987 attr-char excludes ' ( ) and *. An unescaped quote in particular
  // terminates the filename* value early, so everything after it is parsed as
  // garbage or dropped.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Parse and clamp a single-range `Range: bytes=` header (RFC 9110 14.1.1).
 *
 * Returns the clamped inclusive bounds, or null when the range is malformed
 * or unsatisfiable -- the caller answers 416. Clamping to the real file size
 * is what stops a resume from advertising bytes that will never arrive, and
 * what stops a 20-byte file from holding a socket open for a declared 1 MB.
 *
 * @param {string} header raw Range header
 * @param {number} size total file size in bytes
 * @returns {{start: number, end: number} | null}
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || size <= 0) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null; // no "bytes=-500" suffix form
  let start;
  let end;
  if (rawStart === "") {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start < 0 || end < start) return null;
  // Clamp: a client may ask past EOF (very common with `bytes=0-`), and we must
  // serve what actually exists rather than what it hoped for.
  if (start >= size) return null;
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Cap a slow-reading socket and restore the previous timeout once the
 * response is done, so the keep-alive socket returns to the server default.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function applySlowReadTimeout(req, res) {
  const socket = req.socket;
  if (!socket) return;
  // WHY: socket.timeout is undefined until setTimeout has been called once,
  // and 0 is the "no timeout" default a fresh socket already has
  const previous = typeof socket.timeout === "number" ? socket.timeout : 0;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    socket.setTimeout(previous);
  };
  socket.setTimeout(DOWNLOAD_SOCKET_TIMEOUT_MS);
  res.once("finish", restore);
  res.once("close", restore);
}

/**
 * Remove every staged upload that was not promoted into a room directory.
 * Runs on both the success and the failure path, so a rejected request never
 * leaves an orphan file behind (spec 19: nothing may be buffered in memory,
 * and the staging area must not grow without bound).
 * @param {Object[]} files - Multer file descriptors
 * @param {import('../storage').Storage} storage
 * @param {import('../logger.js').Logger} logger
 * @returns {Promise<void>}
 */
async function discardStagedUploads(files, storage, logger) {
  for (const file of files) {
    if (!file || typeof file.path !== "string") continue;
    // WHY: a promoted upload was renamed away, so "not removed" means the
    // bytes are already owned by a room - nothing left to clean up.
    if (!(await storage.discardTempFile(file.path))) continue;
    logger.debug({ path: file.path }, "Removed staged upload");
  }
}

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

  // WHY: diskStorage, not memoryStorage - spec 19 forbids holding a whole file
  // in memory. Multipart parts stream straight into the staging directory and
  // are only renamed into the room directory once every check has passed.
  const upload = multer({
    storage: multer.diskStorage({ destination: storage.getTempDir() }),
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
        // NEVER rethrow from an EventEmitter listener. A `throw` here becomes
        // an uncaughtException, which the process-level handler turns into a
        // full graceful shutdown -- so one aborted or corrupt ZIP download
        // would take the entire share offline for everyone.
        logger.error({ err, roomId: req.params.roomId }, "Archive failed");
        if (!res.headersSent) {
          res.status(500);
          res.end();
        } else {
          res.destroy(err);
        }
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
      // WHY: multer streamed every part into the staging directory; nothing has
      // been promoted into the room yet, so this is the complete set of paths
      // that must be removed if any check below rejects the request.
      const staged = req.files || [];
      const results = [];
      try {
        // WHY: validate room exists
        rooms.getRoom(roomId);

        // WHY: at least one file is required
        if (staged.length === 0) {
          throw new AppError(
            'At least one file is required (field name "files[]")',
            "INVALID_BODY",
            400
          );
        }

        // WHY: check max files per room
        const currentFiles = await storage.listFiles(roomId);
        if (currentFiles.length + staged.length > config.maxFilesPerRoom) {
          throw new AppError(
            `This room has reached the maximum of ${config.maxFilesPerRoom} files. Delete some files before uploading more.`,
            "ROOM_FULL",
            409
          );
        }

        // WHY: check total storage.
        // The running total MUST advance inside the loop. Comparing every file
        // against the same pre-request base let a single multi-file POST write
        // up to files x maxFileSize in one request -- with the shipped
        // defaults (10 files x 2 GB against a 10 GB quota) that is 2x the
        // configured storage limit in a single call, every time.
        let totalSize = storage.calculateTotalSize();
        for (const file of staged) {
          if (totalSize + file.size > config.maxStorage) {
            throw new AppError("Storage limit exceeded", "STORAGE_FULL", 507);
          }
          totalSize += file.size;
        }

        const uploadedBy = req.headers["x-device-name"] || "Anonymous";

        for (const file of staged) {
          try {
            const meta = await storage.saveFile(
              roomId,
              file.path,
              file.originalname,
              file.size,
              // WHY: spec 18 - the stored MIME type comes from the filename,
              // never from the client-declared multipart part type.
              mime.lookup(file.originalname) || "application/octet-stream",
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
      } finally {
        // WHY: a rejected or partially failed upload must never leave staged
        // bytes on disk. Promoted files are already gone from staging, so the
        // unlink simply reports ENOENT for them.
        await discardStagedUploads(staged, storage, logger);
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
      // Validate the expiry controls. Unvalidated they are a way to make files
      // immortal: `expiresAt: null` (or any non-date string, since
      // `new Date("x") <= now` is false) makes the reaper skip the file
      // forever, and `pinned: true` skips it outright -- so any room member
      // could defeat the configured --expiry and fill the disk permanently.
      const patch = {};
      if (note !== undefined) {
        if (typeof note !== "string") {
          throw new AppError("note must be a string", "VALIDATION_ERROR", 400);
        }
        if (note.length > MAX_NOTE_LENGTH) {
          throw new AppError("note too long", "VALIDATION_ERROR", 400);
        }
        patch.note = note;
      }
      if (pinned !== undefined) {
        if (typeof pinned !== "boolean") {
          throw new AppError("pinned must be a boolean", "VALIDATION_ERROR", 400);
        }
        patch.pinned = pinned;
      }
      if (expiresAt !== undefined) {
        if (expiresAt === null) {
          patch.expiresAt = null; // an explicit, documented "never"
        } else {
          // A string is required, not just a parseable value: `new Date(12345)`
          // is a perfectly valid 1970 timestamp, so a bare number would be
          // silently coerced into "expired since the epoch".
          if (typeof expiresAt !== "string") {
            throw new AppError(
              "expiresAt must be an ISO 8601 date string or null",
              "VALIDATION_ERROR",
              400
            );
          }
          const when = new Date(expiresAt);
          if (Number.isNaN(when.getTime())) {
            throw new AppError("expiresAt must be a valid ISO 8601 date", "VALIDATION_ERROR", 400);
          }
          patch.expiresAt = when.toISOString();
        }
      }
      const meta = await storage.updateFile(req.params.roomId, req.params.fileId, patch);
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
      applySlowReadTimeout(req, res);
      // Increment download count
      await storage.updateFile(req.params.roomId, req.params.fileId, {
        downloadCount: metadata.downloadCount + 1,
      });
      const mimeType = mime.lookup(metadata.originalName) || "application/octet-stream";
      // WHY: set response headers for download
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `attachment; ${encodeRFC5987(metadata.originalName)}`);
      res.setHeader("Accept-Ranges", "bytes");
      // Support range requests for resumable downloads
      const range = req.headers.range;
      if (range) {
        // A range MUST be validated before a single header is written. The old
        // code wrote headers first and then let createReadStream throw, which
        // destroyed the socket instead of returning a clean 416 -- and it
        // advertised a Content-Range far larger than the bytes actually sent,
        // so a resumable client recorded a truncated file as complete.
        const size = metadata.size;
        const parsed = parseRange(range, size);
        if (!parsed) {
          stream.destroy();
          res.setHeader("Content-Range", `bytes */${size}`);
          throw new AppError("Requested range not satisfiable", "RANGE_NOT_SATISFIABLE", 416);
        }
        const { start, end } = parsed;
        stream.destroy(); // discard original stream
        const partialStream = createReadStream(
          join(storage.uploadsDir, req.params.roomId, metadata.storedName),
          { start, end }
        );
        // WHY headers before writeHead so a stream error still routes through
        // the error handler cleanly, and the stream owns the response from here.
        partialStream.on("error", (err) => {
          if (!res.headersSent) throw err;
          res.destroy(err);
        });
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": mimeType,
        });
        partialStream.pipe(res);
        return;
      }
      res.setHeader("Content-Length", metadata.size);
      stream.pipe(res);
    })
  );

  // Preview file (inline)
  router.get(
    "/:fileId/preview",
    asyncRoute(async (req, res) => {
      const { stream, metadata } = await storage.readFile(req.params.roomId, req.params.fileId);
      applySlowReadTimeout(req, res);
      // SECURITY: only a short allowlist of types that a browser cannot execute
      // may be rendered inline. Everything else -- text/html, image/svg+xml,
      // application/javascript, application/pdf, anything unknown -- is forced
      // to octet-stream + attachment.
      //
      // Without this, uploading `p.html` (which pulls in `p.js` via
      // <script src="/api/rooms/x/files/y/preview">) and sharing the link runs
      // attacker JavaScript on this app's own origin. CSP does not stop it:
      // script-src 'self' is exactly the origin the attacker can write to.
      const mimeType = mime.lookup(metadata.originalName) || "";
      const inlineSafe = INLINE_SAFE_MIME.test(mimeType);
      res.setHeader("Content-Type", inlineSafe ? mimeType : "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `${inlineSafe ? "inline" : "attachment"}; ${encodeRFC5987(metadata.originalName)}`
      );
      // Belt and braces: even if a future allowed type turns out to be active,
      // deny it every capability that could reach the page's own origin.
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (inlineSafe) res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      stream.pipe(res);
    })
  );

  return router;
}
