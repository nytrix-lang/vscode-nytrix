"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { findExtensionRoot } = require("./extension_root");
const { productionDependencyDirs } = require("../scripts/package");

const root = findExtensionRoot();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const json = (...parts) => JSON.parse(read(...parts));

const manifest = json("package.json");
const grammar = json("nytrix.tmLanguage.json");
const snippets = json("snippets", "nytrix.code-snippets");
const extensionSource = read("src", "extension.js");

function regexSet(text, pattern, map = (match) => match[1]) {
  return new Set([...String(text).matchAll(pattern)].map(map));
}

function commandActivations() {
  return new Set((manifest.activationEvents || [])
    .filter((event) => event.startsWith("onCommand:nytrix."))
    .map((event) => event.slice("onCommand:".length)));
}

function contributedCommands() {
  return new Set((manifest.contributes.commands || []).map((command) => command.command));
}

function registeredCommands() {
  return regexSet(extensionSource, /\[\s*"(nytrix\.[A-Za-z0-9_.-]+)"\s*,/g);
}

function walkthroughCommands() {
  const events = (manifest.contributes.walkthroughs || [])
    .flatMap((walkthrough) => walkthrough.steps || [])
    .flatMap((step) => step.completionEvents || []);
  return new Set(events
    .filter((event) => event.startsWith("onCommand:nytrix."))
    .map((event) => event.slice("onCommand:".length)));
}

function configKeysFromCode() {
  return regexSet(extensionSource, /cfg\(\)\.get\("([^"]+)"/g, (match) => `nytrix.${match[1]}`);
}

function flattenStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  return value && typeof value === "object" ? Object.values(value).flatMap(flattenStrings) : [];
}

function assertSubset(name, subset, superset) {
  const missing = [...subset].filter((item) => !superset.has(item)).sort();
  assert.strictEqual(missing.length, 0, `${name} missing: ${missing.join(", ")}`);
}

function assertNoOverlap(name, left, right) {
  const overlap = [...left].filter((item) => right.has(item)).sort();
  assert.strictEqual(overlap.length, 0, `${name}: ${overlap.join(", ")}`);
}

function assertLineListContains(name, file, required) {
  const lines = new Set(read(file).split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = required.filter((line) => !lines.has(line));
  assert.strictEqual(missing.length, 0, `${name} missing: ${missing.join(", ")}`);
}

function relativePackageDirs() {
  return new Set(productionDependencyDirs(root).map((dir) => path.relative(root, dir).replace(/\\/g, "/")));
}

function main() {
  assert.strictEqual(manifest.version, "0.1.4", "package version should be bumped");
  assert.strictEqual(manifest.scripts.prepackage, "npm run validate", "package should validate before building the VSIX");
  assert.strictEqual(manifest.scripts.package, "node scripts/package.js", "package should use deterministic package-lock dependency discovery");
  assert.strictEqual(manifest.scripts["package:ls"], "node scripts/package.js --list", "package listing should use the same deterministic dependency discovery");
  assert.strictEqual(manifest.galleryBanner.color, "#0D1117", "marketplace banner should match the Nytrix dark background");
  assert.strictEqual(manifest.qna, "https://github.com/nytrix-lang/nytrix/issues", "Q&A should point at the issue tracker");
  assert.deepStrictEqual(manifest.extensionKind, ["workspace"], "extension should run on the workspace side for tool processes");
  assert(manifest.capabilities && manifest.capabilities.untrustedWorkspaces, "workspace trust capabilities should be declared");

  const activated = commandActivations();
  const contributed = contributedCommands();
  const registered = registeredCommands();
  const hidden = new Set([...registered].filter((command) => !contributed.has(command)));

  assertSubset("contributed commands not registered", contributed, registered);
  assertSubset("hidden registered commands not activated", hidden, activated);
  assertSubset("walkthrough commands not contributed", walkthroughCommands(), contributed);
  assertNoOverlap("contributed commands should rely on implicit activation", activated, contributed);
  assert((manifest.contributes.walkthroughs || []).length > 0, "extension should include an onboarding walkthrough");

  const configProperties = new Set(Object.keys(manifest.contributes.configuration.properties || {}));
  assertSubset("configuration keys used by code but not contributed", configKeysFromCode(), configProperties);

  for (const file of [
    "src/extension.js", "src/nytrixDebugAdapter.js", "nytrix.tmLanguage.json",
    "snippets/nytrix.code-snippets", "README.md", "DETAILS.md", "LICENSE.md",
    "logo.png", "scripts/package.js"
  ]) {
    assert(fs.existsSync(path.join(root, file)), `missing packaged asset ${file}`);
  }

  const packageDirs = relativePackageDirs();
  assertSubset("production dependency paths", new Set([
    "", "node_modules/vscode-languageclient", "node_modules/vscode-jsonrpc",
    "node_modules/vscode-languageserver-protocol", "node_modules/vscode-languageserver-types", "node_modules/semver"
  ]), packageDirs);
  for (const forbidden of ["node_modules/@vscode/vsce", "node_modules/vscode", "test", "build", "cache", "dist", "out"]) {
    assert(!packageDirs.has(forbidden), `package dependency set should not include ${forbidden}`);
  }

  const snippetText = flattenStrings(snippets).join("\n");
  assert(!/fn\s+[A-Za-z_][A-Za-z0-9_]*\([^)]*\)\s*:/.test(snippetText), "snippets should use current function return syntax");
  assert(!/\$\{[0-9]+:Type\}:\s*\$\{[0-9]+:field\}/.test(snippetText), "field snippets should use type-name order");

  const declarations = grammar.repository && grammar.repository.declaration && grammar.repository.declaration.patterns || [];
  assert(declarations.some((pattern) => pattern.name === "meta.function.definition.nytrix" && pattern.begin), "grammar should scope function headers");
  assert(declarations.some((pattern) => pattern.name === "meta.extern.block.nytrix"), "grammar should scope extern blocks");
  assert(flattenStrings(grammar).some((text) => text.includes("meta.parameter.typed.nytrix")), "grammar should scope typed parameters");

  assertLineListContains("gitignore generated output rules", ".gitignore", [
    "*.vsix", "node_modules/", "build/", "cache/", "dist/", "out/", ".vscode-test/", "test/.artifacts/"
  ]);
  assertLineListContains("vscodeignore generated output rules", ".vscodeignore", [
    "node_modules/**", ".gitignore", "!node_modules/vscode-languageclient/**",
    "scripts/**", "test/**", "build/**", "cache/**", "dist/**", "out/**", "*.vsix"
  ]);

}

module.exports = main;
