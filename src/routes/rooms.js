/**
 * Room management routes.
 * @module routes/rooms
 */

import { Router } from "express";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";
import { hashPin } from "../auth.js";

/**
 * Spec 6.17: a room display name is "editable, max 32 chars". The UI enforces
 * this, but the server must too - the UI is not a trust boundary.
 */
const MAX_ROOM_NAME_LENGTH = 32;

/**
 * Validate a room name supplied by a client.
 * @param {*} name
 * @returns {string|undefined} The trimmed name, or undefined when not supplied
 * @throws {AppError} When the name is present but invalid
 */
function validateRoomName(name) {
  if (name === undefined || name === null) return undefined;
  if (typeof name !== "string") {
    throw new AppError("Room name must be a string", "INVALID_BODY", 400);
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new AppError("Room name cannot be empty", "INVALID_BODY", 400);
  }
  if (trimmed.length > MAX_ROOM_NAME_LENGTH) {
    throw new AppError(
      `Room name must be ${MAX_ROOM_NAME_LENGTH} characters or fewer`,
      "INVALID_BODY",
      400
    );
  }
  return trimmed;
}

/**
 * Strip the fields that must never leave the server.
 *
 * WHY: `room.pin` is a scrypt hash. Echoing it would hand an attacker a
 * verifiable offline target, so only a boolean flag about its presence is
 * ever serialized. `files` is an internal Map and has no JSON meaning either.
 * @param {Object} room
 * @returns {Object}
 */
function serializeRoom(room) {
  // WHY: `files` is destructured out as well as `pin` - it is an internal Map
  // with no meaning in JSON, while `pin` must never be echoed as a hash.
  const { pin, files: _files, ...rest } = room;
  return { ...rest, hasPin: Boolean(pin) };
}

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
      const name = validateRoomName(req.body?.name);
      // WHY the explicit allowlist: spreading req.body forwarded every
      // client-supplied field into createRoom, letting a caller set `id` and
      // clobber an existing room, or inject arbitrary keys into the stored
      // room object that later got serialized back out. Only name and pin are
      // ever client-controlled here.
      const options = {};
      if (name !== undefined) options.name = name;
      if (pin !== undefined && pin !== null && String(pin).trim() !== "") {
        const candidate = String(pin).trim();
        // WHY validate the strength here, not only at the server level.
        // `config.js` enforces /^\d{4,8}$/ for the *server* PIN, but a room
        // PIN bypassed it entirely and accepted any string -- including "1".
        // A one-character room PIN is recovered in a single request, which
        // makes the "room is the door" control (spec 12) decorative. Same rule,
        // same error code, so the client renders one consistent message.
        if (!/^\d{4,8}$/.test(candidate)) {
          throw new AppError("Room PIN must be 4-8 digits", "VALIDATION_ERROR", 400, {
            field: "pin",
          });
        }
        // WHY store room PIN as hash, not plaintext
        options.pin = hashPin(candidate);
      }
      const room = rooms.createRoom(options);
      logger.info({ roomId: room.id, name: room.name }, "Room created via API");
      res.status(201).json(serializeRoom(room));
    })
  );

  router.get(
    "/:roomId",
    asyncRoute(async (req, res) => {
      const room = rooms.getRoom(req.params.roomId);
      const deviceList = rooms.getDevices(req.params.roomId);
      res.json({
        ...serializeRoom(room),
        deviceCount: deviceList.length,
        devices: deviceList,
      });
    })
  );

  router.patch(
    "/:roomId",
    asyncRoute(async (req, res) => {
      const { pin, ...rest } = req.body || {};
      // WHY the explicit allowlist (see POST "/"): only name and pin are
      // client-editable, so id/createdAt/files can never be overwritten.
      const updates = {};
      const name = validateRoomName(rest.name);
      if (name !== undefined) updates.name = name;
      if (pin !== undefined && pin !== null && String(pin).trim() !== "") {
        updates.pin = hashPin(String(pin).trim());
      }
      const room = rooms.updateRoom(req.params.roomId, updates);
      logger.info({ roomId: room.id }, "Room updated");
      res.json(serializeRoom(room));
    })
  );

  router.delete(
    "/:roomId",
    asyncRoute(async (req, res) => {
      await rooms.deleteRoom(req.params.roomId);
      logger.info({ roomId: req.params.roomId }, "Room deleted");
      res.status(204).end();
    })
  );

  return router;
}
