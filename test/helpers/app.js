/**
 * Test harness: builds an isolated LocalShare app instance per test file.
 * @module test/helpers/app
 */

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server.js";
import { Storage } from "../../src/storage.js";
import { RoomManager } from "../../src/rooms.js";
import { SSEManager } from "../../src/sse.js";
import { CleanupManager } from "../../src/cleanup.js";
import { createLogger } from "../../src/logger.js";
import { hashPin, clearRateLimits } from "../../src/auth.js";
import { parseSize, parseDuration } from "../../src/config.js";

/**
 * Default test configuration.
 * WHY: rate limiting is disabled so suites never trip 429s;
 * logs are silenced to keep test output readable.
 */
export function testConfig(overrides = {}) {
  return {
    port: 0,
    host: "127.0.0.1",
    dir: "./uploads",
    pin: null,
    maxFileSize: parseSize("10MB"),
    maxStorage: parseSize("50MB"),
    expiry: parseDuration("24h"),
    maxRooms: 10,
    maxConnections: 50,
    maxFilesPerRoom: 100,
    cleanup: false,
    qr: true,
    logLevel: "silent",
    logFormat: "json",
    rateLimit: false,
    version: "1.0.0",
    hostname: "test-host",
    ...overrides,
  };
}

/**
 * Create an isolated app instance with its own temp uploads directory.
 * @param {Object} [overrides] - Config overrides
 * @param {boolean} [withCleanup=false] - Start the cleanup scheduler
 * @returns {Promise<Object>} Harness with helpers
 */
export async function createTestApp(overrides = {}, { withCleanup = false } = {}) {
  clearRateLimits();

  const dir = await mkdtemp(join(tmpdir(), "localshare-test-"));
  const config = testConfig({ dir, ...overrides });

  const logger = createLogger(config);
  const storage = new Storage(config.dir, config.maxFileSize, config.maxStorage);
  await storage.rebuildIndexFromDisk();
  const sse = new SSEManager(logger, config.maxConnections);
  const rooms = new RoomManager(storage, sse, logger, config.maxRooms, config.maxFilesPerRoom);

  const networkInfo = {
    interfaces: [{ name: "lo", address: "127.0.0.1", family: "IPv4" }],
    primaryIP: "127.0.0.1",
  };

  const { app, start, stop } = createApp(config, storage, rooms, sse, logger, networkInfo);

  let cleanup = null;
  if (withCleanup) {
    cleanup = new CleanupManager(storage, rooms, sse, logger);
  }

  return {
    app,
    config,
    storage,
    rooms,
    sse,
    logger,
    cleanup,
    dir,
    start,
    stop,
    /** Start listening on an ephemeral port (needed for SSE tests). */
    async listen() {
      const server = await start(0);
      const port = server.address().port;
      return { server, port, url: `http://127.0.0.1:${port}` };
    },
    /** Tear everything down and remove the temp directory. */
    async destroy() {
      try {
        cleanup?.stop();
      } catch {
        /* already closed */
      }
      await stop();
      rooms.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Hash a PIN the same way the CLI does.
 */
export function pinHash(pin) {
  return hashPin(pin);
}

/**
 * Create a temp directory for config-file tests.
 */
export async function makeTempDir(prefix = "localshare-cfg-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(dir, { recursive: true });
  return dir;
}
