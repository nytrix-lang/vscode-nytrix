#!/usr/bin/env node
"use strict";

const assert = require("assert");
const os = require("os");
const path = require("path");
const { loadExtensionWithVscode } = require("./vscode_stub");

const fakeVscode = {
  workspace: {
    workspaceFolders: [],
    getConfiguration() {
      const values = {
        "bootstrap.mode": "prompt",
        "bootstrap.root": "${home}/.cache/nytrix-bootstrap",
        "bootstrap.repo": "https://github.com/nytrix-lang/nytrix",
        "bootstrap.ref": "main"
      };
      return {
        get(key, fallback) {
          return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
        }
      };
    }
  },
  window: {},
  languages: {}
};

const extension = loadExtensionWithVscode(fakeVscode);

function main() {
  const root = extension.__test.bootstrapRoot();
  assert.strictEqual(root, path.join(os.homedir(), ".cache", "nytrix-bootstrap"));
  assert.strictEqual(extension.__test.bootstrapRepo(), "https://github.com/nytrix-lang/nytrix");
  assert.strictEqual(extension.__test.bootstrapRef(), "main");

  const toolPaths = extension.__test.bootstrapToolPaths("/tmp/nytrix-bootstrap");
  assert.strictEqual(toolPaths.root, "/tmp/nytrix-bootstrap");
  assert(toolPaths.ny.endsWith("/build/release/ny"), "expected ny path under build/release");
  assert(toolPaths.lsp.endsWith("/build/release/ny-lsp"), "expected ny-lsp path under build/release");
  assert(toolPaths.makeScript.endsWith("/make"), "expected repo make script path");

  const plan = extension.__test.bootstrapPlan("/tmp/nytrix-bootstrap");
  assert.strictEqual(plan.repo, "https://github.com/nytrix-lang/nytrix");
  assert.strictEqual(plan.ref, "main");
  assert.deepStrictEqual(
    plan.cloneArgs,
    ["clone", "--depth", "1", "--branch", "main", "https://github.com/nytrix-lang/nytrix", "/tmp/nytrix-bootstrap"]
  );
  assert.strictEqual(plan.buildCommand, plan.paths.makeScript, "expected non-Windows bootstrap to use repo make script");

  console.log("bootstrap smoke: ok");
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
