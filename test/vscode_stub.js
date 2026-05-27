"use strict";

const Module = require("module");
const path = require("path");
const { findExtensionRoot } = require("./extension_root");

function loadExtensionWithVscode(fakeVscode) {
  const extensionPath = path.join(findExtensionRoot(), "src", "extension.js");
  const previous = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return fakeVscode;
    }
    return previous.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(extensionPath)];
    return require(extensionPath);
  } finally {
    Module._load = previous;
  }
}

module.exports = {
  loadExtensionWithVscode
};
