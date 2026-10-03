/**
 * Text sharing routes.
 * @module routes/text
 */

import { Router } from "express";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";
import { randomUUID } from "node:crypto";

const MAX_TEXT_LENGTH = 100_000;
const MAX_TEXT_ENTRIES = 50;

/**
 * Create text routes.
 * @param {Object} deps
 * @param {import('../rooms.js').RoomManager} deps.rooms
 * @param {import('../sse.js').SSEManager} deps.sse
 * @param {import('../logger.js').Logger} deps.logger
 * @param {number} expiryMs
 * @returns {Router}
 */
export default function createTextRouter(deps) {
  const router = Router({ mergeParams: true });
  const { rooms, sse, logger } = deps;

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const room = rooms.getRoom(req.params.roomId);
      const entries = Array.from(room.textEntries?.values() || []);
      res.json(entries);
    })
  );

  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const { content, label } = req.body || {};
      if (!content || typeof content !== "string") {
        throw new AppError("Content is required", "INVALID_BODY", 400);
      }
      if (content.length > MAX_TEXT_LENGTH) {
        throw new AppError(
          `Content exceeds maximum length of ${MAX_TEXT_LENGTH} characters`,
          "TEXT_TOO_LONG",
          400
        );
      }

      const room = rooms.getRoom(req.params.roomId);
      // Enforce max entries: remove oldest non-pinned if at limit
      const entries = Array.from(room.textEntries?.values() || []);
      if (entries.length >= MAX_TEXT_ENTRIES) {
        const nonPinned = entries
          .filter((e) => !e.pinned)
          .sort((a, b) => new Date(a.sharedAt) - new Date(b.sharedAt));
        if (nonPinned.length > 0) {
          const oldest = nonPinned[0];
          room.textEntries.delete(oldest.id);
          sse.broadcast(req.params.roomId, "text:deleted", { entryId: oldest.id });
        }
      }

      const entry = {
        id: randomUUID().slice(0, 8),
        roomId: req.params.roomId,
        content,
        label: label || null,
        sharedAt: new Date().toISOString(),
        sharedBy: req.headers["x-device-id"] || "anonymous",
        sharedByName: req.headers["x-device-name"] || "Anonymous",
        expiresAt: deps.config?.expiry
          ? new Date(Date.now() + deps.config.expiry).toISOString()
          : null,
        pinned: false,
        size: content.length,
      };

      if (!room.textEntries) room.textEntries = new Map();
      room.textEntries.set(entry.id, entry);
      room.lastActivityAt = new Date().toISOString();

      sse.broadcast(req.params.roomId, "text:added", { entry });
      logger.info({ roomId: req.params.roomId, entryId: entry.id }, "Text entry shared");
      res.status(201).json(entry);
    })
  );

  router.patch(
    "/:id",
    asyncRoute(async (req, res) => {
      const room = rooms.getRoom(req.params.roomId);
      const entry = room.textEntries?.get(req.params.id);
      if (!entry) {
        throw new AppError("Text entry not found", "TEXT_NOT_FOUND", 404);
      }
      const { content, label } = req.body || {};
      if (content !== undefined) {
        if (content.length > MAX_TEXT_LENGTH) {
          throw new AppError(
            `Content exceeds maximum length of ${MAX_TEXT_LENGTH} characters`,
            "TEXT_TOO_LONG",
            400
          );
        }
        entry.content = content;
        entry.size = content.length;
      }
      if (label !== undefined) entry.label = label;
      entry.updatedAt = new Date().toISOString();

      sse.broadcast(req.params.roomId, "text:updated", { entry });
      res.json(entry);
    })
  );

  router.delete(
    "/:id",
    asyncRoute(async (req, res) => {
      const room = rooms.getRoom(req.params.roomId);
      if (!room.textEntries?.has(req.params.id)) {
        throw new AppError("Text entry not found", "TEXT_NOT_FOUND", 404);
      }
      room.textEntries.delete(req.params.id);
      sse.broadcast(req.params.roomId, "text:deleted", { entryId: req.params.id });
      logger.info({ roomId: req.params.roomId, entryId: req.params.id }, "Text entry deleted");
      res.status(204).end();
    })
  );

  return router;
}
