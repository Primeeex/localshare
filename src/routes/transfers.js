/**
 * Transfer routes (send-to-device feature).
 * @module routes/transfers
 */

import { Router } from "express";
import mime from "mime-types";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";
import { encodeRFC5987 } from "./files.js";

/**
 * Identify the device making a request.
 *
 * WHY the query fallback: the transfer download is triggered by a top-level
 * navigation (`window.location.href = url`), because downloads must stream to
 * disk rather than being buffered into a JS blob -- a 500 MB video would OOM a
 * phone. A navigation cannot set request headers, so the required
 * `X-Device-Id` was simply absent and EVERY accepted transfer then failed the
 * device check with 403 "Access denied". This mirrors the roomPin fallback,
 * which exists for exactly the same reason on /events.
 *
 * The device id is not a credential: it is a self-declared localStorage value
 * already sent in cleartext on every API call, so the query form adds no
 * meaningful exposure. It is redacted from the request log all the same.
 *
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
function requesterDeviceId(req) {
  return req.headers["x-device-id"] || req.query.deviceId || undefined;
}

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
      const metadata = await storage.getFile(req.params.roomId, fileId);

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
        // WHY carried through: spec 6.19 has the modal read "[QuickFox] wants to
        // send you: photo.jpg (2.3 MB)". Without the name and size on the
        // transfer, the recipient could not tell what they were accepting --
        // it rendered as "wants to send you a file." and nothing else.
        originalName: metadata.originalName,
        size: metadata.size,
        mimeType: metadata.mimeType,
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

      const transfer = rooms.handleTransfer(
        req.params.roomId,
        req.params.transferId,
        action,
        requesterDeviceId(req)
      );
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
      if (transfer.targetDeviceId !== requesterDeviceId(req)) {
        throw new AppError("Access denied", "FORBIDDEN", 403);
      }

      const { stream, metadata } = await storage.readFile(req.params.roomId, transfer.fileId);
      const mimeType = mime.lookup(metadata.originalName) || "application/octet-stream";
      res.setHeader("Content-Type", mimeType);
      // WHY the encoder: originalName is attacker-controlled. Interpolating it
      // straight into `filename="..."` lets a name containing a quote inject
      // extra header parameters, and a CRLF in the name splits the response.
      res.setHeader("Content-Disposition", `attachment; ${encodeRFC5987(metadata.originalName)}`);
      res.setHeader("Content-Length", metadata.size);
      // WHY: mark consumed so a second download returns 410, not the file again.
      // Set only once the read succeeds, so a failure mid-stream does not burn
      // the recipient's one and only copy of the file.
      transfer.status = "downloaded";
      stream.on("error", (err) => {
        logger.error({ err, transferId: transfer.id }, "Transfer download stream failed");
        if (!res.headersSent) res.status(500);
        res.destroy(err);
      });
      stream.pipe(res);
    })
  );

  return router;
}
