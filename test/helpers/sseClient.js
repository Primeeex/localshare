/**
 * Minimal SSE client for integration tests.
 * @module test/helpers/sseClient
 */

import http from "node:http";

/**
 * Connect to an SSE endpoint and collect named events.
 * @param {string} baseUrl - e.g. http://127.0.0.1:3000
 * @param {Object} params - Query params (roomId, deviceId, deviceName)
 * @returns {{ events: Array<{event: string, data: Object}>, waitFor: Function, raw: string, close: Function }}
 */
export function connectSSE(baseUrl, params = {}) {
  const url = new URL("/events", baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const state = {
    events: [],
    raw: "",
    waiters: [],
    closed: false,
    statusCode: null,
    headers: null,
  };

  state.req = http.get(
    {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}?${url.searchParams.toString()}`,
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      state.statusCode = res.statusCode;
      state.headers = res.headers;
      let buffer = "";
      res.on("data", (chunk) => {
        state.raw += chunk.toString();
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          parseBlock(block, state);
        }
      });
    }
  );

  state.req.on("error", () => {
    state.closed = true;
  });

  state.waitFor = (eventType, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const existing = state.events.find((e) => e.event === eventType);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => {
        state.waiters = state.waiters.filter((w) => w !== waiter);
        reject(new Error(`Timed out waiting for "${eventType}" event`));
      }, timeoutMs);
      const waiter = {
        eventType,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      state.waiters.push(waiter);
    });

  state.close = () => {
    state.closed = true;
    state.req.destroy();
  };

  return state;
}

function parseBlock(block, state) {
  let event = "message";
  let id = "";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("id: ")) id = line.slice(4).trim();
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    // comment lines like ": ping" are ignored for event parsing
  }
  if (dataLines.length === 0 && event === "message") return;
  let data = {};
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = { raw: dataLines.join("\n") };
  }
  const entry = { event, id, data };
  state.events.push(entry);
  for (const waiter of [...state.waiters]) {
    if (waiter.eventType === event) {
      state.waiters = state.waiters.filter((w) => w !== waiter);
      waiter.resolve(entry);
    }
  }
}
