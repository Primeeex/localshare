/**
 * Server info and health routes.
 * @module routes/server
 */

import { Router } from "express";
import os from "node:os";
import QRCode from "qrcode";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Create server info routes.
 * @param {Object} deps
 * @param {import('../logger.js').Logger} deps.logger
 * @param {Object} deps.config
 * @param {import('../rooms.js').RoomManager} deps.rooms
 * @param {import('../network.js').NetworkInfo} deps.networkInfo
 * @returns {Router}
 */
export default function createServerRouter(deps) {
  const router = Router();

  router.get(
    "/info",
    asyncRoute(async (req, res) => {
      const totalSize = deps.storage.calculateTotalSize();
      const totalFiles = Array.from(deps.storage.index.values()).reduce(
        (sum, room) => sum + room.size,
        0
      );
      res.json({
        hostname: deps.config.hostname || os.hostname(),
        port: deps.config.port,
        interfaces: deps.networkInfo.interfaces.map((iface) => ({
          name: iface.name,
          address: iface.address,
          url: `${iface.url || `http://${iface.address}:${deps.config.port}`}?room=default`,
        })),
        version: deps.config.version,
        uptime: Math.floor(process.uptime()),
        roomCount: deps.rooms.rooms.size,
        totalFiles,
        totalSize,
      });
    })
  );

  router.get(
    "/health",
    asyncRoute(async (_req, res) => {
      res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
    })
  );

  // WHY: QR rendered server-side so the browser needs no QR library
  router.get(
    "/qr",
    asyncRoute(async (req, res) => {
      const url = req.query.url;
      if (!url || typeof url !== "string" || url.length > 500) {
        throw new AppError("A url query parameter is required", "INVALID_BODY", 400);
      }
      // Only allow http(s) targets to keep the QR from pointing at odd schemes
      if (!/^https?:\/\//i.test(url)) {
        throw new AppError("Only http(s) URLs are supported", "INVALID_BODY", 400);
      }
      // WHY: near-black slate instead of pure #000000 keeps scanners happy
      // while staying clear of pure black in rendered UI assets
      const svg = await QRCode.toString(url, {
        type: "svg",
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#0F172Aff", light: "#FFFFFFFF" },
      });
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(svg);
    })
  );

  return router;
}
