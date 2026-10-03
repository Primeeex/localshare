/**
 * Global error handler for LocalShare.
 * @module middleware/errorHandler
 */

import { randomUUID } from "node:crypto";

/**
 * Known application error class.
 */
export class AppError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} status
   * @param {Object} [details] - Extra fields merged into the error response
   */
  constructor(message, code, status = 400, details = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// WHY: only expose codes from the documented list; anything else is INTERNAL_ERROR
const KNOWN_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_LOCKED",
  "FILE_TOO_LARGE",
  "STORAGE_FULL",
  "FILE_NOT_FOUND",
  "ROOM_NOT_FOUND",
  "ROOM_LIMIT_REACHED",
  "INVALID_BODY",
  "TEXT_TOO_LONG",
  "DEVICE_NOT_FOUND",
  "TRANSFER_NOT_FOUND",
  "TRANSFER_EXPIRED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "FORBIDDEN",
  "NOT_FOUND",
]);

/**
 * Translate well-known middleware errors (multer, body parser) into
 * documented LocalShare error codes and statuses.
 * @param {Error} err
 * @returns {Error}
 */
function normalizeError(err) {
  if (err?.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      return new AppError("File exceeds the maximum allowed size", "FILE_TOO_LARGE", 413);
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return new AppError("Too many files in one request", "INVALID_BODY", 400);
    }
    return new AppError(err.message, "INVALID_BODY", 400);
  }
  if (err?.type === "entity.parse.failed") {
    return new AppError("Request body is not valid JSON", "INVALID_BODY", 400);
  }
  if (err?.type === "entity.too.large") {
    return new AppError("Request body is too large", "INVALID_BODY", 413);
  }
  return err;
}

/**
 * Format an error response.
 * @param {Error} err
 * @param {string} reqId
 * @param {boolean} isDevelopment
 * @returns {Object}
 */
function formatError(err, reqId, isDevelopment) {
  // Known codes pass through; other 4xx app codes stay readable; everything
  // else collapses to INTERNAL_ERROR so fs/system codes never leak.
  const is4xx = err.status >= 400 && err.status < 500;
  const code = KNOWN_CODES.has(err.code)
    ? err.code
    : is4xx && /^[A-Z][A-Z_]*$/.test(err.code || "")
      ? err.code
      : "INTERNAL_ERROR";
  const response = {
    error: {
      code,
      message: err.message || "Internal server error",
      requestId: reqId,
      timestamp: new Date().toISOString(),
      ...(err.details || {}),
    },
  };
  // WHY: include stack trace only in development
  if (isDevelopment && err.stack) {
    response.error.stack = err.stack;
  }
  return response;
}

/**
 * Create the global error handler middleware.
 * @param {boolean} isDevelopment
 * @returns {Function} Express error handler
 */
export function createErrorHandler(isDevelopment = false) {
  return (err, req, res, _next) => {
    const normalized = normalizeError(err);
    const reqId = req.id || randomUUID();
    const status = normalized.status || 500;
    const body = formatError(normalized, reqId, isDevelopment);

    if (status >= 500) {
      // Best-effort: surface unexpected errors in logs
      console.error("[localshare]", normalized);
    }
    if (res.headersSent) {
      // WHY: streaming responses (SSE, downloads) cannot receive a JSON body
      console.error("[localshare] stream error", { requestId: reqId, ...body.error });
      res.destroy();
      return;
    }
    res.status(status).json(body);
  };
}
