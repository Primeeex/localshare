/**
 * Configuration loader for LocalShare.
 * Merges CLI args, config file, and defaults into a single frozen object.
 * @module config
 */

import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import cosmiconfig from "cosmiconfig";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default configuration values.
 * @type {Object<string, *>}
 */
const DEFAULTS = {
  port: 3000,
  host: "0.0.0.0",
  dir: "./uploads",
  pin: null,
  maxFileSize: parseSize("2GB"),
  maxStorage: parseSize("10GB"),
  expiry: parseDuration("24h"),
  maxRooms: 20,
  maxConnections: 500,
  maxFilesPerRoom: 200,
  cleanup: true,
  qr: true,
  logLevel: "info",
  logFormat: "pretty",
};

/**
 * Parse a size string like "500MB", "2GB", or a numeric byte count into bytes.
 * @param {string|number} input
 * @returns {number} Size in bytes
 */
export function parseSize(input) {
  if (typeof input === "number") return input;
  const str = String(input).trim().toUpperCase();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/);
  if (!match)
    throw new Error(`Invalid size format: ${input}. Use e.g. "500MB", "2GB", or byte count.`);
  const value = parseFloat(match[1]);
  const unit = match[2] || "B";
  const multipliers = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.floor(value * multipliers[unit]);
}

/**
 * Parse a duration string like "24h", "7d", "30m", or "never" into milliseconds.
 * Returns null for "never".
 * @param {string|number} input
 * @returns {number|null} Duration in milliseconds, or null for never
 */
export function parseDuration(input) {
  if (input === "never" || input === 0) return null;
  const str = String(input).trim().toLowerCase();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`Invalid duration format: ${input}. Use e.g. "24h", "7d", "30m".`);
  const value = parseFloat(match[1]);
  const unit = match[2] || "h";
  const multipliers = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return Math.floor(value * multipliers[unit]);
}

/**
 * Parse an env var into a positive integer, or undefined when unset/invalid.
 * WHY: NaN is not nullish, so a raw parseInt would poison ?? merges.
 */
function optionalInt(value) {
  if (value === undefined || value === "") return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Load and merge configuration from all sources.
 * Priority: CLI args > environment > config file > defaults.
 * @param {Object} cliArgs - Parsed yargs CLI arguments
 * @returns {Object} Frozen config object
 */
export async function loadConfig(cliArgs = {}) {
  // WHY: cosmiconfig does not search JSON config files by default,
  // so the documented localshare.config.json location is added explicitly.
  // Order follows the spec: explicit --config, then the cwd locations,
  // then the package.json "localshare" field.
  const explorer = cosmiconfig.cosmiconfig("localshare", {
    searchPlaces: [
      "localshare.config.json",
      "localshare.config.js",
      "localshare.config.cjs",
      "localshare.config.mjs",
      ".localsharc",
      "package.json",
    ],
  });

  let searchResult = null;
  if (cliArgs.config) {
    // WHY: --config is an explicit path and outranks every search location
    try {
      searchResult = await explorer.load(resolve(cliArgs.config));
    } catch (err) {
      throw new Error(`Could not read config file ${cliArgs.config}: ${err.message}`);
    }
  } else {
    searchResult = await explorer.search();
    if (!searchResult) {
      // WHY: cosmiconfig only walks upward from the cwd, so the documented
      // ~/.config/localshare/ location is checked as the final fallback
      try {
        searchResult = await explorer.load(
          join(homedir(), ".config", "localshare", "localshare.config.json")
        );
      } catch {
        searchResult = null;
      }
    }
  }
  const configFile = searchResult?.config ?? {};

  // WHY: env vars are lower priority than CLI but higher than config file
  const envConfig = {
    port: optionalInt(process.env.LOCALSHARE_PORT),
    host: process.env.LOCALSHARE_HOST || undefined,
    dir: process.env.LOCALSHARE_DIR || undefined,
    pin: process.env.LOCALSHARE_PIN || undefined,
    maxFileSize: process.env.LOCALSHARE_MAX_FILE_SIZE || undefined,
    maxStorage: process.env.LOCALSHARE_MAX_STORAGE || undefined,
    expiry: process.env.LOCALSHARE_EXPIRY || undefined,
    maxRooms: optionalInt(process.env.LOCALSHARE_MAX_ROOMS),
    maxConnections: optionalInt(process.env.LOCALSHARE_MAX_CONNECTIONS),
    maxFilesPerRoom: optionalInt(process.env.LOCALSHARE_MAX_FILES_PER_ROOM),
    cleanup: process.env.LOCALSHARE_CLEANUP
      ? process.env.LOCALSHARE_CLEANUP !== "false"
      : undefined,
    qr: process.env.LOCALSHARE_QR ? process.env.LOCALSHARE_QR !== "false" : undefined,
    logLevel: process.env.LOCALSHARE_LOG_LEVEL || undefined,
    logFormat: process.env.LOCALSHARE_LOG_FORMAT || undefined,
  };

  // Merge: CLI > environment > config file > defaults
  const merged = {
    port: cliArgs.port ?? envConfig.port ?? configFile.port ?? DEFAULTS.port,
    host: cliArgs.host ?? envConfig.host ?? configFile.host ?? DEFAULTS.host,
    dir: cliArgs.dir ?? envConfig.dir ?? configFile.dir ?? DEFAULTS.dir,
    pin: cliArgs.pin ?? envConfig.pin ?? configFile.pin ?? DEFAULTS.pin,
    maxFileSize: parseSize(
      cliArgs.maxFileSize ?? envConfig.maxFileSize ?? configFile.maxFileSize ?? "2GB"
    ),
    maxStorage: parseSize(
      cliArgs.maxStorage ?? envConfig.maxStorage ?? configFile.maxStorage ?? "10GB"
    ),
    expiry: parseDuration(cliArgs.expiry ?? envConfig.expiry ?? configFile.expiry ?? "24h"),
    maxRooms: cliArgs.maxRooms ?? envConfig.maxRooms ?? configFile.maxRooms ?? DEFAULTS.maxRooms,
    maxConnections:
      cliArgs.maxConnections ??
      envConfig.maxConnections ??
      configFile.maxConnections ??
      DEFAULTS.maxConnections,
    maxFilesPerRoom:
      cliArgs.maxFilesPerRoom ??
      envConfig.maxFilesPerRoom ??
      configFile.maxFilesPerRoom ??
      DEFAULTS.maxFilesPerRoom,
    cleanup:
      cliArgs.noCleanup === true
        ? false
        : (envConfig.cleanup ?? configFile.cleanup ?? DEFAULTS.cleanup),
    qr: cliArgs.noQr === true ? false : (envConfig.qr ?? configFile.qr ?? DEFAULTS.qr),
    logLevel: cliArgs.logLevel ?? envConfig.logLevel ?? configFile.logLevel ?? DEFAULTS.logLevel,
    logFormat:
      cliArgs.logFormat ?? envConfig.logFormat ?? configFile.logFormat ?? DEFAULTS.logFormat,
  };

  // Validate
  if (typeof merged.port !== "number" || merged.port < 1 || merged.port > 65535) {
    throw new Error(`Invalid port: ${merged.port}. Must be a number between 1 and 65535.`);
  }
  if (merged.maxRooms < 1 || merged.maxRooms > 100) {
    throw new Error(`Invalid maxRooms: ${merged.maxRooms}. Must be between 1 and 100.`);
  }
  if (merged.maxConnections < 10 || merged.maxConnections > 5000) {
    throw new Error(
      `Invalid maxConnections: ${merged.maxConnections}. Must be between 10 and 5000.`
    );
  }
  if (merged.maxFilesPerRoom < 1 || merged.maxFilesPerRoom > 10000) {
    throw new Error(
      `Invalid maxFilesPerRoom: ${merged.maxFilesPerRoom}. Must be between 1 and 10000.`
    );
  }
  if (merged.pin !== null && !/^\d{4,8}$/.test(merged.pin)) {
    throw new Error(`Invalid PIN: ${merged.pin}. Must be 4-8 digits.`);
  }

  return Object.freeze(merged);
}
