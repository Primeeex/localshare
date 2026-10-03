/**
 * Device presence routes.
 * @module routes/devices
 */

import { Router } from "express";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Create device routes.
 * @param {Object} deps
 * @param {import('../rooms.js').RoomManager} deps.rooms
 * @param {import('../logger.js').Logger} deps.logger
 * @returns {Router}
 */
export default function createDevicesRouter(deps) {
  const router = Router({ mergeParams: true });
  const { rooms, logger } = deps;

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const devices = rooms.getDevices(req.params.roomId);
      res.json(devices);
    })
  );

  router.patch(
    "/:deviceId",
    asyncRoute(async (req, res) => {
      const { name } = req.body || {};
      if (!name || typeof name !== "string") {
        throw new AppError("Device name is required", "INVALID_BODY", 400);
      }
      const device = rooms.updateDevice(req.params.roomId, req.params.deviceId, name);
      if (!device) {
        throw new AppError("Device not found", "DEVICE_NOT_FOUND", 404);
      }
      logger.info(
        { roomId: req.params.roomId, deviceId: req.params.deviceId, name },
        "Device renamed"
      );
      res.json(device);
    })
  );

  return router;
}
