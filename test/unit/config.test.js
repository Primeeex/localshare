/**
 * Unit tests for configuration loading and parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, parseSize, parseDuration } from "../../src/config.js";
import { makeTempDir } from "../helpers/app.js";

const ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith("LOCALSHARE_"));
let savedEnv = {};

describe("config", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe("parseSize", () => {
    it("parses 2GB into bytes", () => {
      expect(parseSize("2GB")).toBe(2 * 1024 ** 3);
    });

    it("parses 500MB into bytes", () => {
      expect(parseSize("500MB")).toBe(500 * 1024 ** 2);
    });

    it("parses 1KB, 1TB and bare byte counts", () => {
      expect(parseSize("1KB")).toBe(1024);
      expect(parseSize("1TB")).toBe(1024 ** 4);
      expect(parseSize("512")).toBe(512);
      expect(parseSize(2048)).toBe(2048);
    });

    it("is case and whitespace insensitive", () => {
      expect(parseSize(" 2gb ")).toBe(2 * 1024 ** 3);
    });

    it("supports fractional sizes", () => {
      expect(parseSize("1.5MB")).toBe(Math.floor(1.5 * 1024 ** 2));
    });

    it("throws a helpful error for junk input", () => {
      expect(() => parseSize("banana")).toThrow(/Invalid size format/);
    });
  });

  describe("parseDuration", () => {
    it("parses 24h into milliseconds", () => {
      expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
    });

    it('returns null for "never"', () => {
      expect(parseDuration("never")).toBeNull();
    });

    it("parses minutes, seconds, days and milliseconds", () => {
      expect(parseDuration("30m")).toBe(30 * 60 * 1000);
      expect(parseDuration("45s")).toBe(45000);
      expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseDuration("500ms")).toBe(500);
    });

    it("defaults a bare number to hours", () => {
      expect(parseDuration("2")).toBe(2 * 60 * 60 * 1000);
    });

    it("throws a helpful error for junk input", () => {
      expect(() => parseDuration("soon")).toThrow(/Invalid duration format/);
    });
  });

  describe("loadConfig", () => {
    it("applies defaults when nothing is provided", async () => {
      const config = await loadConfig({});
      expect(config.port).toBe(3000);
      expect(config.host).toBe("0.0.0.0");
      expect(config.dir).toBe("./uploads");
      expect(config.pin).toBeNull();
      expect(config.maxFileSize).toBe(parseSize("2GB"));
      expect(config.maxStorage).toBe(parseSize("10GB"));
      expect(config.expiry).toBe(parseDuration("24h"));
      expect(config.maxRooms).toBe(20);
      expect(config.maxConnections).toBe(500);
      expect(config.maxFilesPerRoom).toBe(200);
      expect(config.cleanup).toBe(true);
      expect(config.qr).toBe(true);
    });

    it("parses string CLI args into numbers and milliseconds", async () => {
      const config = await loadConfig({
        port: 8080,
        maxFileSize: "512MB",
        maxStorage: "2GB",
        expiry: "2h",
      });
      expect(config.port).toBe(8080);
      expect(config.maxFileSize).toBe(parseSize("512MB"));
      expect(config.maxStorage).toBe(parseSize("2GB"));
      expect(config.expiry).toBe(2 * 60 * 60 * 1000);
    });

    it("loads defaults when a config file is present alongside them", async () => {
      const dir = await makeTempDir();
      const cfgPath = join(dir, "localshare.config.json");
      await writeFile(cfgPath, JSON.stringify({ port: 4000, logLevel: "warn" }));
      const previous = process.cwd();
      process.chdir(dir);
      try {
        const config = await loadConfig({});
        expect(config.port).toBe(4000);
        expect(config.logLevel).toBe("warn");
        expect(config.maxRooms).toBe(20); // default still applies
      } finally {
        process.chdir(previous);
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("lets CLI args override the config file", async () => {
      const dir = await makeTempDir();
      const cfgPath = join(dir, "localshare.config.json");
      await writeFile(cfgPath, JSON.stringify({ port: 4000, maxRooms: 5 }));
      const previous = process.cwd();
      process.chdir(dir);
      try {
        const config = await loadConfig({ port: 5555 });
        expect(config.port).toBe(5555);
        expect(config.maxRooms).toBe(5);
      } finally {
        process.chdir(previous);
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("reads an explicit --config path from anywhere", async () => {
      const dir = await makeTempDir();
      const cfgPath = join(dir, "localshare.config.json");
      await writeFile(cfgPath, JSON.stringify({ port: 4444, dir: "/tmp/from-config" }));
      try {
        // cwd stays the repo on purpose: the explicit path must win regardless
        const config = await loadConfig({ config: cfgPath });
        expect(config.port).toBe(4444);
        expect(config.dir).toBe("/tmp/from-config");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("throws a clear error when --config points at a missing file", async () => {
      await expect(
        loadConfig({ config: "/tmp/definitely-missing-localshare.json" })
      ).rejects.toThrow(/Could not read config file/);
    });

    it("lets environment variables beat the config file", async () => {
      const dir = await makeTempDir();
      const cfgPath = join(dir, "localshare.config.json");
      await writeFile(cfgPath, JSON.stringify({ port: 4000, logLevel: "warn" }));
      const previous = process.cwd();
      process.chdir(dir);
      process.env.LOCALSHARE_PORT = "7001";
      try {
        const config = await loadConfig({});
        expect(config.port).toBe(7001); // env over config file
        expect(config.logLevel).toBe("warn"); // config file still beats defaults
      } finally {
        process.chdir(previous);
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("lets environment variables beat the config file for booleans too", async () => {
      const dir = await makeTempDir();
      const cfgPath = join(dir, "localshare.config.json");
      await writeFile(cfgPath, JSON.stringify({ qr: false, cleanup: false }));
      const previous = process.cwd();
      process.chdir(dir);
      process.env.LOCALSHARE_QR = "true";
      process.env.LOCALSHARE_CLEANUP = "true";
      try {
        const config = await loadConfig({});
        expect(config.qr).toBe(true);
        expect(config.cleanup).toBe(true);
      } finally {
        process.chdir(previous);
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("reads environment variables", async () => {
      process.env.LOCALSHARE_PORT = "7000";
      process.env.LOCALSHARE_MAX_STORAGE = "3GB";
      process.env.LOCALSHARE_EXPIRY = "48h";
      process.env.LOCALSHARE_QR = "false";
      const config = await loadConfig({});
      expect(config.port).toBe(7000);
      expect(config.maxStorage).toBe(parseSize("3GB"));
      expect(config.expiry).toBe(parseDuration("48h"));
      expect(config.qr).toBe(false);
    });

    it("lets CLI args override environment variables", async () => {
      process.env.LOCALSHARE_PORT = "7000";
      const config = await loadConfig({ port: 8123 });
      expect(config.port).toBe(8123);
    });

    it("ignores unparseable numeric env vars instead of producing NaN", async () => {
      process.env.LOCALSHARE_PORT = "not-a-port";
      const config = await loadConfig({});
      expect(config.port).toBe(3000);
    });

    it("throws a helpful message for an invalid port", async () => {
      await expect(loadConfig({ port: 99999 })).rejects.toThrow(/Invalid port/);
      await expect(loadConfig({ port: 0 })).rejects.toThrow(/Invalid port/);
    });

    it("throws for out-of-range limits", async () => {
      await expect(loadConfig({ maxRooms: 0 })).rejects.toThrow(/maxRooms/);
      await expect(loadConfig({ maxConnections: 1 })).rejects.toThrow(/maxConnections/);
      await expect(loadConfig({ maxFilesPerRoom: 0 })).rejects.toThrow(/maxFilesPerRoom/);
    });

    it("validates the PIN format", async () => {
      await expect(loadConfig({ pin: "123" })).rejects.toThrow(/Invalid PIN/);
      await expect(loadConfig({ pin: "abcdefg" })).rejects.toThrow(/Invalid PIN/);
      const config = await loadConfig({ pin: "482913" });
      expect(config.pin).toBe("482913");
    });

    it("honours --noCleanup and --noQr flags", async () => {
      const config = await loadConfig({ noCleanup: true, noQr: true });
      expect(config.cleanup).toBe(false);
      expect(config.qr).toBe(false);
    });

    it("returns a frozen object", async () => {
      const config = await loadConfig({});
      expect(Object.isFrozen(config)).toBe(true);
    });
  });
});
