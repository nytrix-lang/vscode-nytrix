#!/usr/bin/env node
"use strict";
/*
 * Package check: the language manifest, the contributed assets, the commands
 * and settings in src/extension.js, and the package versions must agree.
 *
 *   node src/scripts/check.js
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (file) => JSON.parse(read(file));
const problems = [];
const expect = (ok, message) => {
  if (!ok) problems.push(message);
};

function main() {
  const pkg = readJson("package.json");
  const manifest = readJson("language/languages.json");
  const extension = read("src/extension.js");
  const contributes = pkg.contributes || {};
  const dbg = manifest.debugger || {};
  const server = manifest.server || {};

  /* Contributed assets exist and are exactly what the manifest declares. */
  const contributed = [
    ...(contributes.languages || []).map((l) => l.configuration),
    ...(contributes.grammars || []).map((g) => g.path),
    ...(contributes.snippets || []).map((s) => s.path)
  ].filter(Boolean);
  const declared = [
    ...(manifest.languages || []).map((l) => l.configuration),
    ...(manifest.grammars || []).map((g) => g.path),
    ...(manifest.snippets || []).map((s) => s.path)
  ].filter(Boolean).map((p) => "./language/" + p.replace(/^\.?\//, ""));
  for (const asset of contributed) {
    expect(asset.startsWith("./language/"), `${asset}: contributed assets must live in language/`);
    expect(fs.existsSync(path.join(root, asset)), `${asset}: missing`);
    expect(declared.includes(asset), `${asset}: not declared in language/languages.json`);
  }
  for (const asset of declared) expect(contributed.includes(asset), `${asset}: declared but not contributed`);

  expect(server.executable, "language/languages.json: missing server.executable");
  expect(dbg.executable, "language/languages.json: missing debugger.executable");
  expect((contributes.debuggers || []).some((d) => d.type === dbg.type), `debugger ${dbg.type}: not contributed`);

  /* Commands and settings: contributed is exactly what the extension uses. */
  const registered = new Set([...extension.matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1]));
  const commands = new Set((contributes.commands || []).map((c) => c.command));
  for (const command of registered) expect(commands.has(command), `${command}: registered but not contributed`);
  for (const command of commands) expect(registered.has(command), `${command}: contributed but not registered`);

  const properties = new Set(Object.keys((contributes.configuration || {}).properties || {}));
  const used = new Set([...extension.matchAll(/cfg\(\)\.get\("([^"]+)"/g)].map((m) => `nytrix.${m[1]}`));
  for (const key of used) expect(properties.has(key), `${key}: read but not contributed`);

  /* No dangling local require, no missing entry point. */
  expect(fs.existsSync(path.join(root, pkg.main || "src/extension.js")), `${pkg.main}: missing entry point`);
  for (const match of extension.matchAll(/require\("(\.\/[^"]+)"\)/g)) {
    const target = path.join(root, "src", match[1]);
    expect(fs.existsSync(target) || fs.existsSync(target + ".js"), `src/${match[1]}: required module is missing`);
  }

  /* Versions agree with the lockfile and the changelog. */
  const lock = readJson("package-lock.json");
  const lockVersion = lock.version || ((lock.packages || {})[""] || {}).version;
  expect(pkg.version === lockVersion, `package.json ${pkg.version} and package-lock.json ${lockVersion} differ`);
  expect(read("CHANGELOG.md").includes(`## ${pkg.version}`), `CHANGELOG.md has no ${pkg.version} section`);

  if (problems.length) {
    for (const problem of problems) console.error(`check: ${problem}`);
    process.exit(1);
  }
  console.log(`check: ok (${contributed.length} assets, ${registered.size} commands, ${properties.size} settings)`);
}

main();
module.exports = { main };
