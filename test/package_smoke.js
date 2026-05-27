#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { findExtensionRoot } = require("./extension_root");
const { productionDependencyDirs } = require("../scripts/package");

const root = findExtensionRoot();

function relativeDirs() {
  return new Set(productionDependencyDirs(root).map((dir) => path.relative(root, dir).replace(/\\/g, "/")));
}

function assertIgnored(rule, target) {
  const text = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert(
    text.split(/\r?\n/).map((line) => line.trim()).includes(rule),
    `${target} should be protected by ${rule} in .gitignore`
  );
}

function main() {
  const dirs = relativeDirs();
  for (const required of [
    "",
    "node_modules/vscode-languageclient",
    "node_modules/vscode-jsonrpc",
    "node_modules/vscode-languageserver-protocol",
    "node_modules/vscode-languageserver-types",
    "node_modules/semver"
  ]) {
    assert(dirs.has(required), `missing production dependency path ${required || "<root>"}`);
  }

  for (const forbidden of [
    "node_modules/@vscode/vsce",
    "node_modules/vscode",
    "test",
    "build",
    "cache",
    "dist",
    "out"
  ]) {
    assert(!dirs.has(forbidden), `package dependency set should not include ${forbidden}`);
  }

  assertIgnored("*.vsix", "VSIX output");
  assertIgnored("build/", "build output");
  assertIgnored("cache/", "cache output");
  assertIgnored("dist/", "dist output");
  assertIgnored("out/", "out output");

  console.log("package smoke: ok");
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
