#!/usr/bin/env node
/**
 * Verify every named import in public/js resolves to a real export.
 *
 * WHY: a missing export is a FATAL module-graph error. The browser refuses to
 * evaluate the importer, so app.js never runs at all - which presents as
 * "no design", "canvas does not load", and "buttons do nothing", with nothing
 * in the console but a red line that is easy to miss. Integration tests pass
 * because they never execute the browser module graph.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "js");
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));

/** Crude but sufficient export extraction. */
function exportsOf(src) {
  const out = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
  }
  // export { a, b as c }
  const braced = /export\s*\{([^}]*)\}/g;
  let b;
  while ((b = braced.exec(src))) {
    for (const part of b[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      out.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default\b/.test(src)) out.add("default");
  return out;
}

/** Extract `import { a, b as c } from "./x.js"` bindings. */
function importsOf(src) {
  const out = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      out.push({ local: (as[1] || as[0]).trim(), imported: as[0].trim(), from: m[2] });
    }
  }
  return out;
}

const cache = new Map();
const exportCache = new Map();
function load(name) {
  if (!exportCache.has(name)) {
    const src = readFileSync(join(dir, name), "utf8");
    exportCache.set(name, exportsOf(src));
  }
  return exportCache.get(name);
}

const problems = [];
let checked = 0;

for (const file of files) {
  const src = readFileSync(join(dir, file), "utf8");
  for (const imp of importsOf(src)) {
    if (!imp.from.startsWith("./")) continue;
    const target = imp.from.replace(/^\.\//, "");
    if (!files.includes(target)) {
      problems.push(`${file}: imports missing file "${imp.from}"`);
      continue;
    }
    const available = load(target);
    checked++;
    if (!available.has(imp.imported)) {
      problems.push(
        `${file}: "${imp.imported}" is not exported by ${target} ` +
          `(exports: ${[...available].sort().join(", ") || "none"})`
      );
    }
  }
}

console.log(`checked ${checked} named imports across ${files.length} modules`);
if (problems.length) {
  console.log(`\n${problems.length} BROKEN IMPORT(S):`);
  for (const p of problems) console.log("  " + p);
  process.exit(1);
}
console.log("all named imports resolve");
