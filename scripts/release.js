/**
 * Release helper: bump the version, promote the changelog, tag, push.
 *
 * Usage:
 *   npm run release patch           # 1.0.0 -> 1.0.1
   npm run release minor           # 1.0.0 -> 1.1.0
 *   npm run release major           # 1.0.0 -> 2.0.0
 *   npm run release patch -- --dry-run    # show the plan, touch nothing
 *   npm run release patch -- --no-push    # commit and tag locally only
 *
 * WHY: package.json is the single source of truth for the version, and the
 * v* tag is what triggers .github/workflows/release.yml to publish to npm.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noPush = args.includes("--no-push");
const bump = args.find((a) => !a.startsWith("--"));

const BUMP_TYPES = new Set(["patch", "minor", "major"]);

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(gitArgs, { allowFail = false } = {}) {
  try {
    return execFileSync("git", gitArgs, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    console.error(`release: git ${gitArgs.join(" ")} failed`);
    console.error(String(err.stdout || err.stderr || err.message));
    process.exit(1);
  }
}

function bumpVersion(version, type) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version);
  if (!match) fail(`package.json version "${version}" is not MAJOR.MINOR.PATCH`);
  let [major, minor, patch] = match.slice(1).map(Number);
  if (type === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Promote the Unreleased section of a Keep a Changelog file.
 * Returns the new changelog text.
 */
function updateChangelog(text, version, date) {
  const lines = text.split("\n");
  const unreleasedIdx = lines.findIndex((l) => l.trim() === "## [Unreleased]");
  if (unreleasedIdx === -1) fail('CHANGELOG.md has no "## [Unreleased]" section');

  // Find the next version heading after Unreleased
  let nextIdx = lines.findIndex((l, i) => i > unreleasedIdx && /^## \[\d/.test(l));
  if (nextIdx === -1) nextIdx = lines.length;

  const unreleasedBody = lines.slice(unreleasedIdx + 1, nextIdx);
  const hasContent = unreleasedBody.some((l) => l.trim() && !l.startsWith("##"));

  const newSection = [`## [${version}] - ${date}`, ""];
  if (hasContent) {
    newSection.push(...unreleasedBody.filter((l) => l.trim() || true));
  }

  const rebuilt = [
    ...lines.slice(0, unreleasedIdx + 1),
    "",
    ...newSection,
    ...lines.slice(nextIdx),
  ];

  // Keep the comparison links at the bottom in sync when reference links exist
  let out = rebuilt.join("\n");
  out = out.replace(
    /^\[Unreleased\]:\s+(\S+?)(\.\.\.)?\S+$/m,
    (_m, base) => `[Unreleased]: ${base}...v${version}`
  );
  if (!new RegExp(`^\\[${version}\\]:`, "m").test(out)) {
    const prevMatch = out.match(/^\[(\d+\.\d+\.\d+)\]:\s+(\S+?)v\d+\.\d+\.\d+$/m);
    const compareBase = prevMatch ? prevMatch[1] : version;
    out = `${out.replace(/\n+$/, "")}\n[${version}]: ${`https://github.com/Primeeex/localshare/compare/v${compareBase}...v${version}`}\n`;
  }
  return out;
}

async function main() {
  if (!bump || !BUMP_TYPES.has(bump)) {
    console.error("Usage: npm run release <patch|minor|major> [-- --dry-run] [-- --no-push]");
    process.exit(1);
  }

  const pkgPath = resolve(ROOT, "package.json");
  const changelogPath = resolve(ROOT, "CHANGELOG.md");

  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const nextVersion = bumpVersion(pkg.version, bump);

  const isRepo = git(["rev-parse", "--is-inside-work-tree"], { allowFail: true }) !== null;
  const hasOrigin = git(["remote", "get-url", "origin"], { allowFail: true }) !== null;

  if (isRepo) {
    const dirty = git(["status", "--porcelain"]);
    if (dirty && !dryRun) {
      fail("working tree is not clean, commit or stash changes first");
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  let changelog = null;
  try {
    changelog = await readFile(changelogPath, "utf8");
  } catch {
    fail("CHANGELOG.md not found");
  }
  const nextChangelog = updateChangelog(changelog, nextVersion, date);

  console.log(`release: ${pkg.version} -> ${nextVersion} (${bump})`);

  if (dryRun) {
    console.log("release: dry run, no files changed");
    console.log(nextChangelog.split("\n").slice(0, 30).join("\n"));
    return;
  }

  pkg.version = nextVersion;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(changelogPath, nextChangelog);
  console.log("release: updated package.json and CHANGELOG.md");

  if (!isRepo) {
    console.log("release: not a git repository, skipped commit, tag and push");
    return;
  }

  git(["add", "package.json", "CHANGELOG.md"]);
  git(["commit", "-m", `release: v${nextVersion}`]);
  git(["tag", "-a", `v${nextVersion}`, "-m", `v${nextVersion}`]);
  console.log(`release: committed and tagged v${nextVersion}`);

  if (noPush) {
    console.log(
      "release: skipped push (--no-push). Push manually with: git push && git push --tags"
    );
    return;
  }

  if (!hasOrigin) {
    console.log(
      'release: no "origin" remote configured, skipped push. Add one with: git remote add origin <url>'
    );
    return;
  }

  git(["push"]);
  git(["push", "--tags"]);
  console.log(`release: pushed v${nextVersion}. The release workflow publishes to npm.`);
}

main().catch((err) => {
  console.error(`release failed: ${err.stack || err.message}`);
  process.exit(1);
});
