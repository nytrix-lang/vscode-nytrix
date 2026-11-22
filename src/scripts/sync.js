#!/usr/bin/env node
"use strict";
/*
 * The editor assets in ./language are the single source of truth. This copies
 * language/languages.json into the package.json sections VS Code reads
 * (languages, grammars, snippets, breakpoints, debuggers); never edit those
 * sections by hand.
 *
 *   node src/scripts/sync.js [--check]
 *
 * --check reports whether package.json is current without writing it.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const assets = path.join(root, "language");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const rel = (p) => "./language/" + String(p).replace(/^\.?\//, "");
const fail = (message) => {
  console.error(`sync: ${message}`);
  process.exit(1);
};

/* Contributes sections that mirror the manifest; everything else stays hand-written. */
function sections(manifest) {
  const dbg = manifest.debugger || {};
  return {
    languages: (manifest.languages || []).map((l) => ({ ...l, configuration: l.configuration && rel(l.configuration) })),
    grammars: (manifest.grammars || []).map((g) => ({ ...g, path: rel(g.path) })),
    snippets: (manifest.snippets || []).map((s) => ({ ...s, path: rel(s.path) })),
    breakpoints: manifest.breakpoints || [],
    debuggers: dbg.type ? [{
      type: dbg.type,
      label: dbg.label,
      languages: dbg.languages,
      configurationAttributes: {
        launch: {
          required: ["program"],
          properties: {
            program: { type: "string", default: "${file}", description: "Program, .ny file or .nshape fixture; ny-dap builds sources with debug info." },
            args: { type: "array", items: { type: "string" }, default: [] },
            cwd: { type: "string", default: "${fileDirname}" },
            env: { type: "object", default: {} },
            stopOnEntry: { type: "boolean", default: false },
            compilerArgs: { type: "array", items: { type: "string" }, default: [], description: "Extra compiler flags for the debug build." },
            sourceLine: { type: "number", description: "Line selecting the source ny block of an .nshape fixture." }
          }
        }
      },
      initialConfigurations: [{ type: dbg.type, request: "launch", name: `${dbg.label}: Debug File`, program: "${file}", cwd: "${fileDirname}" }]
    }] : []
  };
}

function main() {
  if (!fs.existsSync(path.join(assets, "languages.json"))) fail("missing language/languages.json");
  const manifest = readJson(path.join(assets, "languages.json"));
  for (const asset of [
    ...(manifest.languages || []).map((l) => l.configuration),
    ...(manifest.grammars || []).map((g) => g.path),
    ...(manifest.snippets || []).map((s) => s.path)
  ].filter(Boolean)) {
    if (!fs.existsSync(path.join(assets, asset))) fail(`missing asset language/${asset}`);
  }

  const pkgPath = path.join(root, "package.json");
  const pkg = readJson(pkgPath);
  pkg.contributes = pkg.contributes || {};
  const next = sections(manifest);

  if (process.argv.includes("--check")) {
    const stale = Object.keys(next).filter((key) => JSON.stringify(pkg.contributes[key]) !== JSON.stringify(next[key]));
    if (stale.length) fail(`package.json is stale (${stale.join(", ")}); run npm run sync`);
    console.log(`sync: package.json is current (${next.languages.length} languages, ${next.grammars.length} grammars)`);
    return;
  }

  Object.assign(pkg.contributes, next);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`sync: ${next.languages.length} languages, ${next.grammars.length} grammars -> package.json`);
}

if (require.main === module) main();
module.exports = { sections };
