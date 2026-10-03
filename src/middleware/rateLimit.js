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

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
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
