/**
 * Clipboard sync routes.
 * @module routes/clipboard
 */

import { Router } from "express";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";
import { randomUUID } from "node:crypto";

const CLIPBOARD_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CLIPBOARD_ENTRIES = 10;

/**
 * Create clipboard routes.
 * @param {Object} deps
 * @param {import('../rooms.js').RoomManager} deps.rooms
 * @param {import('../sse.js').SSEManager} deps.sse
 * @param {import('../logger.js').Logger} deps.logger
 * @returns {Router}
 */
export default function createClipboardRouter(deps) {
  const router = Router({ mergeParams: true });
  const { rooms, sse, logger } = deps;

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const room = rooms.getRoom(req.params.roomId);
      const entries = Array.from(room.clipboardEntries || []);
      res.json(entries);
    })
  );

  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const { content, type = "text", label } = req.body || {};
      if (!content || typeof content !== "string") {
        throw new AppError("Content is required", "INVALID_BODY", 400);
      }
      if (content.length > 5000) {
        throw new AppError(
          "Content exceeds maximum length of 5000 characters",
          "INVALID_BODY",
          400
        );
      }

      const room = rooms.getRoom(req.params.roomId);
      if (!room.clipboardEntries) room.clipboardEntries = [];

      // Remove expired entries
      room.clipboardEntries = room.clipboardEntries.filter(
        (e) => new Date(e.expiresAt) > new Date()
      );

      // Cap at MAX_CLIPBOARD_ENTRIES
      if (room.clipboardEntries.length >= MAX_CLIPBOARD_ENTRIES) {
        room.clipboardEntries.shift(); // remove oldest
      }

      const entry = {
        id: randomUUID().slice(0, 8),
        roomId: req.params.roomId,
        content,
        type,
        label: label || null,
        sharedAt: new Date().toISOString(),
        sharedBy: req.headers["x-device-id"] || "anonymous",
        sharedByName: req.headers["x-device-name"] || "Anonymous",
        expiresAt: new Date(Date.now() + CLIPBOARD_TTL_MS).toISOString(),
        size: content.length,
      };

      room.clipboardEntries.push(entry);
      room.lastActivityAt = new Date().toISOString();

      sse.broadcast(req.params.roomId, "clipboard:updated", { entry });
      logger.info({ roomId: req.params.roomId, entryId: entry.id }, "Clipboard entry shared");
      res.status(201).json(entry);
    })
  );

  router.delete(
    "/:id",
    asyncRoute(async (req, res) => {
      const room = rooms.getRoom(req.params.roomId);
      const idx = room.clipboardEntries?.findIndex((e) => e.id === req.params.id) ?? -1;
      if (idx === -1) {
        throw new AppError("Clipboard entry not found", "CLIPBOARD_NOT_FOUND", 404);
      }
      room.clipboardEntries.splice(idx, 1);
      sse.broadcast(req.params.roomId, "clipboard:deleted", { entryId: req.params.id });
      res.status(204).end();
    })
  );

  return router;
}
