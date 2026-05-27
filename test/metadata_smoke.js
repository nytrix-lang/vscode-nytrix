#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { findExtensionRoot } = require("./extension_root");

const root = findExtensionRoot();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.js"), "utf8");
const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
const vscodeignore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");

function commandSetFromActivationEvents() {
  return new Set(
    (manifest.activationEvents || [])
      .filter((event) => event.startsWith("onCommand:nytrix."))
      .map((event) => event.slice("onCommand:".length))
  );
}

function commandSetFromContributes() {
  return new Set((manifest.contributes.commands || []).map((command) => command.command));
}

function commandSetFromRegistration() {
  const out = new Set();
  const commandPattern = /\[\s*"((?:nytrix\.)[A-Za-z0-9_.-]+)"\s*,/g;
  let match;
  while ((match = commandPattern.exec(extensionSource)) !== null) {
    out.add(match[1]);
  }
  return out;
}

function commandSetFromWalkthroughs() {
  const out = new Set();
  for (const walkthrough of manifest.contributes.walkthroughs || []) {
    for (const step of walkthrough.steps || []) {
      for (const event of step.completionEvents || []) {
        if (event.startsWith("onCommand:nytrix.")) {
          out.add(event.slice("onCommand:".length));
        }
      }
    }
  }
  return out;
}

function configKeysFromCode() {
  const out = new Set();
  const getPattern = /cfg\(\)\.get\("([^"]+)"/g;
  let match;
  while ((match = getPattern.exec(extensionSource)) !== null) {
    out.add(`nytrix.${match[1]}`);
  }
  return out;
}

function assertSubset(name, subset, superset) {
  const missing = [...subset].filter((item) => !superset.has(item)).sort();
  assert.strictEqual(missing.length, 0, `${name} missing: ${missing.join(", ")}`);
}

function assertLineListContains(name, source, required) {
  const lines = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const missing = required.filter((line) => !lines.has(line));
  assert.strictEqual(missing.length, 0, `${name} missing: ${missing.join(", ")}`);
}

function main() {
  assert.strictEqual(manifest.version, "0.1.2", "package version should be bumped");
  assert.strictEqual(manifest.scripts.prepackage, "npm run validate", "package should validate before building the VSIX");
  assert.strictEqual(manifest.scripts.package, "node scripts/package.js", "package should use deterministic package-lock dependency discovery");
  assert.strictEqual(manifest.scripts["package:ls"], "node scripts/package.js --list", "package listing should use the same deterministic dependency discovery");
  assert.strictEqual(manifest.galleryBanner.color, "#0D1117", "marketplace banner should match the Nytrix dark background");
  assert.strictEqual(manifest.qna, "https://github.com/nytrix-lang/nytrix/issues", "Q&A should point at the issue tracker");
  assert.deepStrictEqual(manifest.extensionKind, ["workspace"], "extension should run on the workspace side for tool processes");
  assert(manifest.capabilities && manifest.capabilities.untrustedWorkspaces, "workspace trust capabilities should be declared");

  const activationCommands = commandSetFromActivationEvents();
  const contributedCommands = commandSetFromContributes();
  const registeredCommands = commandSetFromRegistration();
  const walkthroughCommands = commandSetFromWalkthroughs();

  assertSubset("contributed commands not registered", contributedCommands, registeredCommands);
  assertSubset("registered commands not activated", registeredCommands, activationCommands);
  assertSubset("walkthrough commands not contributed", walkthroughCommands, contributedCommands);
  assertSubset("walkthrough commands not activated", walkthroughCommands, activationCommands);
  assert((manifest.contributes.walkthroughs || []).length > 0, "extension should include an onboarding walkthrough");

  const configProperties = new Set(Object.keys(manifest.contributes.configuration.properties || {}));
  assertSubset("configuration keys used by code but not contributed", configKeysFromCode(), configProperties);

  for (const file of [
    "src/extension.js",
    "src/nytrixDebugAdapter.js",
    "nytrix.tmLanguage.json",
    "snippets/nytrix.code-snippets",
    "README.md",
    "DETAILS.md",
    "LICENSE.md",
    "logo.png",
    "scripts/package.js"
  ]) {
    assert(fs.existsSync(path.join(root, file)), `missing packaged asset ${file}`);
  }

  assertLineListContains("gitignore generated output rules", gitignore, [
    "*.vsix",
    "node_modules/",
    "build/",
    "cache/",
    "dist/",
    "out/",
    ".vscode-test/",
    "test/.artifacts/"
  ]);
  assertLineListContains("vscodeignore generated output rules", vscodeignore, [
    "node_modules/**",
    "!node_modules/vscode-languageclient/**",
    "scripts/**",
    "test/**",
    "build/**",
    "cache/**",
    "dist/**",
    "out/**",
    "*.vsix"
  ]);

  console.log("metadata smoke: ok");
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
