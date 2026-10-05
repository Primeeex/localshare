/**
 * Guard against a DOM bug that shipped once already: passing an SVG *string*
 * to Element.append() / appendChild() creates a TEXT node, so the raw
 * "<svg width=...>" markup is painted on screen instead of an icon.
 *
 * The device popover did exactly this and showed the markup verbatim to the
 * user. It cannot be caught by the integration suite (the rendering is
 * client-side), and it must not need a browser to detect, so this is a static
 * source check: the correct way to use an icon string is innerHTML.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const jsDir = join(here, "..", "..", "public", "js");

/** Files that legitimately render icon markup into a string context. */
const STRING_CONTEXT_ALLOWLIST = new Set(["icons.js", "files.js", "toast.js"]);

/** Detect `append(`/`appendChild(` whose first argument is a known icon-string call. */
const ICON_CALL = /\b(?:deviceTypeIcon|iconFor|icon)\s*\(/;
const NODE_APPEND_CALL = /\.(?:append|appendChild|prepend|replaceChildren)\s*\(/;

describe("client DOM icon rendering", () => {
  const files = readdirSync(jsDir).filter((f) => f.endsWith(".js"));

  it("has client modules to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never passes an icon string to a DOM insertion method", () => {
    const offenders = [];

    for (const file of files) {
      if (STRING_CONTEXT_ALLOWLIST.has(file)) continue;
      const source = readFileSync(join(jsDir, file), "utf8");
      const lines = source.split("\n");

      lines.forEach((line, i) => {
        // Skip comments - they mention the API but never execute.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

        if (!NODE_APPEND_CALL.test(line) || !ICON_CALL.test(line)) return;

        offenders.push(`${file}:${i + 1}: ${trimmed}`);
      });
    }

    expect(
      offenders,
      `An icon string was passed to a DOM insertion method. Element.append() with a\n` +
        `string creates a TEXT node and renders the raw markup. Use innerHTML instead.\n\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("renders device type icons through innerHTML", () => {
    // The exact regression: the popover badge used append(deviceTypeIcon(...)).
    const source = readFileSync(join(jsDir, "app.js"), "utf8");
    expect(source).toContain("innerHTML = deviceTypeIcon(");
  });
});
