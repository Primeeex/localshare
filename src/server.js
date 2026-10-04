/**
 * Express app factory for LocalShare.
 * Returns { app, start, stop } and does NOT call listen() directly.
 * This allows test suite to create isolated server instances.
 * @module server
 */

import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import createRouter from "./routes/index.js";
import createEventsRoute from "./routes/events.js";
import { createErrorHandler } from "./middleware/errorHandler.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { corsMiddleware } from "./middleware/cors.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rateLimit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create and configure the Express application.
 * @param {Object} config
 * @param {import('./storage').Storage} storage
 * @param {import('./rooms.js').RoomManager} rooms
 * @param {import('./sse.js').SSEManager} sse
 * @param {import('./logger.js').Logger} logger
 * @param {import('./network.js').NetworkInfo} networkInfo
 * @returns {{ app: import('express').Express, start: (port: number) => Promise<void>, stop: () => void }}
 */
export function createApp(config, storage, rooms, sse, logger, networkInfo) {
  const app = express();
  const isDevelopment = config.logLevel === "debug" || config.logLevel === "trace";

  // WHY: security headers via helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // WHY the hash: spec 6.10 requires an inline <script> in <head> to
          // apply the stored theme before first paint, while spec "HTTP
          // Headers" requires script-src 'self'. Hash-allowlisting the exact
          // script bytes satisfies both without 'unsafe-inline'. The same
          // script also contains the blank-page reveal watchdog. If the
          // inline head script in public/{index,pin}.html changes, recompute
          // (guarded by test/integration/text.test.js).
          scriptSrc: ["'self'", "'sha256-hwOnfDL+aKkYywy1Cgz6kqp14sZA0uHb0KX9V4GjKt4='"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          // WHY disable: helmet's default `upgrade-insecure-requests` rewrites
          // every relative URL (/css/*, /js/*) to https:// on non-localhost
          // hosts. LocalShare serves plain HTTP on the LAN, so opening
          // http://<lan-ip>:3000 upgraded all subresources to https:// and they
          // died with ERR_SSL_PROTOCOL_ERROR - unstyled page, #app never
          // revealed (only the skip link visible). Chrome exempts localhost
          // (a potentially-trustworthy origin), which masked the bug there.
          // Spec 18 "HTTP Headers (helmet)" does not include this directive.
          upgradeInsecureRequests: null,
        },
      },
      // WHY: spec 18 requires X-Frame-Options: DENY (helmet default is
      // SAMEORIGIN).
      frameguard: { action: "deny" },
    })
  );

  // WHY: CORS for LAN access
  app.use(corsMiddleware());

  // WHY: request ID for tracing
  app.use(requestIdMiddleware());

  // WHY: cookie parsing for session management
  app.use(cookieParser());

  // WHY: JSON body parser with size limit
  app.use(express.json({ limit: "100kb" }));

  // WHY: static file serving for public/ directory
  // WHY index:false: directory requests must fall through to the fallback so
  // unauthenticated "/" receives pin.html instead of index.html
  const publicDir = resolve(__dirname, "..", "public");
  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders: (res, path) => {
        // WHY: cache static assets aggressively
        if (path.endsWith(".js") || path.endsWith(".css")) {
          res.setHeader("Cache-Control", "public, max-age=3600");
        }
      },
    })
  );

  // Auth middleware (only when PIN is required)
  app.use(authMiddleware(!!config.pin));

  // Rate limiting for API routes (disable in tests via config.rateLimit === false)
  if (config.rateLimit !== false) {
    app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
    app.use(
      "/api/auth/verify",
      rateLimit({ windowMs: 60 * 1000, max: 5, keyGenerator: (req) => req.ip })
    );
    app.use(
      "/api/:roomId/files",
      rateLimit({ windowMs: 60 * 1000, max: 10, keyGenerator: (req) => req.ip })
    );
  }

  // WHY: request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.info(
        {
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          duration,
          reqId: req.id,
          userAgent: (req.headers["user-agent"] || "").slice(0, 80),
        },
        "Request completed"
      );
    });
    next();
  });

  // API routes
  app.use(
    "/api",
    createRouter({
      storage,
      rooms,
      sse,
      logger,
      config,
      networkInfo,
    })
  );

  // SSE events endpoint (needs special handling)
  const eventsHandler = createEventsRoute({
    storage,
    rooms,
    sse,
    logger,
    config,
  });
  app.get("/events", eventsHandler);

  // Fallback: serve index.html for SPA routing.
  // WHY app.all: a non-GET request to an unknown API path would otherwise fall
  // through to Express' default handler and return an HTML error page instead
  // of the documented JSON error envelope.
  // WHY the PIN gate: unauthenticated HTML requests get pin.html so the app
  // markup is never handed out before the session cookie exists.
  app.all("*", (req, res) => {
    const isApi = req.path.startsWith("/api/") || req.path.startsWith("/events");
    if (isApi || req.method !== "GET") {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "Endpoint not found",
          requestId: req.id,
          timestamp: new Date().toISOString(),
        },
      });
    }
    const needsAuth = Boolean(config.pin) && !req.session;
    res.sendFile(resolve(publicDir, needsAuth ? "pin.html" : "index.html"));
  });

  // Global error handler (must be last)
  app.use(createErrorHandler(isDevelopment));

  /**
   * Start the HTTP server.
   * @param {number} port
   * @returns {Promise<import('node:http').Server>}
   */
  async function start(port) {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, config.host, () => {
        app.server = server;
        logger.info({ port, host: config.host }, "Server started");
        resolve(server);
      });
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(`Port ${port} is already in use. Try \`localshare --port ${port + 1}\`.`)
          );
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Gracefully stop the server.
   * @returns {Promise<void>}
   */
  async function stop() {
    sse.closeAll();
    rooms.stop();
    return new Promise((resolve) => {
      // Close existing server connections
      const server = app.server;
      if (server) {
        server.close(() => {
          logger.info("Server stopped");
          resolve();
        });
        // Force close after 5 seconds
        setTimeout(() => {
          server.close(() => resolve());
        }, 5000);
      } else {
        resolve();
      }
    });
  }

  return { app, start, stop };
}
