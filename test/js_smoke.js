#!/usr/bin/env node
"use strict";

const { runAll } = require("./harness");

runAll([
  ["metadata smoke", require("./metadata_smoke")],
  ["bootstrap smoke", require("./bootstrap_smoke")],
  ["code action smoke", require("./code_actions_smoke")],
  ["debug symbol smoke", require("./debug_symbol_smoke")]
]);
