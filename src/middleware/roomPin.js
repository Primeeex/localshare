/**
 * Room-level PIN enforcement.
 *
 * A room can carry its own PIN, independent of the server PIN (spec 12). When
 * a room has one, joining it over SSE and every API call scoped to it require
 * that PIN. Rooms without a PIN never reach the compare, so the default path
 * costs nothing and needs no headers at all.
 * @module middleware/roomPin
 */

import { verifyPin } from "../auth.js";
import { AppError } from "./errorHandler.js";

/**
 * Guess budget for the PIN itself, per (room, client).
 *
 * WHY this lives here and not on the mounted router: `verifyPin` derives with
 * scrypt, which is deliberately expensive (~35ms of blocking CPU). Mounted
 * afterwards, a general request limiter is useless -- by the time a request is
 * counted the key derivation has already been paid, so the limiter protects
 * the counter but not the server. `/events` is mounted at the app root, outside
 * the `/api` limiter entirely, which left unlimited PIN guesses available.
 *
 * Only FAILURES are charged. A generic limiter counts every request, which for
 * a correct PIN would mean locking a legitimate client out of its own room
 * after ten API calls. Generous enough that a fat-fingered human is never
 * locked out mid-session, tight enough that online guessing stops being viable.
 */
const PIN_GUESS_MAX = 10;
const PIN_GUESS_WINDOW_MS = 5 * 60 * 1000;

/**
 * Failed-attempt ledger. One entry per (room, client) pair that has actually
 * guessed wrong, pruned on access so the map cannot grow without bound.
 * @type {Map<string, {count: number, resetAt: number}>}
 */
const guessLedger = new Map();

/**
 * Whether this client still has PIN guesses left for this room.
 * @param {string} key
 * @returns {boolean}
 */
function hasBudget(key) {
  const now = Date.now();
  for (const [k, v] of guessLedger) {
    if (now > v.resetAt) guessLedger.delete(k);
  }
  const record = guessLedger.get(key);
  if (!record || now > record.resetAt) return true;
  return record.count < PIN_GUESS_MAX;
}

/**
 * Charge one failed guess against a client's budget.
 * @param {string} key
 */
function chargeGuess(key) {
  const now = Date.now();
  const record = guessLedger.get(key);
  if (!record || now > record.resetAt) {
    guessLedger.set(key, { count: 1, resetAt: now + PIN_GUESS_WINDOW_MS });
    return;
  }
  record.count++;
}

/**
 * Read the room PIN candidate from a request.
 *
 * WHY the query fallback exists: `EventSource` cannot set request headers, so an
 * SSE client has no other way to present the PIN. It is deliberately scoped to
 * the SSE route -- every other route has a working header channel, and a PIN in
 * a query string ends up in browser history, proxy access logs and `Referer`.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function readRoomPin(req) {
  const header = req.headers["x-room-pin"];
  if (typeof header === "string" && header.length > 0) return header;
  const isSse = req.path === "/events" || req.originalUrl?.split("?")[0] === "/events";
  if (isSse) {
    const query = req.query?.roomPin;
    if (typeof query === "string" && query.length > 0) return query;
  }
  return null;
}

/**
 * Resolve the room id from either an API path param or the SSE query string.
 * @param {import('express').Request} req
 * @returns {string}
 */
function resolveRoomId(req) {
  return req.params?.roomId || req.query?.roomId || "default";
}

/**
 * Create the room PIN guard.
 *
 * WHY a no-op for unknown rooms: a missing room is a 404 that the route
 * handlers already produce. Neither case can be judged against a PIN that does
 * not exist yet, so the guard defers instead of inventing an error.
 *
 * @param {import('../rooms.js').RoomManager} rooms
 * @returns {Function} Express middleware
 */
export function roomPinGuard(rooms) {
  return (req, res, next) => {
    const roomId = resolveRoomId(req);
    let room = null;
    try {
      room = rooms.getRoom(roomId);
    } catch {
      return next();
    }
    if (!room.pin) return next();

    const candidate = readRoomPin(req);
    if (!candidate) {
      return next(
        new AppError("Room PIN required", "AUTH_REQUIRED", 401, { roomId, requiresRoomPin: true })
      );
    }

    // Checked BEFORE deriving: the budget has to stop the scrypt call from
    // happening, not merely reject its result afterwards.
    const key = `${roomId}|${req.ip}`;
    if (!hasBudget(key)) {
      const retryAfter = Math.ceil(PIN_GUESS_WINDOW_MS / 1000);
      res.setHeader("Retry-After", retryAfter);
      return next(
        new AppError("Too many incorrect PIN attempts. Try again later.", "RATE_LIMITED", 429, {
          roomId,
        })
      );
    }

    // WHY: verifyPin derives with scrypt and compares with timingSafeEqual
    if (!verifyPin(candidate, room.pin)) {
      chargeGuess(key);
      return next(new AppError("Incorrect room PIN", "AUTH_INVALID", 401, { roomId }));
    }
    return next();
  };
}
