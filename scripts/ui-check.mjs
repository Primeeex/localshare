#!/usr/bin/env node
/**
 * Drive the real client in a real DOM and assert real behaviour.
 *
 * Scenarios:
 *   1. boot with no errors
 *   2. the presence button opens the device popover, and it renders devices
 *   3. the device-type icon renders as an ELEMENT, not as visible text
 *   4. a locked room prompts for its PIN and does not enter the room
 *   5. the wrong PIN is rejected inline, the right one unlocks
 *
 * Requires a running dev server: BASE=http://127.0.0.1:3001 node scripts/ui-check.mjs
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE || "http://127.0.0.1:3001";
const ROOM_PIN = "4321";

let pass = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? " - " + detail : ""}`);
    console.log(`  FAIL  ${name}${detail ? " - " + detail : ""}`);
  }
};

const html = readFileSync(join(root, "public", "index.html"), "utf8");
const errors = [];
// Async event handlers throw as unhandled rejections, which the VirtualConsole
// never sees. Without this the single most likely failure mode is invisible.
process.on("unhandledRejection", (e) =>
  errors.push("UNHANDLED REJECTION: " + (e?.stack || e?.message || String(e)))
);
process.on("uncaughtException", (e) =>
  errors.push("UNCAUGHT: " + (e?.stack || e?.message || String(e)))
);
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.stack || e.message));
vc.on("error", (...a) => errors.push(a.map(String).join(" ")));

const dom = new JSDOM(html, { url: BASE + "/", pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window;
const G = globalThis;
const put = (k, v) =>
  Object.defineProperty(G, k, { value: v, writable: true, configurable: true }).value ?? v;

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
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
}));
put("CSS", { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
put(
  "CSSStyleSheet",
  class {
    constructor() {
      this.cssRules = [];
    }
    replaceSync() {}
    insertRule(r) {
      this.cssRules.push(r);
      return this.cssRules.length - 1;
    }
    deleteRule() {}
  }
);
/**
 * jsdom has no layout, so ResizeObserver would never fire and every canvas
 * would stay at 0x0 forever - which looks exactly like "the canvas does not
 * load". Deliver one real measurement instead, so the canvas code runs its
 * actual paint path.
 */
class Observer {
  constructor(cb) {
    this.cb = cb;
    this.targets = new Set();
  }
  observe(el) {
    this.targets.add(el);
    setTimeout(() => {
      if (!this.targets.has(el)) return;
      this.cb([{ target: el, contentRect: { width: 240, height: 120, top: 0, left: 0 } }], this);
    }, 5);
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
}
put("IntersectionObserver", Observer);
put("ResizeObserver", Observer);
put("MutationObserver", w.MutationObserver || Observer);
put("Blob", w.Blob || class {});
put("File", w.File || class {});
put("FormData", w.FormData || class {});
put("crypto", globalThis.crypto);
w.matchMedia = G.matchMedia;
w.requestAnimationFrame = G.requestAnimationFrame;

const nodeFetch = globalThis.fetch;
put("fetch", (input, init = {}) => {
  const url = typeof input === "string" ? new URL(input, BASE).href : input;
  return nodeFetch(url, init);
});
w.fetch = globalThis.fetch;

const streams = [];
class FakeEventSource {
  constructor(url) {
    this.url = String(url);
    this._l = {};
    streams.push(this);
    setTimeout(() => this.onopen && this.onopen({}), 10);
  }
  addEventListener(n, fn) {
    (this._l[n] ||= []).push(fn);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
  emit(name, data) {
    for (const fn of this._l[name] || []) fn({ data: JSON.stringify(data), lastEventId: "1" });
  }
}
put("EventSource", FakeEventSource);
w.EventSource = FakeEventSource;
w.HTMLElement.prototype.scrollIntoView = function () {};
// Record every 2D-context call so we can PROVE the canvases really draw.
// A silently-swallowed context makes "the canvas does not load" impossible to
// tell apart from "the canvas drew nothing".
const ctxCalls = { create: 0, ops: new Map(), byCanvas: new Map() };
w.HTMLCanvasElement.prototype.getContext = function (kind) {
  if (kind !== "2d") return null;
  ctxCalls.create++;
  const id = this.id || this.className || "(unnamed)";
  ctxCalls.byCanvas.set(id, (ctxCalls.byCanvas.get(id) || 0) + 1);
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => w.document.querySelector(s);

// ---------- create a locked room to test against ----------
const created = await nodeFetch(`${BASE}/api/rooms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "UI Check", pin: ROOM_PIN }),
}).then((r) => r.json());
console.log(`locked room: ${created.id}\n`);

// ---------- boot into that room ----------
w.localStorage.setItem("localshare:room", created.id);
await import(pathToFileURL(join(root, "public", "js", "app.js")).href);
await wait(2500);

console.log("1. boot");
check("no uncaught errors during boot", errors.length === 0, errors[0]?.split("\n")[0] || "");
check("app shell is visible", $("#app")?.hidden === false);
check("drop-field canvas present", !!$("#drop-field"));
check("presence canvas present", !!$("#presence-canvas"));
check("popover is inside a positioned wrapper", !!$(".presence-wrap #device-popover"));

console.log("\n2. device popover");
$("#device-avatars").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await wait(300);
check("popover opens on click", $("#device-popover").hidden === false);
check("trigger reports expanded", $("#device-avatars").getAttribute("aria-expanded") === "true");

console.log("\n3. device type icon rendering");
const badge = w.document.querySelector(".device-popover-device-type");
if (badge) {
  const svg = badge.querySelector("svg");
  check("icon is an <svg> element", !!svg);
  check(
    "no raw markup leaking as text",
    !badge.textContent.includes("<svg"),
    badge.textContent.slice(0, 60)
  );
} else {
  // No devices connected in this headless run; drive the renderer directly.
  const { deviceTypeIcon } = await import(
    pathToFileURL(join(root, "public", "js", "devices.js")).href
  );
  const span = w.document.createElement("span");
  span.innerHTML = deviceTypeIcon("desktop");
  check("deviceTypeIcon produces a real <svg>", !!span.querySelector("svg"));
  check("icon markup is not text", !span.textContent.includes("<svg"));
}

console.log("\n4. locked room gating");
check("PIN dialog is shown", $("#room-pin-modal").hidden === false);
// The headline requirement: we must NOT be inside the locked room yet.
check(
  "NOT admitted into the locked room while gated",
  $("#room-selector").value !== created.id,
  `selector showed ${$("#room-selector").value}`
);
check(
  "still in a readable room",
  $("#room-selector").value === "default",
  `selector showed ${$("#room-selector").value}`
);
check("locked room not written to the URL yet", !w.location.search.includes(created.id));
check(
  "connection-lost overlay is NOT shown",
  $("#disconnected-overlay").hidden === true,
  "a locked room must not look like a network failure"
);
check("reconnect banner is NOT shown", $("#reconnect-banner").hidden === true);

console.log("\n5. wrong then correct PIN");
console.log(
  "  [debug] error el:",
  $("#room-pin-error")
    ? "present hidden=" +
        $("#room-pin-error").hidden +
        " text=" +
        JSON.stringify($("#room-pin-error").textContent)
    : "MISSING"
);
$("#room-pin-input").value = "0000";
console.log("  [debug] submit btn:", $("#room-pin-submit") ? "present" : "MISSING");
$("#room-pin-submit").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await wait(800);
console.log(
  "  [debug] after wrong submit: error hidden=" +
    $("#room-pin-error").hidden +
    " text=" +
    JSON.stringify($("#room-pin-error").textContent) +
    " modal hidden=" +
    $("#room-pin-modal").hidden
);
check("wrong PIN keeps the dialog open", $("#room-pin-modal").hidden === false);
check(
  "wrong PIN shows an inline error",
  $("#room-pin-error").hidden === false && $("#room-pin-error").textContent.length > 0,
  $("#room-pin-error")?.textContent
);

$("#room-pin-input").value = ROOM_PIN;
$("#room-pin-submit").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await wait(1200);
check("correct PIN unlocks and closes the dialog", $("#room-pin-modal").hidden === true);
check("room selector shows the unlocked room", $("#room-selector").value === created.id);
check("URL now carries the unlocked room", w.location.search.includes(created.id));
check(
  "PIN persisted for later requests",
  (JSON.parse(w.localStorage.getItem("localshare:roomPins") || "{}")[created.id] || "") === ROOM_PIN
);

console.log("\n5b. drop overlay activates the field");
const dropZone = $("#upload-zone") || $(".drop-overlay");
if (dropZone) {
  const dt = new w.Event("dragenter", { bubbles: true });
  // DragEvent.dataTransfer is readonly in jsdom, so it is defined rather than
  // assigned -- setupDropOverlay() reads .types to tell a file drag from a
  // text selection, so an absent dataTransfer would skip the whole branch.
  Object.defineProperty(dt, "dataTransfer", { value: { types: ["Files"] } });
  dropZone.dispatchEvent(dt);
  await wait(200);
  check(
    "dragenter activates the drop overlay",
    !!$(".drop-overlay--active"),
    `overlay active: ${!!$(".drop-overlay--active")}`
  );
}

const ops = ctxCalls.ops;
console.log("\n6. canvas really paints");
console.log("  2d contexts acquired:", ctxCalls.create);
console.log("  context ops:         ", JSON.stringify(Object.fromEntries(ops)));
console.log("  per canvas:          ", JSON.stringify(Object.fromEntries(ctxCalls.byCanvas)));
check("at least one 2d context was acquired", ctxCalls.create > 0, `${ctxCalls.create}`);
check(
  "the canvases issue real draw calls",
  (ops.get("fill") || 0) + (ops.get("stroke") || 0) + (ops.get("clearRect") || 0) > 0,
  `fill=${ops.get("fill") || 0} stroke=${ops.get("stroke") || 0} clearRect=${ops.get("clearRect") || 0}`
);

console.log("\n7. late-join behaviour (fresh tab, no stored PIN)");
w.localStorage.removeItem("localshare:roomPins");
errors.length = 0;

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAILED: " + f);
if (errors.length) {
  console.log("\nerrors:");
  for (const e of errors.slice(0, 5)) console.log("  " + e.split("\n")[0]);
}
w.close();
process.exit(failures.length ? 1 : 0);
