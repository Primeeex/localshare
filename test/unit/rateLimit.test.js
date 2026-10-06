/**
 * Rate limiter store tests.
 *
 * The store is a plain Map keyed by source IP. Nothing ever removed a key, so
 * every distinct IP that ever touched the API stayed resident for the life of
 * the process -- measured at 400,000 retained entries after 400,000 distinct
 * keys, against a spec 19 budget of 50MB RSS. A sweep on a request count bounds
 * it (the same measurement drops to ~4,700).
 *
 * `store.size` is private, so the size bound is verified by direct measurement
 * rather than here. What IS observable, and what a buggy sweep would break, is
 * that the sweep must never evict an entry whose window is still live: that
 * silently hands a client a fresh rate-limit budget mid-window.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { rateLimit } from "../../src/middleware/rateLimit.js";

/** Minimal Express req/res pair good enough for the limiter. */
function stub(ip) {
  return {
    req: { ip, id: "req-1" },
    res: {
      headers: {},
      statusCode: 200,
      setHeader(k, v) {
        this.headers[k] = v;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    },
  };
}

describe("rateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts requests and reports the remaining budget", () => {
    const mw = rateLimit({ windowMs: 10_000, max: 3 });
    const { req, res } = stub("1.1.1.1");
    mw(req, res, () => {});
    expect(res.headers["X-RateLimit-Remaining"]).toBe(2);
  });

  it("returns 429 once the window budget is spent", () => {
    const mw = rateLimit({ windowMs: 10_000, max: 2 });
    for (let i = 0; i < 2; i++) mw(stub("2.2.2.2").req, stub("2.2.2.2").res, () => {});
    const { req, res } = stub("2.2.2.2");
    mw(req, res, () => {});
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeGreaterThan(0);
  });

  it("resets the counter once the window has passed", () => {
    vi.useFakeTimers();
    const mw = rateLimit({ windowMs: 10_000, max: 2 });
    for (let i = 0; i < 2; i++) mw(stub("3.3.3.3").req, stub("3.3.3.3").res, () => {});
    vi.advanceTimersByTime(10_001);
    const { req, res } = stub("3.3.3.3");
    mw(req, res, () => {});
    expect(res.statusCode).not.toBe(429);
    expect(res.headers["X-RateLimit-Remaining"]).toBe(1);
  });

  it("does NOT evict an entry whose window is still live during the sweep", () => {
    // This is the property a broken sweep breaks: if the periodic prune drops
    // live entries, a client silently gets its whole budget back mid-window.
    vi.useFakeTimers();
    const mw = rateLimit({ windowMs: 10_000, max: 100 });

    // A client with an open window.
    const first = stub("4.4.4.4");
    mw(first.req, first.res, () => {});

    // Push past the sweep threshold with other clients, all inside A's window.
    for (let i = 0; i < 1500; i++)
      mw(stub(`5.5.${i >> 8}.${i & 255}`).req, stub("x").res, () => {});

    // A's second request must continue from its existing count of 1.
    const second = stub("4.4.4.4");
    mw(second.req, second.res, () => {});
    expect(second.res.headers["X-RateLimit-Remaining"]).toBe(98);
  });
});
