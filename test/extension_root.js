"use strict";

const fs = require("fs");
const path = require("path");

function isExtensionRoot(dir) {
  return Boolean(
    dir &&
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "src", "extension.js")) &&
      fs.existsSync(path.join(dir, "nytrix.tmLanguage.json"))
  );
}

function findExtensionRoot() {
  if (process.env.NYTRIX_VSCODE_EXTENSION_ROOT) {
    return path.resolve(process.env.NYTRIX_VSCODE_EXTENSION_ROOT);
  }
  let current = path.resolve(__dirname, "..");
  while (true) {
    if (isExtensionRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("cannot find VS Code Nytrix extension root");
    }
    current = parent;
  }
}

function findNytrixRoot() {
  if (process.env.NYTRIX_REPO_ROOT) {
    return path.resolve(process.env.NYTRIX_REPO_ROOT);
  }
  const starts = [
    process.cwd(),
    path.resolve(__dirname, ".."),
    path.join(process.env.HOME || "", "nytrix")
  ];
  const seen = new Set();
  for (const start of starts) {
    if (!start) {
      continue;
    }
    let current = path.resolve(start);
    while (!seen.has(current)) {
      seen.add(current);
      if (fs.existsSync(path.join(current, "build", "release", "ny")) && fs.existsSync(path.join(current, "lib"))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return path.resolve(findExtensionRoot(), "..");
}

module.exports = {
  findExtensionRoot,
  findNytrixRoot
};
