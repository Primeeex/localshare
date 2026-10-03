/**
 * Route aggregator for LocalShare.
 * @module routes/index
 */

import { Router } from "express";
import filesRouter from "./files.js";
import textRouter from "./text.js";
import clipboardRouter from "./clipboard.js";
import devicesRouter from "./devices.js";
import roomsRouter from "./rooms.js";
import authRouter from "./auth.js";
import serverRouter from "./server.js";
import transfersRouter from "./transfers.js";

/**
 * Create and configure the main API router.
 * @param {Object} dependencies
 * @returns {Router}
 */
export default function createRouter(dependencies) {
  const router = Router();

  // WHY: routes are mounted in order; more specific routes first
  router.use("/server", serverRouter(dependencies));
  router.use("/auth", authRouter(dependencies));
  router.use("/rooms", roomsRouter(dependencies));
  router.use("/rooms/:roomId/files", filesRouter(dependencies));
  router.use("/rooms/:roomId/text", textRouter(dependencies));
  router.use("/rooms/:roomId/clipboard", clipboardRouter(dependencies));
  router.use("/rooms/:roomId/devices", devicesRouter(dependencies));
  router.use("/rooms/:roomId/transfers", transfersRouter(dependencies));

  return router;
}
