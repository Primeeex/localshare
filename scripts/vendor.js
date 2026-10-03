/**
 * Downloads and pins vendored browser dependencies into public/vendor/.
 *
 * WHY: the web UI must never depend on a CDN at runtime, so the only client
 * side library (qrcode.js) is vendored and its SHA-256 is pinned in
 * scripts/vendor-lock.json. Running this script twice is a no-op when the
 * pinned files already match.
 *
 * Usage:
 *   node scripts/vendor.js          # download anything missing, update lock
 *   node scripts/vendor.js --check  # verify pinned files only, never download
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOCK_PATH = resolve(__dirname, "vendor-lock.json");

const TARGETS = [
  {
    name: "qrcode.min.js",
    version: "1.0.0",
    url: "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js",
    license: "MIT",
    source: "https://github.com/davidshimjs/qrcodejs",
  },
];

const checkOnly = process.argv.includes("--check");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function loadLock() {
  try {
    return JSON.parse(await readFile(LOCK_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function saveLock(lock) {
  await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

async function fetchBuffer(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "localshare-vendor/1.0" },
  });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

let failures = 0;

async function main() {
  const lock = await loadLock();
  await mkdir(resolve(ROOT, "public", "vendor"), { recursive: true });

  for (const target of TARGETS) {
    const dest = resolve(ROOT, "public", "vendor", target.name);
    const pinned = lock[target.name];

    let current = null;
    try {
      const bytes = await readFile(dest);
      current = sha256(bytes);
    } catch {
      current = null;
    }

    if (current && pinned && current === pinned.sha256) {
      console.log(`ok       ${target.name} (pinned ${pinned.sha256.slice(0, 12)}...)`);
      continue;
    }

    if (checkOnly) {
      console.error(
        `FAIL     ${target.name} ${current ? "does not match the pinned hash" : "is missing (run npm run vendor)"}`
      );
      failures += 1;
      continue;
    }

    console.log(`fetch    ${target.url}`);
    const bytes = await fetchBuffer(target.url);
    const hash = sha256(bytes);

    if (pinned && current === null && pinned.sha256 !== hash) {
      console.error(
        `FAIL     ${target.name} remote content no longer matches pinned hash ${pinned.sha256}`
      );
      failures += 1;
      continue;
    }

    await writeFile(dest, bytes);
    lock[target.name] = {
      version: target.version,
      url: target.url,
      sha256: hash,
      bytes: bytes.length,
      license: target.license,
      source: target.source,
    };
    console.log(`pinned   ${target.name} ${hash} (${bytes.length} bytes)`);
  }

  if (!checkOnly && failures === 0) {
    await saveLock(lock);
    console.log(`lock     scripts/vendor-lock.json`);
  }

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`vendor failed: ${err.message}`);
  process.exit(1);
});
