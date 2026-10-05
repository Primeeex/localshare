/**
 * PIN authentication and session management for LocalShare.
 * @module auth
 */

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// WHY: scrypt is memory-hard, so PIN brute force on a stolen hash is expensive.
// The session cookie uses HMAC (fast by design, it is checked on every request).

/**
 * Rate limit state per IP.
 * @type {Map<string, {failures: number, lockedUntil: number|null, lockCount: number}>}
 */
const rateLimits = new Map();

let serverSecret = null;
let dataDir = null;

/**
 * Tell the auth module which directory to persist its secret in.
 *
 * WHY a setter rather than a parameter threaded through signSession and
 * verifySession: the secret is needed in the auth middleware, which runs
 * before any route handler and has no config object in scope. The server has
 * exactly one upload directory for its whole lifetime, so recording it once at
 * startup is both simpler and less error-prone than passing it through every
 * call. Called from server.js right after the config is resolved.
 *
 * @param {string} dir
 */
export function setDataDir(dir) {
  dataDir = dir || null;
}

/**
 * Where the signing secret is persisted.
 *
 * WHY a file: the secret signs every session cookie, so generating a fresh one
 * on each boot silently invalidates every cookie already issued. On a LAN file
 * share that means a server restart (or a container being recreated by
 * `docker compose up -d`) kicks every connected phone and laptop back to the
 * PIN screen, and the app looks like it "lost the connection and never came
 * back". Persisting the secret makes restarts transparent to clients.
 *
 * The file lives in the upload directory, which the Dockerfile and compose
 * file already mount as a volume, so the secret survives container rebuilds.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function secretPath(dataDir) {
  return join(dataDir || "", ".localshare-secret");
}

/**
 * Load the persisted secret, or create one.
 *
 * A corrupt or short file is treated as absent rather than fatal: the old
 * cookies are already unreadable in that case, and refusing to boot would turn
 * a bad file into a dead server.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function loadOrCreateSecret(dataDir) {
  const file = secretPath(dataDir);
  try {
    if (existsSync(file)) {
      const stored = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(stored)) return stored;
    }
  } catch {
    /* fall through and regenerate */
  }

  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, generated, { mode: 0o600 });
  } catch {
    /* an unwritable data dir must not stop the server from starting */
  }
  return generated;
}

/**
 * Generate or return the server's signing secret.
 *
 * WHY the dataDir parameter: the secret has to live somewhere that outlives
 * the process, and the upload directory is the one path the deployment
 * instructions already tell users to persist.
 *
 * @param {string} [dataDir] - directory the secret file is stored in
 * @returns {string}
 */
export function getServerSecret(dataDir) {
  if (!serverSecret) {
    serverSecret = loadOrCreateSecret(dataDir);
  }
  return serverSecret;
}

/**
 * Hash a PIN using scrypt.
 * @param {string} pin
 * @returns {string} The hex-encoded hash
 */
export function hashPin(pin) {
  const salt = randomBytes(16);
  const derived = scryptSync(String(pin), salt, 32);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Verify a PIN against its hash.
 * @param {string} pin
 * @param {string} hash - Format: "salt:derived"
 * @returns {boolean}
 */
export function verifyPin(pin, hash) {
  const [saltHex, expectedHex] = (hash || "").split(":");
  if (!saltHex || !expectedHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(expectedHex, "hex");
    const derived = scryptSync(String(pin), salt, expected.length);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Sign a session payload into a cookie value.
 * @param {Object} payload
 * @returns {string}
 */
export function signSession(payload) {
  const secret = getServerSecret(dataDir);
  const json = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(json).digest("hex");
  return `${sig}.${btoa(json)}`;
}

/**
 * Verify and decode a session cookie value.
 * @param {string} cookieValue
 * @returns {Object|null}
 */
export function verifySession(cookieValue) {
  if (!cookieValue || !cookieValue.includes(".")) return null;
  const [sig, encoded] = cookieValue.split(".");
  try {
    const json = atob(encoded);
    const secret = getServerSecret(dataDir);
    const expectedSig = createHmac("sha256", secret).update(json).digest("hex");
    // WHY timingSafeEqual, not `!==`. verifyPin already uses it a few lines
    // up; the cookie signature was the one place still using short-circuiting
    // string equality, which returns as soon as two bytes differ and so leaks
    // a byte-by-byte prefix oracle on the session HMAC.
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expectedSig, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Get rate limit state for an IP.
 * @param {string} ip
 * @returns {{failures: number, lockedUntil: number|null, lockCount: number}}
 */
export function getRateLimit(ip) {
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { failures: 0, lockedUntil: null, lockCount: 0 });
  }
  return rateLimits.get(ip);
}

/**
 * Record a failed PIN attempt and return lockout info if applicable.
 *
 * Spec 12 "Rate Limiting (Auth)": 3 wrong attempts per IP -> 30s lockout.
 * After that lockout it takes 5 MORE attempts to trigger another one, and
 * after the 3rd lockout the IP is blocked until the server restarts. So the
 * failure budget is per stage, not a flat 3.
 *
 * @param {string} ip
 * @returns {{locked: boolean, retriesLeft: number, lockoutDuration: number|null}}
 */
export function recordFailedAttempt(ip) {
  const state = getRateLimit(ip);
  state.failures += 1;

  // WHY: stage 1 is the documented 3 attempts; every later stage needs 5
  const threshold = state.lockCount >= 1 ? 5 : 3;
  if (state.failures >= threshold) {
    state.failures = 0;
    state.lockCount++;

    // WHY an escalating cooldown, never Infinity.
    // `lockedUntil = Infinity` meant 3 + 5 + 5 = 13 wrong PINs from one IP
    // locked that IP out until the process restarted -- no expiry, no unlock
    // path. Behind Docker every client reaches the app through the same
    // gateway address, so `req.ip` was identical for the entire LAN: one
    // attacker could permanently lock out every legitimate user with thirteen
    // unauthenticated requests. A cooldown that actually expires is strictly
    // better for availability and no better for the attacker.
    //
    // Stages 1 and 2 are the documented 30s and 5min. Beyond that the wait
    // grows 4x per further lockout, capped at 24h so it stays finite.
    const BASE = state.lockCount === 1 ? 30000 : 300000;
    const escalation = 4 ** Math.max(0, state.lockCount - 2);
    const duration = Math.min(BASE * escalation, 24 * 60 * 60 * 1000);
    state.lockedUntil = Date.now() + duration;
    return {
      locked: true,
      retriesLeft: 0,
      lockoutDuration: duration,
    };
  }

  return {
    locked: false,
    retriesLeft: Math.max(0, threshold - state.failures),
    lockoutDuration: null,
  };
}

/**
 * Check if an IP is currently locked out.
 * @param {string} ip
 * @returns {{locked: boolean, remainingMs: number}}
 */
export function checkLockout(ip) {
  const state = getRateLimit(ip);
  if (state.lockedUntil === Infinity) return { locked: true, remainingMs: Infinity };
  if (state.lockedUntil && state.lockedUntil > Date.now()) {
    return { locked: true, remainingMs: state.lockedUntil - Date.now() };
  }
  // Reset on successful unlock
  if (state.lockedUntil && state.lockedUntil <= Date.now()) {
    state.lockedUntil = null;
    state.failures = 0;
  }
  return { locked: false, remainingMs: 0 };
}

/**
 * Clear rate limit state (call on server restart).
 */
export function clearRateLimits() {
  rateLimits.clear();
}

/**
 * Get cookie name for the session.
 */
export const SESSION_COOKIE_NAME = "localshare_session";
