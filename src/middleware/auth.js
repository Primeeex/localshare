/**
 * Authentication middleware: checks PIN session cookie.
 * @module middleware/auth
 */

import { verifySession, SESSION_COOKIE_NAME } from "../auth.js";
import { AppError } from "./errorHandler.js";

/**
 * Create auth middleware.
 * @param {boolean} pinRequired
 * @returns {Function} Express middleware
 */
export function authMiddleware(pinRequired) {
  // WHY: these must answer before login so the PIN page can boot and submit
  const PUBLIC_API = new Set(["/api/auth/verify", "/api/auth/status", "/api/server/health"]);

  return (req, res, next) => {
    if (!pinRequired) return next();

    const cookie = req.cookies?.[SESSION_COOKIE_NAME];
    const session = cookie ? verifySession(cookie) : null;
    if (session) {
      req.session = session;
      return next();
    }

    const isApi = req.path.startsWith("/api/") || req.path === "/events";
    // WHY: HTML and static routes pass through unauthenticated; the SPA
    // fallback serves pin.html so no app markup leaks before login
    if (!isApi || PUBLIC_API.has(req.path)) return next();

    return next(
      new AppError(cookie ? "Invalid session" : "Authentication required", "AUTH_REQUIRED", 401)
    );
  };
}
