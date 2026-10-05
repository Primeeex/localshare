/**
 * Client boot regression tests.
 *
 * WHY these exist: three separate bugs made the whole front-end silently dead
 * - no canvas, no data, buttons that did nothing - and NONE of them were
 * visible to the integration suite, because those tests never evaluate the
 * browser module graph. Each test below reproduces one of them.
 *
 *   1. bindSwipeToDelete spread `document.adoptedStyleSheets`, which is
 *      undefined in Safari/iOS < 16.4. The TypeError aborted startApp()
 *      before the presence canvas, drop field, room load and SSE were wired.
 *   2. openOverlay() calls closeAll({silent:true}), and closeAll dispatches
 *      "localshare:overlays-closed" unconditionally. The PIN dialog bound its
 *      listener BEFORE opening, so opening cancelled the dialog: it rendered
 *      with the Unlock button already unbound.
 *   3. The device popover sat outside any positioned ancestor, so top:100%
 *      resolved against the viewport and it rendered a screen-height down.
 *
 * The client is imported for real against the real index.html. That only works
 * with jsdom, which is why it is a devDependency.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, "..", "..");
const indexHtml = readFileSync(join(rootDir, "public", "index.html"), "utf8");
const appPath = pathToFileURL(join(rootDir, "public", "js", "app.js")).href;

/**
 * @param {object} opts
 * @param {(path: string) => {status: number, body: any}} opts.handler
 * @param {boolean} opts.withoutAdoptedStyleSheets emulate Safari < 16.4
 * @param {string} opts.roomId the room the client should try to open
 */
async function bootClient({
  handler,
  withoutAdoptedStyleSheets = false,
  roomId = "locked",
  sseFails = false,
}) {
  const consoleErrors = [];
  const rejections = [];
  const onRejection = (e) => rejections.push(e?.stack || String(e));
  process.on("unhandledRejection", onRejection);

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => consoleErrors.push(e.stack || e.message));
  virtualConsole.on("error", (...a) => consoleErrors.push(a.map(String).join(" ")));
  virtualConsole.on("warn", (...a) => consoleErrors.push("[warn] " + a.map(String).join(" ")));

  const dom = new JSDOM(indexHtml, {
    url: "http://127.0.0.1/",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const w = dom.window;

  // Seed jsdom's OWN localStorage. Stubbing globalThis.localStorage instead
  // does not work: bootClient then rebinds the global to w.localStorage, and
  // the client silently reads an empty store and opens the default room.
  w.localStorage.setItem("localshare:room", roomId);
  w.localStorage.setItem("localshare:deviceName", "Test Device");

  const g = globalThis;
  const define = (key, value) =>
    Object.defineProperty(g, key, { value, writable: true, configurable: true });

  define("window", w);
  define("document", w.document);
  define("navigator", w.navigator);
  define("location", w.location);
  define("history", w.history);
  define("localStorage", w.localStorage);
  define("sessionStorage", w.sessionStorage);
  define("CustomEvent", w.CustomEvent);
  define("Event", w.Event);
  define("HTMLElement", w.HTMLElement);
  define("HTMLInputElement", w.HTMLInputElement);
  define("HTMLCanvasElement", w.HTMLCanvasElement);
  define("Node", w.Node);
  define("Element", w.Element);
  define("DOMParser", w.DOMParser);
  define("getComputedStyle", w.getComputedStyle.bind(w));
  define("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
  define("cancelAnimationFrame", (id) => clearTimeout(id));
  define("matchMedia", (q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  define("CSS", {
    escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c),
  });

  // THE FAULT INJECTION: Safari and iOS Safari before 16.4 have neither
  // constructable stylesheets nor adoptedStyleSheets.
  if (withoutAdoptedStyleSheets) {
    define("CSSStyleSheet", undefined);
    Object.defineProperty(w.document, "adoptedStyleSheets", {
      value: undefined,
      configurable: true,
    });
  } else {
    define(
      "CSSStyleSheet",
      class {
        constructor() {
          this.cssRules = [];
        }
        replaceSync() {}
        insertRule(rule) {
          this.cssRules.push(rule);
          return this.cssRules.length - 1;
        }
        deleteRule() {}
      }
    );
  }

  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  define("IntersectionObserver", Observer);
  define("ResizeObserver", Observer);
  define("MutationObserver", w.MutationObserver || Observer);
  define("Blob", w.Blob || class {});
  define("File", w.File || class {});
  define("FormData", w.FormData || class {});
  define("crypto", globalThis.crypto);

  w.matchMedia = g.matchMedia;
  w.requestAnimationFrame = g.requestAnimationFrame;

  // Recorded so a test can assert on *what was requested*, not just on state.
  const fetches = [];
  define("fetch", async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const path = url.replace("http://127.0.0.1", "");
    fetches.push(`${init?.method || "GET"} ${path}`);
    const headers = init?.headers || {};
    const pin = headers["X-Room-Pin"] || headers["x-room-pin"];
    const { status, body } = handler(path, pin);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  w.fetch = g.fetch;

  define(
    "EventSource",
    class {
      constructor(url) {
        this.url = url;
        this._l = {};
        // `sseFails` makes the stream fail the way a real EventSource does when
        // the server answers 404 or 401: onerror, with no status code exposed.
        setTimeout(() => {
          if (sseFails) this.onerror && this.onerror({});
          else this.onopen && this.onopen({});
        }, 5);
      }
      addEventListener(n, fn) {
        (this._l[n] ||= []).push(fn);
      }
      removeEventListener() {}
      close() {
        this.closed = true;
      }
    }
  );
  w.EventSource = g.EventSource;

  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLCanvasElement.prototype.getContext = () =>
    new Proxy({}, { get: () => () => {}, set: () => true });

  // A cache-busting query makes each import a fresh module instance, so state
  // from a previous test cannot leak into this one.
  await import(`${appPath}?boot=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 400));

  const cleanup = () => {
    process.off("unhandledRejection", onRejection);
    w.close();
  };
  return { w, doc: w.document, consoleErrors, rejections, fetches, cleanup };
}

/** A room list plus a lock: every room-scoped read answers 401. */
const lockedRoomHandler = (path, pin) => {
  if (path.startsWith("/api/auth/status")) {
    return { status: 200, body: { authenticated: false, pinRequired: false } };
  }
  // GET /api/rooms answers with a bare array, not an envelope.
  if (path === "/api/rooms" || path === "/api/rooms/") {
    return {
      status: 200,
      body: [
        { id: "default", name: "Default Room", fileCount: 0, deviceCount: 0 },
        { id: "locked", name: "Locked", fileCount: 0, deviceCount: 0, hasPin: true },
      ],
    };
  }
  if (path.startsWith("/api/rooms/")) {
    // A PIN was supplied and it is wrong: AUTH_INVALID, not AUTH_REQUIRED.
    if (pin === "0000") {
      return {
        status: 401,
        body: {
          error: {
            code: "AUTH_INVALID",
            message: "Incorrect room PIN",
            roomId: "locked",
            requiresRoomPin: true,
          },
        },
      };
    }
    return {
      status: 401,
      body: {
        error: {
          code: "AUTH_REQUIRED",
          message: "Room PIN required",
          roomId: "locked",
          requiresRoomPin: true,
        },
      },
    };
  }
  return { status: 200, body: [] };
};

/**
 * A room the server does not have. /events no longer auto-creates rooms, so
 * joining one now 404s. The client must recognise that as permanent instead of
 * retrying it on the backoff loop -- which is how a missing room turned into a
 * permanent "Connection lost - Reconnecting in Xs..." that never recovered.
 */
const missingRoomHandler = (path) => {
  if (path.startsWith("/api/auth/status")) {
    return { status: 200, body: { authenticated: false, pinRequired: false } };
  }
  if (path === "/api/rooms" || path === "/api/rooms/") {
    return {
      status: 200,
      body: [{ id: "default", name: "Default Room", fileCount: 0, deviceCount: 0 }],
    };
  }
  if (path.includes("/events")) {
    // The HEAD probe. 404 = the room does not exist, and no retry can fix it.
    return { status: 404, body: { error: { code: "ROOM_NOT_FOUND", message: "Room not found" } } };
  }
  // Only "ghost" is missing. The default room answers normally, exactly as it
  // would on a real server -- the fallback has somewhere to land.
  if (path.startsWith("/api/rooms/ghost")) {
    return { status: 404, body: { error: { code: "ROOM_NOT_FOUND", message: "Room not found" } } };
  }
  if (path.startsWith("/api/rooms/")) return { status: 200, body: [] };
  return { status: 200, body: [] };
};

describe("client boot in a real DOM", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  describe("joining a room that does not exist", () => {
    beforeEach(async () => {
      ctx = await bootClient({ handler: missingRoomHandler, roomId: "ghost", sseFails: true });
    });

    it("does not show a reconnect banner or a lost-connection overlay", async () => {
      // The failure mode this guards: the SSE backoff loop retrying a 404 for
      // ever, which surfaces to the user as "Connection lost" that never
      // recovers. `_classifyFailure()` must return "notfound" so the loop stops.
      await waitFor(
        () => ctx.fetches.some((f) => f.includes("/events")),
        3000,
        "SSE connect attempted"
      );
      expect(ctx.doc.querySelector("#disconnected-overlay").hidden).toBe(true);
      expect(ctx.doc.querySelector("#reconnect-banner").hidden).toBe(true);
    });

    it("classifies the failure with a HEAD probe rather than a full stream", async () => {
      await waitFor(() => ctx.fetches.some((f) => f.includes("/events")), 3000);
      // The classification must be a HEAD: a GET would open a second stream.
      expect(ctx.fetches.some((f) => f.startsWith("HEAD ") && f.includes("/events"))).toBe(true);
    });
  });

  describe("without adoptedStyleSheets (Safari < 16.4)", () => {
    beforeEach(async () => {
      ctx = await bootClient({
        handler: lockedRoomHandler,
        withoutAdoptedStyleSheets: true,
        roomId: "locked",
      });
    });

    it("does not throw during startApp()", () => {
      expect(ctx.consoleErrors.join("\n")).toBe("");
      expect(ctx.rejections.join("\n")).toBe("");
    });

    it("still wires up everything that runs after bindSwipeToDelete", async () => {
      // Everything below is bound AFTER the swipe helper in startApp(), so it
      // never ran before the fix. That is precisely why no canvas appeared and
      // the room never loaded.
      expect(ctx.doc.querySelector("#presence-canvas")).toBeTruthy();
      expect(ctx.doc.querySelector("#drop-field")).toBeTruthy();
      expect(ctx.doc.querySelector("#upload-zone")).toBeTruthy();

      // startUptimeClock() is the last bind before the data load, and its
      // first tick lands 1s later - so a live clock proves startApp() ran all
      // the way to the end rather than aborting partway through.
      await waitFor(() => ctx.doc.querySelector("#status-uptime")?.textContent?.length > 0, 2500);
      expect(ctx.doc.querySelector("#status-uptime").textContent).toMatch(/^\d+s$/);
    });

    it("reaches the room-pin prompt rather than dying earlier", () => {
      expect(ctx.doc.querySelector("#room-pin-modal").hidden).toBe(false);
    });
  });

  describe("with adoptedStyleSheets (modern Chrome/Firefox)", () => {
    beforeEach(async () => {
      ctx = await bootClient({ handler: lockedRoomHandler, roomId: "locked" });
    });

    it("boots without errors", () => {
      expect(ctx.consoleErrors.join("\n")).toBe("");
    });

    it("still responds on the Unlock button after the dialog opened", async () => {
      // THE regression: openOverlay() calls closeAll({silent:true}), and
      // closeAll dispatches "localshare:overlays-closed" unconditionally. A
      // dialog that bound its listeners before opening cancelled itself on
      // open, so the button was dead. Assert on real behaviour, not wiring:
      // submit a wrong PIN and require the inline error to appear.
      const input = ctx.doc.querySelector("#room-pin-input");
      const submit = ctx.doc.querySelector("#room-pin-submit");
      expect(input).toBeTruthy();
      expect(submit).toBeTruthy();

      input.value = "0000";
      submit.dispatchEvent(new ctx.w.MouseEvent("click", { bubbles: true }));

      const errorEl = ctx.doc.querySelector("#room-pin-error");
      const appeared = await waitFor(() => errorEl.hidden === false, 2000);
      expect(appeared, "Unlock button did nothing: the dialog listeners were torn down").toBe(true);
      expect(errorEl.textContent).toMatch(/not correct/i);

      // A wrong PIN must not admit the user, and must not close the dialog.
      expect(ctx.doc.querySelector("#room-pin-modal").hidden).toBe(false);
      expect(ctx.doc.querySelector("#room-selector").value).not.toBe("locked");
    });

    it("does not admit the user into the locked room before the PIN verifies", () => {
      expect(ctx.doc.querySelector("#room-selector").value).not.toBe("locked");
      expect(ctx.doc.querySelector("#room-selector").value).toBe("default");
    });

    it("anchors the device popover inside a positioned ancestor", () => {
      const popover = ctx.doc.querySelector("#device-popover");
      expect(popover).toBeTruthy();
      // Without a positioned ancestor, top:100% resolves against the viewport.
      const wrapper = popover.parentElement;
      expect(wrapper.classList.contains("presence-wrap")).toBe(true);

      const css = readFileSync(join(rootDir, "public", "css", "components.css"), "utf8");
      expect(css).toMatch(/\.presence-wrap\s*\{[^}]*position:\s*relative/);
    });

    it("hides the disconnected overlay for a PIN rejection, not a network fault", () => {
      // A locked room must not be dressed up as a connection failure.
      expect(ctx.doc.querySelector("#disconnected-overlay").hidden).toBe(true);
      expect(ctx.doc.querySelector("#reconnect-banner").hidden).toBe(true);
    });
  });
});

/** Poll a predicate until it is true, or fail after `timeout` ms. */
async function waitFor(predicate, timeout = 2000, step = 50) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}
