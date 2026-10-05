#!/usr/bin/env node
/**
 * LocalShare CLI entry point.
 * Starts the server, prints URL + QR code to terminal, handles graceful shutdown.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import QRCode from "qrcode";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Storage } from "../src/storage.js";
import { RoomManager } from "../src/rooms.js";
import { SSEManager } from "../src/sse.js";
import { CleanupManager } from "../src/cleanup.js";
import { getLocalIPs, getPrimaryIP, buildURL } from "../src/network.js";
import { hashPin } from "../src/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const pkg = JSON.parse(
    await import("node:fs/promises").then((m) =>
      m.readFile(resolve(__dirname, "..", "package.json"), "utf-8")
    )
  );

  const argv = yargs(hideBin(process.argv))
    .usage("Usage: localshare [options]")
    // WHY boolean-negation off: the spec spells these flags --no-qr and
    // --no-cleanup, which yargs would otherwise rewrite into qr:false
    .parserConfiguration({ "boolean-negation": false })
    .option("port", {
      alias: "p",
      type: "number",
      defaultDescription: "3000",
      describe: "Port to listen on",
    })
    .option("dir", {
      alias: "d",
      type: "string",
      defaultDescription: "./uploads",
      describe: "Upload storage directory",
    })
    .option("pin", {
      alias: "P",
      type: "string",
      describe: "PIN for server-level auth (4-8 digits)",
    })
    .option("host", {
      alias: "H",
      type: "string",
      defaultDescription: "0.0.0.0",
      describe: "Host to bind to",
    })
    .option("max-file-size", {
      type: "string",
      defaultDescription: "2GB",
      describe: "Max file size in bytes/MB/GB",
    })
    .option("max-storage", {
      type: "string",
      defaultDescription: "10GB",
      describe: "Max total storage",
    })
    .option("expiry", {
      type: "string",
      defaultDescription: "24h",
      describe: "Default file expiry (e.g. 24h, 7d, never)",
    })
    .option("max-rooms", {
      type: "number",
      defaultDescription: "20",
      describe: "Maximum number of rooms",
    })
    .option("max-connections", {
      type: "number",
      defaultDescription: "500",
      describe: "Maximum SSE connections",
    })
    .option("max-files-per-room", {
      type: "number",
      defaultDescription: "200",
      describe: "Maximum files per room",
    })
    .option("no-cleanup", { type: "boolean", describe: "Disable automatic file cleanup" })
    .option("no-qr", { type: "boolean", describe: "Don't print QR code to terminal" })
    .option("no-color", { type: "boolean", describe: "Disable terminal colors" })
    .option("log-level", {
      type: "string",
      defaultDescription: "info",
      describe: "Log level (trace,debug,info,warn,error,silent)",
    })
    .option("log-format", {
      type: "string",
      defaultDescription: "pretty",
      describe: "Log format (pretty, json)",
    })
    .option("config", { type: "string", describe: "Path to config file" })
    .example("localshare", "Start on default port 3000")
    .example("localshare -p 8080", "Start on port 8080")
    .example("localshare --pin 1234", "Require PIN 1234 to access")
    .example("localshare --expiry never --no-cleanup", "Keep files forever")
    .example("localshare --max-file-size 500MB", "Limit uploads to 500 MB")
    .example("localshare --dir /tmp/share", "Store uploads in /tmp/share")
    .alias("h", "help")
    .version("version", "Show version", pkg.version)
    // WHY strict: an unknown flag would otherwise boot the server with a
    // silently ignored setting; failing fast surfaces typos like --prot
    .strict()
    .exitProcess(true)
    .fail((msg, err) => {
      if (err) throw err;
      console.error(`localshare: ${msg}`);
      console.error("Run `localshare --help` to list the available options.");
      process.exit(1);
    })
    .help()
    .parse();

  // WHY defaultDescription instead of default: yargs would otherwise stamp a
  // default value into argv and outrank the environment and config file, which
  // must both win over built-in defaults (CLI > env > config file > defaults)
  const [loaded, os] = await Promise.all([loadConfig(argv), import("node:os")]);
  const config = { ...loaded, version: pkg.version, hostname: os.hostname() };

  // WHY: --no-color keeps the pretty transport but drops ANSI colors
  if (argv.noColor) config.colorize = false;

  // Hash PIN if provided (raw digits in config, scrypt hash for the app)
  if (config.pin) {
    config.pin = hashPin(config.pin);
  }

  // Create logger
  const logger = createLogger(config);

  // Detect network interfaces
  const interfaces = getLocalIPs();
  const primaryIP = getPrimaryIP(interfaces);

  // Create storage
  const storage = new Storage(config.dir, config.maxFileSize, config.maxStorage);
  await storage.rebuildIndexFromDisk();
  logger.info(
    { fileCount: Array.from(storage.index.values()).reduce((s, r) => s + r.size, 0) },
    "Storage initialized"
  );

  // Create SSE manager
  const sse = new SSEManager(logger, config.maxConnections);

  // Create room manager
  const rooms = new RoomManager(storage, sse, logger, config.maxRooms, config.maxFilesPerRoom);

  // Create app
  const { start, stop } = createApp(config, storage, rooms, sse, logger, { interfaces, primaryIP });

  // Start server
  let server;
  try {
    server = await start(config.port);
  } catch (err) {
    logger.fatal({ error: err.message }, "Failed to start server");
    process.exit(1);
  }

  // Print startup banner
  await printStartupBanner(config, interfaces, primaryIP, logger, argv.noQr);

  // Setup graceful shutdown
  setupShutdown(server, sse, stop, logger);

  // Start cleanup scheduler
  if (config.cleanup) {
    const cleanup = new CleanupManager(storage, rooms, sse, logger);
    cleanup.start();
  }
}

/**
 * Width of the startup banner box from spec 14 "Startup Output (Terminal)".
 */
const BANNER_MIN_WIDTH = 53;

/** Matches the SGR sequences the QR renderer emits, which occupy no columns. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/**
 * Measure how many terminal columns a string actually occupies.
 * WHY: ANSI colour codes and surrogate pairs both inflate the raw code-point
 * count, and padding by that count would skew every border in the box.
 * @param {string} line
 * @returns {number}
 */
function visibleWidth(line) {
  return [...line.replace(ANSI_PATTERN, "")].length;
}

/**
 * Render one banner line inside the box, padded to the given inner width.
 * @param {string} line
 * @param {number} width
 * @returns {string}
 */
function boxLine(line, width) {
  return `  │${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}│`;
}

/**
 * Render a bordered box around a list of already-indented lines.
 * WHY a computed width: the QR block is wider than the spec's sample box, so
 * the box grows to fit instead of clipping the code.
 * @param {string[]} lines
 * @returns {string}
 */
function renderBox(lines) {
  const width = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), BANNER_MIN_WIDTH);
  const rule = "─".repeat(width);
  return [`  ┌${rule}┐`, ...lines.map((line) => boxLine(line, width)), `  └${rule}┘`].join("\n");
}

/**
 * Render the QR code as Unicode half-blocks, resolving to null on failure.
 * @param {string} url
 * @param {Object} logger
 * @returns {Promise<string|null>}
 */
function renderQr(url, logger) {
  return new Promise((resolve) => {
    QRCode.toString(url, { type: "terminal", small: true }, (err, result) => {
      if (err) {
        logger.warn({ error: err.message }, "Failed to generate QR code");
        return resolve(null);
      }
      resolve(result.trimEnd());
    });
  });
}

/**
 * Print the startup banner to the terminal, boxed exactly as spec 14 shows.
 * @param {Object} config
 * @param {Object[]} interfaces
 * @param {string} primaryIP
 * @param {Object} logger
 * @param {boolean} noQr
 * @returns {Promise<void>}
 */
async function printStartupBanner(config, interfaces, primaryIP, logger, noQr) {
  const primaryUrl = buildURL(primaryIP, config.port);

  const expiryStatus = config.expiry ? `${formatDuration(config.expiry)} hours` : "never";
  const maxSize = formatBytes(config.maxFileSize);
  const maxStorage = formatBytes(config.maxStorage);

  const body = [];
  body.push("");
  body.push(`   📂  LocalShare v${config.version}`);
  body.push("");
  body.push(`   Local:    http://localhost:${config.port}`);
  for (const iface of interfaces) {
    const url = buildURL(iface.address, config.port);
    const marker = iface.address === primaryIP ? "  ◄── primary" : "";
    body.push(`   Network:  ${url}${marker}`);
  }
  body.push("");

  if (!noQr) {
    body.push("   QR Code (scan to open on phone):");
    body.push("");
    const qr = await renderQr(primaryUrl, logger);
    if (qr) {
      for (const line of qr.split("\n")) body.push(`   ${line}`);
      body.push("");
    }
  }

  // WHY always printed: spec 14 shows a PIN protection line even with no PIN
  body.push(`   PIN protection: ${config.pin ? "enabled" : "disabled"}`);
  body.push(`   File expiry:    ${expiryStatus}`);
  body.push(`   Max file size:  ${maxSize}`);
  body.push(`   Max storage:    ${maxStorage}`);
  body.push(`   Storage dir:    ${config.dir}`);
  body.push("");
  body.push("   Press Ctrl+C to stop");
  body.push("");

  console.log(renderBox(body));
}

/**
 * Setup graceful shutdown handlers.
 */
function setupShutdown(server, sse, stop, logger) {
  async function shutdown(signal) {
    logger.info({ signal }, "Shutdown initiated");
    // Broadcast shutdown event to all SSE clients
    try {
      for (const roomId of sse.clients.keys()) {
        sse.broadcast(roomId, "server:shutdown", {
          message: `Server is shutting down in 5 seconds...`,
          countdown: 5,
        });
      }
    } catch {
      // Best effort: shutdown continues even if a broadcast fails
    }

    // Wait a bit for clients to receive the message
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await stop();
    logger.info("LocalShare stopped. Goodbye.");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Catch unhandled promise rejections
  process.on("unhandledRejection", (err) => {
    logger.fatal({ error: err.stack || err.message }, "Unhandled promise rejection");
    shutdown("unhandledRejection").catch(() => process.exit(1));
  });

  // Catch uncaught exceptions
  process.on("uncaughtException", (err) => {
    logger.fatal({ error: err.stack || err.message }, "Uncaught exception");
    shutdown("uncaughtException").catch(() => process.exit(1));
  });
}

/**
 * Format bytes to human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Format duration in ms to hours string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const hours = ms / (1000 * 60 * 60);
  return Math.round(hours);
}

// Expose sse for shutdown handler is handled via setupShutdown(sse, ...) above.

main().catch((err) => {
  // WHY message only: config/CLI mistakes are user-facing, a stack trace adds noise
  console.error("Failed to start LocalShare:", err.message);
  process.exit(1);
});
