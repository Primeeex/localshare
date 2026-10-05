/**
 * Authentication routes (PIN entry, logout, status).
 * @module routes/auth
 */

import { Router } from "express";
import { asyncRoute } from "../middleware/asyncRoute.js";
import {
  verifyPin,
  signSession,
  checkLockout,
  recordFailedAttempt,
  getRateLimit,
  SESSION_COOKIE_NAME,
} from "../auth.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Create auth routes.
 * @param {Object} deps
 * @param {Object} deps.config
 * @param {import('../logger.js').Logger} deps.logger
 * @returns {Router}
 */
export default function createAuthRouter(deps) {
  const router = Router();
  const { config, logger } = deps;

  // WHY: auth routes are public (no session check needed)
  router.post(
    "/verify",
    asyncRoute(async (req, res) => {
      const { pin } = req.body || {};
      if (!pin || typeof pin !== "string") {
        throw new AppError("PIN is required", "INVALID_BODY", 400);
      }

      const ip = req.ip || req.connection.remoteAddress;
      const lockout = checkLockout(ip);
      if (lockout.locked) {
        throw new AppError(
          `Too many failed attempts. Try again in ${Math.ceil(lockout.remainingMs / 1000)} seconds.`,
          "AUTH_LOCKED",
          429
        );
      }

      // WHY: compare against stored PIN hash from config
      if (!config.pin || !verifyPin(pin, config.pin)) {
        const result = recordFailedAttempt(ip);
        if (result.locked) {
          logger.warn({ ip, lockoutDuration: result.lockoutDuration }, "Auth locked out");
          throw new AppError(
            `Too many failed attempts. Try again in ${Math.ceil((result.lockoutDuration || 30000) / 1000)} seconds.`,
            "AUTH_LOCKED",
            429,
            {
              retriesLeft: 0,
              lockoutDuration: result.lockoutDuration ?? null,
              permanent: false,
            }
          );
        }
        throw new AppError("Incorrect PIN", "AUTH_INVALID", 401, {
          retriesLeft: result.retriesLeft,
        });
      }

      // Clear rate limit on success
      const state = getRateLimit(ip);
      if (state) {
        state.failures = 0;
        state.lockedUntil = null;
      }

      const session = signSession({ verified: true });
      res.cookie(SESSION_COOKIE_NAME, session, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
      logger.info({ ip }, "Auth successful");
      res.json({ success: true });
    })
  );

  router.post(
    "/logout",
    asyncRoute(async (req, res) => {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.json({ success: true });
    })
  );

  router.get(
    "/status",
    asyncRoute(async (req, res) => {
      const authenticated = !!req.session;
      res.json({
        authenticated,
        pinRequired: !!config.pin,
      });
    })
  );

  return router;
}
