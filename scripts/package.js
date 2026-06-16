#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const CORE_PACKAGE_FILES = [
  "package.json",
  "README.md",
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

function packagePathForDependency(lock, fromPath, name) {
  const local = fromPath ? `${fromPath}/node_modules/${name}` : `node_modules/${name}`;
  if (lock.packages[local]) {
    return local;
  }
  const hoisted = `node_modules/${name}`;
  return lock.packages[hoisted] ? hoisted : "";
}

function productionDependencyDirs(cwd) {
  const lock = JSON.parse(fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8"));
  const seen = new Set([""]);
  const dirs = [cwd];
  const visit = (packagePath) => {
    const entry = lock.packages[packagePath] || {};
    for (const name of Object.keys(entry.dependencies || {})) {
      const childPath = packagePathForDependency(lock, packagePath, name);
      if (!childPath || seen.has(childPath)) {
        continue;
      }
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
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, child));
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
  return out;
}

function fallbackPackageList(cwd) {
  const files = new Set(CORE_PACKAGE_FILES.filter((file) => fs.existsSync(path.join(cwd, file))));
  for (const depDir of productionDependencyDirs(cwd).slice(1)) {
    if (!fs.existsSync(depDir)) {
      continue;
    }
    const rel = path.relative(cwd, depDir).replace(/\\/g, "/");
    for (const file of walkFiles(cwd, rel)) {
      files.add(file);
    }
  }
  return [...files].sort();
}

function loadVsce() {
  try {
    return {
      npm: require("@vscode/vsce/out/npm"),
      packageApi: require("@vscode/vsce/out/package")
    };
  } catch (err) {
    return { error: err };
  }
}

async function main() {
  const cwd = process.cwd();
  const vsce = loadVsce();
  if (vsce.error) {
    if (process.argv.includes("--list")) {
      console.log(fallbackPackageList(cwd).join("\n"));
      return;
    }
    throw new Error("@vscode/vsce is not installed. Run npm install, or use npm run package:ls for the dependency-free file list.");
  }
  vsce.npm.getDependencies = async (root, dependencies) => (
    dependencies === "none" ? [root] : productionDependencyDirs(root)
  );
  if (process.argv.includes("--list")) {
    const files = await vsce.packageApi.listFiles({ cwd, useYarn: false });
    console.log(files.join("\n"));
    return;
  }
  await vsce.packageApi.packageCommand({ cwd, useYarn: false });
}

module.exports = {
  CORE_PACKAGE_FILES,
  fallbackPackageList,
  packagePathForDependency,
  productionDependencyDirs
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
