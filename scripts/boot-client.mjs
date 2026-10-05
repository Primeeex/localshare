#!/usr/bin/env node
/**
 * Boot the REAL client modules in a real DOM.
 *
 * jsdom gives us the document; we then publish the browser globals the modules
 * touch onto globalThis and let Node's own ESM loader import the files with
 * their real relative specifiers. Anything thrown during module evaluation or
 * boot() is a fatal user-facing bug that the integration suite cannot see,
 * because those tests never evaluate the browser module graph.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE || "http://127.0.0.1:3001";
const html = readFileSync(join(root, "public", "index.html"), "utf8");

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.stack || e.message)));
vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ")));
vc.on("warn", (...a) => {
  const s = a.map(String).join(" ");
  if (!/deprecat/i.test(s)) errors.push("console.warn: " + s);
});

const dom = new JSDOM(html, {
  url: BASE + "/",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const w = dom.window;

// ---- publish browser globals ----
const G = globalThis;
/** Some globals (navigator) are getter-only in Node, so define rather than assign. */
const put = (key, value) => {
  try {
    Object.defineProperty(G, key, { value, writable: true, configurable: true });
  } catch {
    /* a global we cannot replace is one the client does not depend on */
  }
};

put("window", w);
put("document", w.document);
put("navigator", w.navigator);
put("location", w.location);
put("history", w.history);
put("localStorage", w.localStorage);
put("sessionStorage", w.sessionStorage);
put("CustomEvent", w.CustomEvent);
put("Event", w.Event);
put("HTMLElement", w.HTMLElement);
put("HTMLInputElement", w.HTMLInputElement);
put("HTMLCanvasElement", w.HTMLCanvasElement);
put("Node", w.Node);
put("Element", w.Element);
put("DOMParser", w.DOMParser);
put("getComputedStyle", w.getComputedStyle.bind(w));
put("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
put("cancelAnimationFrame", (id) => clearTimeout(id));
put("matchMedia", (q) => ({
  matches: false,
  media: q,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false;
  },
}));
w.matchMedia = G.matchMedia;
w.requestAnimationFrame = G.requestAnimationFrame;

// fetch -> the real dev server. Capture Node's fetch FIRST: assigning the
// wrapper to globalThis would otherwise make it call itself forever.
const nodeFetch = globalThis.fetch;
put("fetch", (input, init = {}) => {
  const url = typeof input === "string" ? new URL(input, BASE).href : input;
  return nodeFetch(url, init);
});
w.fetch = globalThis.fetch;

class FakeEventSource {
  constructor(url) {
    this.url = String(url);
    this._l = {};
    this.onopen = null;
    this.onerror = null;
    setTimeout(() => this.onopen && this.onopen({}), 20);
  }
  addEventListener(n, fn) {
    (this._l[n] ||= []).push(fn);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
}
G.EventSource = FakeEventSource;
w.EventSource = FakeEventSource;

w.HTMLElement.prototype.scrollIntoView = function () {};

// Browser APIs jsdom does not implement that the client legitimately uses.
put("CSS", { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
// Constructable stylesheets are how the client injects swipe/delete styles.
put(
  "CSSStyleSheet",
  class {
    constructor() {
      this.cssRules = [];
    }
    replaceSync(t) {
      this._text = t;
    }
    insertRule(r) {
      this.cssRules.push(r);
      return this.cssRules.length - 1;
    }
  }
);
w.CSSStyleSheet = globalThis.CSSStyleSheet;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
put("IntersectionObserver", Observer);
put("ResizeObserver", Observer);
put("MutationObserver", w.MutationObserver || Observer);
put("Blob", w.Blob || class {});
put("File", w.File || class {});
put("FormData", w.FormData || class {});
put("crypto", globalThis.crypto);
put("alert", () => {});
put("confirm", () => true);
if (!w.URL.createObjectURL) {
  w.URL.createObjectURL = () => "blob:stub";
  w.URL.revokeObjectURL = () => {};
}
// jsdom has no canvas backend; stub the context so canvas code cannot throw.
// Record every 2D-context call so we can PROVE the canvases really draw.
// A silently-swallowed context makes "the canvas does not load" impossible to
// tell apart from "the canvas drew nothing".
const ctxCalls = { create: 0, ops: new Map() };
w.HTMLCanvasElement.prototype.getContext = function (kind) {
  if (kind !== "2d") return null;
  ctxCalls.create++;
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "canvas") return null;
        return () => {
          ctxCalls.ops.set(prop, (ctxCalls.ops.get(prop) || 0) + 1);
        };
      },
      set() {
        return true;
      },
    }
  );
};

// ---- import the real entry point (Node resolves its relative imports) ----
console.log(`booting against ${BASE}`);
try {
  await import(pathToFileURL(join(root, "public", "js", "app.js")).href);
  console.log("  app.js evaluated");
} catch (e) {
  console.log("\n!! app.js THREW during evaluation:");
  console.log(e.stack || String(e));
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 3000));

const doc = w.document;
const vis = (sel) => {
  const el = doc.querySelector(sel);
  if (!el) return "MISSING";
  return el.hidden ? "hidden" : "VISIBLE";
};

console.log("\n=== ERRORS (" + errors.length + ") ===");
for (const e of errors.slice(0, 12)) console.log("  " + e.split("\n")[0]);
if (errors.length) console.log("\nfirst stack:\n" + errors[0]);

console.log("\n=== RENDERED STATE ===");
const rows = doc.querySelectorAll(".file-row").length;
console.log("  #app hidden:        ", doc.querySelector("#app")?.hidden);
console.log("  file rows rendered: ", rows);
console.log("  skeletons left:     ", doc.querySelectorAll(".skeleton-row").length);
console.log("  empty state:        ", vis("#file-empty"));
console.log("  reconnect banner:   ", vis("#reconnect-banner"));
console.log("  disconnected overlay:", vis("#disconnected-overlay"));
console.log("  device popover:     ", vis("#device-popover"));
console.log("  room pin modal:     ", vis("#room-pin-modal"));
console.log("  drop-field canvas:  ", !!doc.querySelector("#drop-field"));
console.log("  presence canvas:    ", !!doc.querySelector("#presence-canvas"));
console.log("  room in selector:   ", doc.querySelector("#room-selector")?.value);

w.close();
// SSE stubs and uptime timers keep the loop alive; exit explicitly.
process.exit(errors.length ? 1 : 0);
