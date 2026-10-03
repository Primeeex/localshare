/**
 * Structured logger using pino.
 * @module logger
 */

import pino from "pino";

/**
 * Create a configured pino logger.
 * WHY: the pretty transport must be passed as `opts.transport` (worker-based);
 * passing it as the second argument makes pino treat it as a destination stream
 * and crash with "stream.write is not a function".
 * @param {Object} config - Logger configuration from loadConfig
 * @returns {pino.Logger}
 */
export function createLogger(config) {
  const level = config.logLevel || "info";

  const options = {
    level,
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (level !== "silent" && config.logFormat !== "json") {
    options.transport = {
      target: "pino-pretty",
      options: {
        // WHY: --no-color keeps the readable format but drops ANSI escapes
        colorize: config.colorize !== false,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    };
  }

  return pino(options);
}
