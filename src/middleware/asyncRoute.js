/**
 * Async route wrapper: catches promise rejections and passes to error handler.
 * @module middleware/asyncRoute
 */

/**
 * Wrap an async route handler to catch unhandled rejections.
 * @param {Function} fn - Async route handler
 * @returns {Function}
 */
export const asyncRoute = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
