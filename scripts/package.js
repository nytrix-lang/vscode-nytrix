#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const npm = require("@vscode/vsce/out/npm");

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

async function main() {
  npm.getDependencies = async (cwd, dependencies) => (
    dependencies === "none" ? [cwd] : productionDependencyDirs(cwd)
  );
  const vscePackage = require("@vscode/vsce/out/package");
  if (process.argv.includes("--list")) {
    const files = await vscePackage.listFiles({ cwd: process.cwd(), useYarn: false });
    console.log(files.join("\n"));
    return;
  }
  await vscePackage.packageCommand({ cwd: process.cwd(), useYarn: false });
}

module.exports = {
  packagePathForDependency,
  productionDependencyDirs
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
