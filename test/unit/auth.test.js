/**
 * Unit tests for PIN hashing, session cookies and login rate limiting.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  hashPin,
  verifyPin,
  signSession,
  verifySession,
  recordFailedAttempt,
  checkLockout,
  clearRateLimits,
  getRateLimit,
  SESSION_COOKIE_NAME,
} from "../../src/auth.js";

describe("auth", () => {
  beforeEach(() => {
    clearRateLimits();
  });

  describe("PIN hashing", () => {
    it("produces a different hash on every call (random salt)", () => {
      const a = hashPin("1234");
      const b = hashPin("1234");
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    });

    it("verifies the correct PIN", () => {
      const hash = hashPin("1234");
      expect(verifyPin("1234", hash)).toBe(true);
    });

    it("rejects a wrong PIN", () => {
      const hash = hashPin("1234");
      expect(verifyPin("9999", hash)).toBe(false);
    });

    it("rejects malformed hashes without throwing", () => {
      expect(verifyPin("1234", "")).toBe(false);
      expect(verifyPin("1234", "garbage")).toBe(false);
      expect(verifyPin("1234", null)).toBe(false);
    });
  });

  describe("session cookies", () => {
    it("round-trips a payload", () => {
      const cookie = signSession({ verified: true, iat: Date.now() });
      const decoded = verifySession(cookie);
      expect(decoded).toMatchObject({ verified: true });
    });

    it("rejects tampered payloads", () => {
      const cookie = signSession({ verified: true });
      const [sig, body] = cookie.split(".");
      const tampered = `${sig}.${Buffer.from(JSON.stringify({ verified: false })).toString("base64")}`;
      expect(verifySession(tampered)).toBeNull();
      expect(verifySession(`${body}`)).toBeNull();
      expect(verifySession("")).toBeNull();
      expect(verifySession(null)).toBeNull();
    });

    it("exposes the documented cookie name", () => {
      expect(SESSION_COOKIE_NAME).toBe("localshare_session");
    });
  });

  describe("rate limiting", () => {
    it("reports retries remaining for the first two failures", () => {
      expect(recordFailedAttempt("1.2.3.4")).toMatchObject({ locked: false, retriesLeft: 2 });
      expect(recordFailedAttempt("1.2.3.4")).toMatchObject({ locked: false, retriesLeft: 1 });
    });

    it("locks out after 3 failed attempts", () => {
      recordFailedAttempt("1.2.3.5");
      recordFailedAttempt("1.2.3.5");
      const third = recordFailedAttempt("1.2.3.5");
      expect(third.locked).toBe(true);
      expect(third.retriesLeft).toBe(0);
      expect(third.lockoutDuration).toBeGreaterThan(0);
      expect(checkLockout("1.2.3.5").locked).toBe(true);
    });

    it("locks out a separate IP independently", () => {
      recordFailedAttempt("9.9.9.9");
      recordFailedAttempt("9.9.9.9");
      recordFailedAttempt("9.9.9.9");
      expect(checkLockout("9.9.9.9").locked).toBe(true);
      expect(checkLockout("8.8.8.8").locked).toBe(false);
    });

    it("unblocks and clears failures after the lockout period", () => {
      const state = getRateLimit("5.5.5.5");
      recordFailedAttempt("5.5.5.5");
      recordFailedAttempt("5.5.5.5");
      recordFailedAttempt("5.5.5.5");
      expect(checkLockout("5.5.5.5").locked).toBe(true);
      // Simulate expiry
      state.lockedUntil = Date.now() - 1;
      const result = checkLockout("5.5.5.5");
      expect(result.locked).toBe(false);
      expect(state.failures).toBe(0);
      // The IP already used its stage-1 budget of 3, so it is back to 5
      expect(recordFailedAttempt("5.5.5.5")).toMatchObject({ locked: false, retriesLeft: 4 });
    });

    it("escalates the lockout duration on a repeated lockout", () => {
      const ip = "7.7.7.7";
      // First lockout after the stage-1 budget of 3 attempts
      recordFailedAttempt(ip);
      recordFailedAttempt(ip);
      const first = recordFailedAttempt(ip);
      expect(first.locked).toBe(true);
      expect(first.lockoutDuration).toBe(30000);

      // Let the lock expire (clears failures but keeps the lock counter)
      checkLockout(ip);
      getRateLimit(ip).lockedUntil = Date.now() - 1;
      checkLockout(ip);

      // Second lockout escalates to 5 minutes, and spec 12 requires FIVE
      // further attempts at this stage rather than three
      expect(recordFailedAttempt(ip).retriesLeft).toBe(4);
      expect(recordFailedAttempt(ip).retriesLeft).toBe(3);
      expect(recordFailedAttempt(ip).retriesLeft).toBe(2);
      expect(recordFailedAttempt(ip).retriesLeft).toBe(1);
      const second = recordFailedAttempt(ip);
      expect(second.locked).toBe(true);
      expect(second.lockoutDuration).toBe(300000);

      // Third lockout escalates again (5 min x 4) and, critically, is NOT
      // permanent. It used to set lockedUntil = Infinity, so 3 + 5 + 5 = 13
      // wrong PINs from one IP locked that IP out with no expiry and no unlock
      // path except restarting the process. Behind Docker every LAN client
      // shares one gateway `req.ip`, which made that a permanent, server-wide
      // denial of service triggerable by any unauthenticated caller.
      getRateLimit(ip).lockedUntil = Date.now() - 1;
      checkLockout(ip);
      for (let i = 0; i < 4; i += 1) recordFailedAttempt(ip);
      const third = recordFailedAttempt(ip);
      expect(third.locked).toBe(true);
      expect(third.lockoutDuration).toBe(300000 * 4);
      expect(third.permanent).toBeUndefined();

      // The lock must actually expire instead of lasting forever.
      const during = checkLockout(ip);
      expect(during.remainingMs).toBeLessThanOrEqual(300000 * 4);
      expect(during.remainingMs).not.toBe(Infinity);
      getRateLimit(ip).lockedUntil = Date.now() - 1;
      checkLockout(ip);
      expect(checkLockout(ip).locked).toBe(false);
    });

    it("does not lock out on the 4th and 5th attempts of a later stage", () => {
      const ip = "6.6.6.6";
      // Reach stage 2
      recordFailedAttempt(ip);
      recordFailedAttempt(ip);
      recordFailedAttempt(ip);
      getRateLimit(ip).lockedUntil = Date.now() - 1;
      checkLockout(ip);

      expect(recordFailedAttempt(ip).locked).toBe(false);
      expect(recordFailedAttempt(ip).locked).toBe(false);
      expect(recordFailedAttempt(ip).locked).toBe(false);
      expect(recordFailedAttempt(ip).locked).toBe(false);
      // Only the 5th attempt of stage 2 triggers the lockout
      expect(recordFailedAttempt(ip).locked).toBe(true);
    });

    it("clears all state on clearRateLimits()", () => {
      recordFailedAttempt("3.3.3.3");
      clearRateLimits();
      expect(checkLockout("3.3.3.3").locked).toBe(false);
    });
  });
});
