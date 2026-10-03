/**
 * Vitest configuration for LocalShare.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    // WHY: file-system cleanup and SSE sockets need real handles, not fake timers
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.js", "bin/**/*.js"],
      exclude: ["src/middleware/rateLimit.js"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
