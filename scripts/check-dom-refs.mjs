#!/usr/bin/env node
/**
 * Cross-check every $("#id") selector used by the client against public/index.html.
 *
 * WHY: app.js calls 13 bind*() functions in a row with no try/catch between
 * them. A single null element reference throws, and everything after that line
 * never runs - including the presence canvas, the drop field and the popover
 * wiring. To the user that looks like "the design and canvas do not load",
 * with no obvious cause. Catching it statically is far cheaper than in a browser.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public", "index.html"), "utf8");

const ids = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);

const jsDir = join(root, "public", "js");
const files = readdirSync(jsDir).filter((f) => f.endsWith(".js"));

const missing = new Map();

for (const file of files) {
  const src = readFileSync(join(jsDir, file), "utf8");
  src.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    // $("#foo") and $('#foo') and $("#foo").x
    for (const m of line.matchAll(/\$\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g)) {
      const id = m[1];
      if (!ids.has(id)) {
        if (!missing.has(id)) missing.set(id, []);
        missing.get(id).push(`${file}:${i + 1}`);
      }
    }
  });
}

// Optional access ($("#x")?.) and existence guards are legitimate.
const required = [];
const optional = [];
for (const [id, sites] of missing) {
  const src = readFileSync(join(jsDir, sites[0].split(":")[0]), "utf8").split("\n");
  const guarded = sites.every((s) => {
    const [f, n] = s.split(":");
    const line = readFileSync(join(jsDir, f), "utf8").split("\n")[Number(n) - 1] || "";
    return /\?\./.test(line) || /if\s*\(/.test(line);
  });
  (guarded ? optional : required).push(`${id}  (${sites[0]})`);
}

console.log(`index.html exposes ${ids.size} ids; scanned ${files.length} modules\n`);
if (optional.length) {
  console.log(`OPTIONAL / guarded (${optional.length}) - fine:`);
  for (const o of optional.sort()) console.log("  " + o);
  console.log("");
}
if (required.length) {
  console.log(`MISSING and UNGUARDED (${required.length}) - will throw:`);
  for (const r of required.sort()) console.log("  " + r);
  process.exit(1);
}
console.log("no unguarded missing ids");
