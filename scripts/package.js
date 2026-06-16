#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const CORE_PACKAGE_FILES = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "logo.png",
  "language-configuration.json",
  "nshape-language-configuration.json",
  "shader-language-configuration.json",
  "nytrix.tmLanguage.json",
  "nshape.tmLanguage.json",
  "shader.tmLanguage.json",
  "markdown-nytrix.tmLanguage.json",
  "src/extension.js",
  "snippets/nytrix.code-snippets",
  "snippets/nshape.code-snippets"
];

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path.basename(file)}: ${errorMessage(err)}`);
  }
}

function packagePathForDependency(lock, fromPath, name) {
  const local = fromPath ? `${fromPath}/node_modules/${name}` : `node_modules/${name}`;
  const hoisted = `node_modules/${name}`;
  return lock.packages[local] ? local : (lock.packages[hoisted] ? hoisted : "");
}

function productionDependencyDirs(cwd) {
  const lock = readJson(path.join(cwd, "package-lock.json"));
  if (!lock.packages || !lock.packages[""]) {
    throw new Error("package-lock.json is missing the root package entry; run npm install to refresh it");
  }
  const seen = new Set([""]);
  const dirs = [cwd];
  const visit = (packagePath) => {
    const deps = (lock.packages[packagePath] || {}).dependencies || {};
    for (const name of Object.keys(deps).sort()) {
      const childPath = packagePathForDependency(lock, packagePath, name);
      if (!childPath || seen.has(childPath)) continue;
      seen.add(childPath);
      dirs.push(path.join(cwd, childPath));
      visit(childPath);
    }
  };
  visit("");
  return dirs;
}

function walkFiles(root, rel = "") {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walkFiles(root, child) : (entry.isFile() ? [child] : []);
  });
}

function fallbackPackageList(cwd) {
  const files = new Set(CORE_PACKAGE_FILES.filter((file) => fs.existsSync(path.join(cwd, file))));
  for (const depDir of productionDependencyDirs(cwd).slice(1).filter(fs.existsSync)) {
    const rel = path.relative(cwd, depDir).replace(/\\/g, "/");
    for (const file of walkFiles(cwd, rel)) files.add(file);
  }
  return [...files].sort();
}

function loadVsce() {
  try {
    return {
      npm: require("@vscode/vsce/out/npm"),
      packageApi: require("@vscode/vsce/out/package")
    };
  } catch (error) {
    return { error };
  }
}

async function listPackageFiles(cwd, vsce) {
  if (!vsce.error) {
    vsce.npm.getDependencies = async (root, dependencies) => (
      dependencies === "none" ? [root] : productionDependencyDirs(root)
    );
    return vsce.packageApi.listFiles({ cwd, useYarn: false });
  }
  return fallbackPackageList(cwd);
}

async function main() {
  const cwd = process.cwd();
  const vsce = loadVsce();
  const listOnly = process.argv.includes("--list");

  if (listOnly) {
    console.log((await listPackageFiles(cwd, vsce)).join("\n"));
    return;
  }
  if (vsce.error) {
    throw new Error(`@vscode/vsce is not installed (${errorMessage(vsce.error)}). Run npm install, or use npm run package:ls to inspect the dependency-free file list.`);
  }
  vsce.npm.getDependencies = async (root, dependencies) => (
    dependencies === "none" ? [root] : productionDependencyDirs(root)
  );
  await vsce.packageApi.packageCommand({ cwd, useYarn: false });
}

module.exports = {
  CORE_PACKAGE_FILES,
  fallbackPackageList,
  packagePathForDependency,
  productionDependencyDirs,
  errorMessage,
  readJson,
  walkFiles
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
