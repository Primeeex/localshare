/**
 * Room management routes.
 * @module routes/rooms
 */

import { Router } from "express";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { hashPin } from "../auth.js";

/**
 * Create room routes.
 * @param {Object} deps
 * @param {import('../rooms.js').RoomManager} deps.rooms
 * @param {import('../logger.js').Logger} deps.logger
 * @returns {Router}
 */
export default function createRoomsRouter(deps) {
  const router = Router();
  const { rooms, logger } = deps;

  router.get(
    "/",
    asyncRoute(async (_req, res) => {
      res.json(rooms.listRooms());
    })
  );

  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const { pin } = req.body || {};
      if (pin) {
        // WHY: store room PIN as hash, not plaintext
        req.body.pin = hashPin(pin);
      }
      const room = rooms.createRoom(req.body || {});
      logger.info({ roomId: room.id, name: room.name }, "Room created via API");
      res.status(201).json(room);
    })
  );

  router.get(
    "/:roomId",
    asyncRoute(async (req, res) => {
      const room = rooms.getRoom(req.params.roomId);
      const deviceList = rooms.getDevices(req.params.roomId);
      res.json({
        ...room,
        deviceCount: deviceList.length,
        devices: deviceList,
      });
    })
  );

  router.patch(
    "/:roomId",
    asyncRoute(async (req, res) => {
      const { pin, ...updates } = req.body || {};
      if (pin) {
        updates.pin = hashPin(pin);
      }
      const room = rooms.updateRoom(req.params.roomId, updates);
      logger.info({ roomId: room.id }, "Room updated");
      res.json(room);
    })
  );

  router.delete(
    "/:roomId",
    asyncRoute(async (req, res) => {
      rooms.deleteRoom(req.params.roomId);
      logger.info({ roomId: req.params.roomId }, "Room deleted");
      res.status(204).end();
    })
  );

  return router;
}
