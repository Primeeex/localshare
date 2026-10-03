/**
 * Request ID middleware: attaches a unique ID to every request.
 * @module middleware/requestId
 */

import { randomUUID } from "node:crypto";

/**
 * Create request ID middleware.
 * @returns {Function} Express middleware
 */
export function requestIdMiddleware() {
  return (req, res, next) => {
    req.id = randomUUID();
    next();
  };
}
