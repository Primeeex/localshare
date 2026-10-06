/**
 * Rate limiting middleware using an in-memory store.
 * @module middleware/rateLimit
 */

/**
 * Create a rate limiter middleware.
 * @param {Object} options
 * @param {number} [options.windowMs=900000] - Window in milliseconds (15 min default)
 * @param {number} [options.max=100] - Max requests per window
 * @param {string} [options.message='Too many requests, please try again later.']
 * @param {Function} [options.keyGenerator] - Custom key generator (default: req.ip)
 * @returns {Function} Express middleware
 */
export function rateLimit(options = {}) {
  const {
    windowMs = 15 * 60 * 1000,
    max = 100,
    message = "Too many requests, please try again later.",
    keyGenerator = (req) => req.ip,
  } = options;

  // WHY: in-memory store is sufficient for single-process LocalShare
  const store = new Map();

  // WHY the sweep: nothing ever removed a key, so every distinct source IP
  // that ever touched the API stayed resident for the lifetime of the process.
  // On a hostile network that is a slow memory leak with no way to recover --
  // spec 19 caps the server at 50MB RSS. Sweeping on a request count rather
  // than a timer avoids a handle per limiter (the app builds several, and the
  // test suite builds one per app) and still bounds the store.
  const SWEEP_EVERY = 1000;
  let requestsSinceSweep = 0;
  function sweepExpired(now) {
    for (const [key, value] of store) {
      if (now > value.resetAt) store.delete(key);
    }
  }

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();

    if (++requestsSinceSweep >= SWEEP_EVERY) {
      requestsSinceSweep = 0;
      sweepExpired(now);
    }

    const record = store.get(key) || { count: 0, resetAt: now + windowMs };

    // Reset if window has expired
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }

    record.count++;
    store.set(key, record);

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - record.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(record.resetAt / 1000));

    if (record.count > max) {
      res.setHeader("Retry-After", Math.ceil((record.resetAt - now) / 1000));
      return res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message,
          requestId: req.id,
          timestamp: new Date().toISOString(),
        },
      });
    }

    next();
  };
}
