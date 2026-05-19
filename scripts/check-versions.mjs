#!/usr/bin/env node
// Asserts every publishable artifact in this repo carries the same version
// string. Used by the release workflow as a pre-publish gate: if the git tag
// is `v1.2.3`, the plugin's package.json, the client-js package.json, and
// the Kotlin Gradle version must all read `1.2.3` before publishing starts.
//
// Usage:
//   node scripts/check-versions.mjs <expected-version>
//
// When <expected-version> is omitted, it's read from process.env.TAG_VERSION
// (release workflow sets this). When neither is provided, the script still
// succeeds only if all packages already agree with the plugin's version as
// the reference — useful for a pre-commit sanity check.
//
// Exits 0 on agreement, 1 on mismatch with a specific diagnostic.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relPath) {
  const p = join(repoRoot, relPath);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    fail(`failed to read ${relPath}: ${err.message}`);
  }
}

function readGradleVersion(relPath) {
  const text = readFileSync(join(repoRoot, relPath), "utf8");
  // Match both `version = "1.2.3"` and `version = findProperty("version")?.toString() ?: "1.2.3"`.
  const match = text.match(/version\s*=.*?["']([^"']+)["']\s*$/m);
  if (!match) {
    fail(`could not locate version literal in ${relPath}`);
  }
  return match[1];
}

function fail(msg) {
  console.error(`version-check: ${msg}`);
  process.exit(1);
}

const plugin = readJson("packages/plugin/package.json");
const pluginUi = readJson("packages/plugin/ui/package.json");
const clientJs = readJson("packages/client-js/package.json");
const schema = readJson("schema/package.json");
const kotlinCore = readGradleVersion("packages/client-kotlin/core/build.gradle.kts");
const kotlinAndroid = readGradleVersion("packages/client-kotlin/android/build.gradle.kts");
const kotlinCompose = readGradleVersion("packages/client-kotlin/compose/build.gradle.kts");
const kotlinGlasses = readGradleVersion("packages/client-kotlin/glasses/build.gradle.kts");
// SwiftPM has no declared version — the git tag IS the Swift version. Skip.

const expected = process.argv[2] ?? process.env.TAG_VERSION ?? plugin.version;

const entries = [
  ["plugin", plugin.version],
  ["plugin/ui", pluginUi.version],
  ["client-js", clientJs.version],
  ["schema", schema.version],
  ["client-kotlin:core (Gradle fallback)", kotlinCore],
  ["client-kotlin:android (Gradle fallback)", kotlinAndroid],
  ["client-kotlin:compose (Gradle fallback)", kotlinCompose],
  ["client-kotlin:glasses (Gradle fallback)", kotlinGlasses],
];

let mismatch = false;
console.log(`version-check: expected=${expected}`);
for (const [name, actual] of entries) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✓" : "✗"} ${name}: ${actual}`);
  if (!ok) mismatch = true;
}

if (mismatch) {
  console.error(
    "version-check: FAIL — bump every package to the same version before tagging.",
  );
  process.exit(1);
}
console.log("version-check: OK");
