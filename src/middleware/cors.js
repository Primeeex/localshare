/**
 * CORS middleware for LocalShare (local network only).
 * @module middleware/cors
 */

/**
 * Create CORS middleware that allows requests from any origin (LAN use case).
 * @returns {Function} Express middleware
 */
export function corsMiddleware() {
  return (req, res, next) => {
    // WHY: LAN tool, so CORS is permissive; clients are on the same network
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Device-Id, X-Device-Name, X-Room-Pin"
    );
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    next();
  };
}
