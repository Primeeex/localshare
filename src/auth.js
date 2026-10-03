/**
 * PIN authentication and session management for LocalShare.
 * @module auth
 */

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

// WHY: scrypt is memory-hard, so PIN brute force on a stolen hash is expensive.
// The session cookie uses HMAC (fast by design, it is checked on every request).

/**
 * Rate limit state per IP.
 * @type {Map<string, {failures: number, lockedUntil: number|null, lockCount: number}>}
 */
const rateLimits = new Map();

let serverSecret = null;

/**
 * Generate or return the server's signing secret.
 * @returns {string}
 */
export function getServerSecret() {
  if (!serverSecret) {
    serverSecret = randomBytes(32).toString("hex");
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
  const secret = getServerSecret();
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
    const secret = getServerSecret();
    const expectedSig = createHmac("sha256", secret).update(json).digest("hex");
    if (sig !== expectedSig) return null;
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
 * @param {string} ip
 * @returns {{locked: boolean, retriesLeft: number, lockoutDuration: number|null}}
 */
export function recordFailedAttempt(ip) {
  const state = getRateLimit(ip);
  state.failures += 1;

  // 3 wrong attempts -> lockout (30s, then 5min, then permanent)
  if (state.failures >= 3) {
    state.failures = 0;
    state.lockCount++;

    // WHY: a third lockout from the same IP means automated guessing
    if (state.lockCount >= 3) {
      state.lockedUntil = Infinity;
      return { locked: true, retriesLeft: 0, lockoutDuration: null, permanent: true };
    }

    const duration = state.lockCount === 1 ? 30000 : 300000;
    state.lockedUntil = Date.now() + duration;
    return { locked: true, retriesLeft: 0, lockoutDuration: duration };
  }

  return { locked: false, retriesLeft: Math.max(0, 3 - state.failures), lockoutDuration: null };
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
