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

/* Commands the extension itself owns; the manifest adds one wrapper per server command. */
const BASE_COMMANDS = [
  { command: "nytrix.commands", title: "Show Commands", category: "Nytrix", icon: "$(list-selection)" },
  { command: "nytrix.restartServer", title: "Restart Server", category: "Nytrix", icon: "$(debug-restart)" },
  { command: "nytrix.showOutput", title: "Show Output", category: "Nytrix", icon: "$(output)" },
  { command: "nytrix.showToolchain", title: "Show Toolchain", category: "Nytrix", icon: "$(tools)" }
];

const langWhen = (langs, key = "editorLangId") => "(" + langs.map((l) => `${key} == ${l}`).join(" || ") + ")";
const extWhen = (langs) => "(" + langs.map((l) => `resourceExtname == .${l === "nytrix" ? "ny" : l}`).join(" || ") + ")";

/* Commands, menus and keybindings generated from manifest.commands. */
function ui(manifest) {
  const list = manifest.commands || [];
  const id = (c) => `nytrix.ui.${c.id}`;
  const commands = [...BASE_COMMANDS, ...list.map((c) => ({ command: id(c), title: c.title, category: "Nytrix", icon: `$(${c.icon})` }))];
  const menus = { commandPalette: [], "editor/title/run": [], "editor/context": [], "explorer/context": [] };
  list.forEach((c, i) => {
    const when = langWhen(c.languages);
    menus.commandPalette.push({ command: id(c), when: c.group === "workspace" ? "workspaceFolderCount > 0 || " + when : when });
    if (c.group === "run") {
      menus["editor/title/run"].push({ command: id(c), when: `${when} && !inDebugMode`, group: `1_run@${i}` });
      menus["explorer/context"].push({ command: id(c), when: `!explorerResourceIsFolder && ${extWhen(c.languages)}`, group: `nytrix@${i}` });
    } else if (c.group === "tools") {
      menus["nytrix.tools"] = menus["nytrix.tools"] || [];
      menus["nytrix.tools"].push({ command: id(c), when, group: `1_tools@${i}` });
    } else {
      menus["nytrix.tools"] = menus["nytrix.tools"] || [];
      menus["nytrix.tools"].push({ command: id(c), when, group: `2_workspace@${i}` });
    }
  });
  menus["editor/context"].push({ submenu: "nytrix.tools", when: langWhen(["nytrix", "nshape"]), group: "navigation@9" });
  const keybindings = [{ command: "nytrix.commands", key: "ctrl+alt+n", mac: "cmd+alt+n" }];
  for (const c of list) if (c.keybinding) keybindings.push({ command: id(c), key: c.keybinding, mac: c.mac, when: langWhen(c.languages) });
  return { commands, menus, submenus: [{ id: "nytrix.tools", label: "Nytrix" }], keybindings };
}

/* Contributes sections that mirror the manifest; everything else stays hand-written. */
function sections(manifest) {
  const dbg = manifest.debugger || {};
  return {
    ...ui(manifest),
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
