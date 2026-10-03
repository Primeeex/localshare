/**
 * Transfer routes (send-to-device feature).
 * @module routes/transfers
 */

import { Router } from "express";
import mime from "mime-types";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Create transfer routes.
 * @param {Object} deps
 * @param {import('../storage').Storage} deps.storage
 * @param {import('../rooms.js').RoomManager} deps.rooms
 * @param {import('../sse.js').SSEManager} deps.sse
 * @param {import('../logger.js').Logger} deps.logger
 * @param {Object} deps.config
 * @returns {Router}
 */
export default function createTransfersRouter(deps) {
  const router = Router({ mergeParams: true });
  const { storage, rooms, logger } = deps;

  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const { fileId, targetDeviceId } = req.body || {};
      if (!fileId || !targetDeviceId) {
        throw new AppError("fileId and targetDeviceId are required", "INVALID_BODY", 400);
      }

      // Verify source file exists (throws FILE_NOT_FOUND)
      await storage.getFile(req.params.roomId, fileId);

      // Verify target device is connected
      const devices = rooms.getDevices(req.params.roomId);
      const target = devices.find((d) => d.id === targetDeviceId);
      if (!target) {
        throw new AppError("Target device is not connected", "DEVICE_NOT_FOUND", 404);
      }

      const sourceDeviceId = req.headers["x-device-id"] || "unknown";
      const sourceDeviceName = req.headers["x-device-name"] || "Anonymous";

      const transfer = rooms.createTransfer(req.params.roomId, {
        fileId,
        sourceDeviceId,
        sourceDeviceName,
        targetDeviceId,
      });

      logger.info(
        { roomId: req.params.roomId, transferId: transfer.id, target: targetDeviceId },
        "Transfer initiated"
      );
      res.status(201).json(transfer);
    })
  );

  router.patch(
    "/:transferId",
    asyncRoute(async (req, res) => {
      const { action } = req.body || {};
      if (!action || !["accept", "decline"].includes(action)) {
        throw new AppError('Action must be "accept" or "decline"', "INVALID_BODY", 400);
      }

      const transfer = rooms.handleTransfer(req.params.roomId, req.params.transferId, action);
      res.json(transfer);
    })
  );

  router.get(
    "/:transferId/download",
    asyncRoute(async (req, res) => {
      const transfer = rooms.getTransfer(req.params.roomId, req.params.transferId);
      if (!transfer) {
        throw new AppError("Transfer not found", "TRANSFER_NOT_FOUND", 404);
      }
      if (transfer.status !== "accepted") {
        throw new AppError("Transfer not accepted", "TRANSFER_EXPIRED", 410);
      }
      // Verify target device matches requestor
      if (transfer.targetDeviceId !== req.headers["x-device-id"]) {
        throw new AppError("Access denied", "FORBIDDEN", 403);
      }

      const { stream, metadata } = await storage.readFile(req.params.roomId, transfer.fileId);
      const mimeType = mime.lookup(metadata.originalName) || "application/octet-stream";
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${metadata.originalName}"`);
      res.setHeader("Content-Length", metadata.size);
      // WHY: mark consumed so a second download returns 410, not the file again
      transfer.status = "downloaded";
      stream.pipe(res);
    })
  );

  return router;
}
