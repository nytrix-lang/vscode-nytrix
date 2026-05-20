"use strict";

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

class DapConnection {
  constructor() {
    this.seq = 1;
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
    process.stdin.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.contentLength < 0) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          return;
        }
        const header = this.buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          throw new Error("DAP message missing Content-Length");
        }
        this.contentLength = Number(match[1]);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }
      if (this.buffer.length < this.contentLength) {
        return;
      }
      const raw = this.buffer.slice(0, this.contentLength).toString("utf8");
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;
      this.onMessage(JSON.parse(raw));
    }
  }

  onMessage(_message) {}

  send(message) {
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    process.stdout.write(header + json);
  }

  event(event, body = {}) {
    this.send({ seq: this.seq++, type: "event", event, body });
  }

  response(request, success = true, body = {}, message = undefined) {
    const out = {
      seq: this.seq++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success
    };
    if (message) {
      out.message = message;
    }
    if (body && Object.keys(body).length > 0) {
      out.body = body;
    }
    this.send(out);
  }
}

function findOnPath(name) {
  const suffixes = process.platform === "win32" && !name.endsWith(".exe") ? [".exe", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const suffix of suffixes) {
      const file = path.join(dir, name + suffix);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  return "";
}

function expandVars(value, cwd) {
  if (!value || typeof value !== "string") {
    return "";
  }
  let out = value;
  if (out === "~" || out.startsWith("~/")) {
    out = path.join(os.homedir(), out.slice(2));
  }
  out = out.replace(/\$\{workspaceFolder\}/g, cwd || process.cwd());
  out = out.replace(/\$\{fileWorkspaceFolder\}/g, cwd || process.cwd());
  out = out.replace(/\$\{home\}/g, os.homedir());
  return out;
}

function safeName(file) {
  return path.basename(file).replace(/[^A-Za-z0-9_.-]/g, "_").replace(/\.ny$/i, "");
}

function miQuote(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
}

function isOptArg(arg) {
  return /^-O([0-3])?$/.test(arg) || arg === "-passes" || arg.startsWith("-passes=");
}

function parseCString(src, i) {
  let out = "";
  i += 1;
  while (i < src.length) {
    const ch = src[i++];
    if (ch === "\"") {
      break;
    }
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = src[i++];
    if (esc === "n") {
      out += "\n";
    } else if (esc === "r") {
      out += "\r";
    } else if (esc === "t") {
      out += "\t";
    } else if (esc === "\\" || esc === "\"") {
      out += esc;
    } else {
      out += esc || "";
    }
  }
  return [out, i];
}

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) {
    i += 1;
  }
  return i;
}

function parseWord(src, i) {
  const start = i;
  while (i < src.length && /[^=,\]}]/.test(src[i])) {
    i += 1;
  }
  return [src.slice(start, i), i];
}

function addResult(obj, key, value) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    if (!Array.isArray(obj[key])) {
      obj[key] = [obj[key]];
    }
    obj[key].push(value);
  } else {
    obj[key] = value;
  }
}

function parseValue(src, i) {
  i = skipWs(src, i);
  if (src[i] === "\"") {
    return parseCString(src, i);
  }
  if (src[i] === "{") {
    const obj = {};
    i += 1;
    while (i < src.length && src[i] !== "}") {
      const start = i;
      const [key, ki] = parseWord(src, i);
      i = ki;
      if (src[i] === "=") {
        const [value, vi] = parseValue(src, i + 1);
        addResult(obj, key, value);
        i = vi;
      }
      if (src[i] === ",") {
        i += 1;
      }
      if (i === start) {
        throw new Error(`MI parse stalled inside object near: ${src.slice(i, i + 80)}`);
      }
    }
    return [obj, i + 1];
  }
  if (src[i] === "[") {
    const arr = [];
    i += 1;
    while (i < src.length && src[i] !== "]") {
      const start = i;
      i = skipWs(src, i);
      if (src[i] === "{"
        || src[i] === "["
        || src[i] === "\"") {
        const [value, vi] = parseValue(src, i);
        arr.push(value);
        i = vi;
      } else {
        const mark = i;
        const [maybeKey, ki] = parseWord(src, i);
        if (src[ki] === "=") {
          const [value, vi] = parseValue(src, ki + 1);
          const obj = {};
          obj[maybeKey] = value;
          arr.push(obj);
          i = vi;
        } else {
          const [value, vi] = parseValue(src, mark);
          arr.push(value);
          i = vi;
        }
      }
      if (src[i] === ",") {
        i += 1;
      }
      if (src[i] === "]") {
        break;
      }
      if (i === start) {
        throw new Error(`MI parse stalled inside array near: ${src.slice(i, i + 80)}`);
      }
    }
    return [arr, i + 1];
  }
  return parseWord(src, i);
}

function parseResults(src) {
  const obj = {};
  let i = 0;
  while (i < src.length) {
    const [key, ki] = parseWord(src, i);
    i = ki;
    if (!key || src[i] !== "=") {
      break;
    }
    const [value, vi] = parseValue(src, i + 1);
    addResult(obj, key, value);
    i = vi;
    if (src[i] === ",") {
      i += 1;
    }
  }
  return obj;
}

function normalizeArray(value, key) {
  if (!value) {
    return [];
  }
  const arr = Array.isArray(value) ? value : [value];
  if (!key) {
    return arr;
  }
  return arr.map((item) => item && item[key] ? item[key] : item).filter(Boolean);
}

function parsePositiveInt(value, fallback = 0) {
  const match = String(value || "").match(/\d+/);
  const n = match ? Number(match[0]) : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseFrameId(frameId) {
  return Math.max(0, Number(frameId || 1) - 1);
}

function runtimeTraceEnv(config) {
  const env = {};
  const enabled = config && (config.traceRuntime === true || config.traceValues === true || config.traceVerbose === true);
  if (!enabled) {
    return env;
  }
  env.NYTRIX_TRACE = "1";
  env.NYTRIX_TRACE_CALLS = "1";
  if (config.traceValues === true) {
    env.NYTRIX_TRACE_VALUES = "1";
  }
  if (config.traceVerbose === true) {
    env.NYTRIX_TRACE_VERBOSE = "1";
  }
  if (config.traceFilter) {
    env.NYTRIX_TRACE_FILTER = String(config.traceFilter);
  }
  return env;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function countTextMatches(text, regex) {
  const matches = String(text || "").match(regex);
  return matches ? matches.length : 0;
}

function summarizeText(text) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    lines: lines.length,
    errors: countTextMatches(clean, /\berror\b|\bfailed\b|\bpanic\b/gi),
    warnings: countTextMatches(clean, /\bwarning\b/gi),
    notes: countTextMatches(clean, /\bnote\b/gi),
    hints: countTextMatches(clean, /\bhint\b|\bfix\b/gi)
  };
}

function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) {
    return `${n} ms`;
  }
  return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
}

function compactValue(value, max = 220) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function compactPath(file, cwd) {
  if (!file) {
    return "";
  }
  const full = path.resolve(String(file));
  const base = cwd ? path.resolve(cwd) : "";
  if (base && (full === base || full.startsWith(base + path.sep))) {
    return path.relative(base, full) || ".";
  }
  return full;
}

function formatTraceMode(config) {
  if (!config || !(config.traceRuntime || config.traceValues || config.traceVerbose)) {
    return "off";
  }
  const mode = config.traceVerbose ? "verbose" : config.traceValues ? "values" : "calls";
  return config.traceFilter ? `${mode} filter=${config.traceFilter}` : mode;
}

function sourceFor(file) {
  return file ? { name: path.basename(file), path: file, sourceReference: 0 } : undefined;
}

function frameArgsArray(frame) {
  return normalizeArray(frame && frame.args);
}

function frameArgLabel(arg) {
  if (!arg || typeof arg !== "object") {
    return compactValue(String(arg || ""), 48);
  }
  const name = arg.name || arg.arg || "";
  const value = arg.value != null ? compactValue(arg.value, 48) : "";
  if (name && value) {
    return `${name}=${value}`;
  }
  return name || value || "<arg>";
}

function frameDisplayName(frame) {
  const func = frame && frame.func ? frame.func : "<unknown>";
  const args = frameArgsArray(frame).map(frameArgLabel).filter(Boolean);
  if (args.length === 0) {
    return func;
  }
  return compactValue(`${func}(${args.join(", ")})`, 160);
}

function frameModuleId(frame) {
  return (frame && (frame.from || frame.module || frame.fullname || frame.file)) || "";
}

function threadDisplayName(thread) {
  if (!thread || typeof thread !== "object") {
    return "main";
  }
  const parts = [];
  if (thread.name) {
    parts.push(thread.name);
  } else if (thread.details) {
    parts.push(thread.details);
  } else if (thread["target-id"]) {
    parts.push(thread["target-id"]);
  }
  if (thread.state) {
    parts.push(`[${thread.state}]`);
  }
  const label = parts.join(" ").trim();
  return label || `thread ${thread.id || 1}`;
}

function breakpointMessage(sourcePath, requestedLine, actualLine) {
  if (actualLine && actualLine !== requestedLine) {
    return `Resolved to line ${actualLine}`;
  }
  return undefined;
}

function firstInterestingSourceLine(file) {
  let fallback = 1;
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i].trim();
      if (!text) {
        continue;
      }
      if (text.startsWith(";;")) {
        continue;
      }
      if (fallback === 1) {
        fallback = i + 1;
      }
      if (/^(module|use|fn|layout|struct|enum|type|operator|def|mut)\b/.test(text)) {
        continue;
      }
      return i + 1;
    }
  } catch {}
  return fallback;
}

class GdbMi {
  constructor(adapter, gdbPath, binary, cwd, env, trace) {
    this.adapter = adapter;
    this.token = 1000;
    this.pending = new Map();
    this.trace = trace;
    this.lineBuffer = "";
    this.exited = false;
    const args = ["--interpreter=mi2", "--quiet"];
    if (binary) {
      args.push(binary);
    }
    this.child = cp.spawn(gdbPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onText(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => this.adapter.output(chunk.toString("utf8"), "stderr"));
    this.child.on("error", (err) => this.adapter.output(`gdb failed: ${err.message}\n`, "stderr"));
    this.child.on("exit", (code) => {
      this.exited = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`gdb exited with code ${code || 0}`));
      }
      this.pending.clear();
      if (!this.adapter.terminated) {
        this.adapter.conn.event("exited", { exitCode: code || 0 });
        this.adapter.conn.event("terminated");
        this.adapter.terminated = true;
      }
    });
  }

  onText(text) {
    this.lineBuffer += text;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() || "";
    for (const line of lines) {
      this.onLine(line.trimEnd());
    }
  }

  onLine(line) {
    if (!line || line === "(gdb)") {
      return;
    }
    if (this.trace) {
      this.adapter.output(`[mi<] ${line}\n`, "console");
    }
    const stream = line.match(/^[~@&]"(.*)"$/);
    if (stream) {
      const [decoded] = parseCString(`"${stream[1]}"`, 0);
      this.adapter.output(decoded, line[0] === "&" ? "stderr" : "stdout");
      return;
    }
    const result = line.match(/^(\d+)\^(done|running|error|exit)(?:,(.*))?$/);
    if (result) {
      const token = Number(result[1]);
      const pending = this.pending.get(token);
      if (pending) {
        this.pending.delete(token);
        clearTimeout(pending.timer);
        const body = result[3] ? parseResults(result[3]) : {};
        if (result[2] === "error") {
          pending.reject(new Error(body.msg || "gdb command failed"));
        } else {
          pending.resolve({ cls: result[2], body });
        }
      }
      return;
    }
    const stopped = line.match(/^\*stopped(?:,(.*))?$/);
    if (stopped) {
      this.adapter.onStopped(stopped[1] ? parseResults(stopped[1]) : {});
    } else if (/^\*running/.test(line)) {
      this.adapter.conn.event("continued", { threadId: 1, allThreadsContinued: true });
    }
  }

  cmd(command) {
    if (this.exited || !this.child || !this.child.stdin || !this.child.stdin.writable) {
      return Promise.reject(new Error("gdb is not running"));
    }
    const token = this.token++;
    if (this.trace) {
      this.adapter.output(`[mi>] ${token}${command}\n`, "console");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(token)) {
          this.pending.delete(token);
          reject(new Error(`gdb timeout: ${command}`));
        }
      }, 15000);
      this.pending.set(token, { resolve, reject, timer });
      this.child.stdin.write(`${token}${command}\n`, (err) => {
        if (err && this.pending.has(token)) {
          clearTimeout(timer);
          this.pending.delete(token);
          reject(err);
        }
      });
    });
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("gdb disposed"));
    }
    this.pending.clear();
    try {
      this.child.stdin.write("-gdb-exit\n");
    } catch {}
    setTimeout(() => {
      try {
        this.child.kill();
      } catch {}
    }, 400);
  }
}

class NytrixDebugAdapter {
  constructor() {
    this.conn = new DapConnection();
    this.requestQueue = Promise.resolve();
    this.conn.onMessage = (message) => {
      this.requestQueue = this.requestQueue.then(
        () => this.dispatch(message),
        () => this.dispatch(message)
      );
    };
    this.gdb = null;
    this.breakpoints = new Map();
    this.gdbBreakpoints = new Map();
    this.variableRefs = new Map();
    this.varObjects = new Map();
    this.nextVariableRef = 1;
    this.launched = false;
    this.running = false;
    this.terminated = false;
    this.config = {};
    this.binary = "";
    this.cwd = process.cwd();
    this.lastStop = {};
    this.lastFrames = [];
    this.lastThreads = [];
    this.lastBacktrace = "";
    this.outputHistory = [];
    this.requestKind = "launch";
    this.sessionStartedAt = Date.now();
  }

  output(text, category = "stdout") {
    if (!text) {
      return;
    }
    const clean = stripAnsi(text);
    if (clean) {
      this.outputHistory.push(clean);
      while (this.outputHistory.length > 160) {
        this.outputHistory.shift();
      }
    }
    this.conn.event("output", { category, output: text });
  }

  logSection(tag, fields = {}, category = "console") {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== "");
    if (entries.length === 0) {
      this.output(`[${tag}]\n`, category);
      return;
    }
    const width = Math.max(...entries.map(([key]) => key.length));
    const lines = [`[${tag}]`];
    for (const [key, value] of entries) {
      lines.push(`  ${key.padEnd(width)} ${compactValue(value)}`);
    }
    this.output(`${lines.join("\n")}\n`, category);
  }

  logEvent(tag, message, fields = {}, category = "console") {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== "");
    const lines = [`[${tag}] ${compactValue(message, 300)}`];
    if (entries.length > 0) {
      const width = Math.max(...entries.map(([key]) => key.length));
      for (const [key, value] of entries) {
        lines.push(`  ${key.padEnd(width)} ${compactValue(value)}`);
      }
    }
    this.output(`${lines.join("\n")}\n`, category);
  }

  recentOutputText() {
    return this.outputHistory.join("");
  }

  recentExceptionMessage() {
    const lines = this.recentOutputText()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/^(PanicError|ZeroDivisionError|NytrixError|SegmentationFault|AssertionError|TypeError)\b/.test(lines[i])) {
        return lines[i];
      }
    }
    return "";
  }

  frameLocationText(frame) {
    const file = this.toClientPath(frame.fullname || frame.file || "");
    const line = Number(frame.line || 1);
    if (!file) {
      return frame.addr || "";
    }
    return `${compactPath(file, this.cwd)}:${line}`;
  }

  userFrameName(frame) {
    const file = this.toClientPath(frame && (frame.fullname || frame.file || ""));
    if (frame && frame.func === "_ny_top_entry" && file) {
      return `<script ${path.basename(file)}>`;
    }
    return frameDisplayName(frame);
  }

  isUserCodePath(file) {
    if (!file) {
      return false;
    }
    const full = path.resolve(file);
    const program = this.config.program ? path.resolve(this.config.program) : "";
    if (program && full === program) {
      return true;
    }
    const cwd = this.cwd ? path.resolve(this.cwd) : "";
    if (cwd && (full === cwd || full.startsWith(cwd + path.sep))) {
      return true;
    }
    for (const [, local] of this.sourceMapEntries()) {
      if (full === local || full.startsWith(local + path.sep)) {
        return true;
      }
    }
    return false;
  }

  isUserFrame(frame) {
    const file = this.toClientPath(frame && (frame.fullname || frame.file || ""));
    return this.isUserCodePath(file);
  }

  visibleFrames(frames) {
    const raw = Array.isArray(frames) ? frames : [];
    if (this.config.justMyCode === false) {
      return raw;
    }
    const visible = raw.filter((frame) => this.isUserFrame(frame));
    return visible.length > 0 ? visible : raw.slice(0, 1);
  }

  hiddenFrameCount(frames) {
    const raw = Array.isArray(frames) ? frames : [];
    return Math.max(0, raw.length - this.visibleFrames(raw).length);
  }

  frameToDap(frame, fallbackLevel = 0) {
    const level = Number(frame.level || fallbackLevel);
    const file = this.toClientPath(frame.fullname || frame.file || "");
    const out = {
      id: level + 1,
      name: this.userFrameName(frame),
      source: sourceFor(file),
      line: Number(frame.line || 1),
      column: 1,
      instructionPointerReference: frame.addr || undefined,
      moduleId: frameModuleId(frame) || undefined
    };
    if (!this.isUserFrame(frame)) {
      out.presentationHint = "subtle";
    }
    return out;
  }

  formatBacktrace(frames, maxFrames = 32) {
    const visible = this.visibleFrames(frames);
    const lines = [];
    for (const frame of visible.slice(0, maxFrames)) {
      const level = Number(frame.level || lines.length);
      const moduleText = frame.from ? ` [${path.basename(frame.from)}]` : "";
      const addrText = frame.addr ? ` @ ${frame.addr}` : "";
      lines.push(
        `#${level}  ${this.userFrameName(frame)}  at ${this.frameLocationText(frame)}${moduleText}${addrText}`
      );
    }
    const hidden = Math.max(0, (frames || []).length - visible.length);
    if (hidden > 0) {
      lines.push(`(${hidden} runtime frame${hidden === 1 ? "" : "s"} hidden)`);
    }
    return lines.join("\n");
  }

  async fetchFrameArguments(level = null) {
    if (!this.gdb) {
      return [];
    }
    let result;
    if (level == null) {
      result = await this.gdb.cmd("-stack-list-arguments --simple-values").catch(() => ({ body: {} }));
    } else {
      result = await this.gdb.cmd(`-stack-list-arguments --simple-values ${level} ${level}`)
        .catch(() => this.gdb.cmd(`-stack-list-arguments 1 ${level} ${level}`))
        .catch(() => ({ body: {} }));
    }
    const frames = normalizeArray(result.body["stack-args"], "frame");
    if (level == null) {
      return frames;
    }
    const exact = frames.find((frame) => Number(frame.level || 0) === Number(level));
    return normalizeArray((exact || frames[0] || {}).args);
  }

  async fetchStackFrames(includeArgs = true) {
    if (!this.gdb) {
      return [];
    }
    const result = await this.gdb.cmd("-stack-list-frames");
    const frames = normalizeArray(result.body.stack, "frame").map((frame, i) => ({
      ...frame,
      level: Number(frame.level || i)
    }));
    if (!includeArgs || frames.length === 0) {
      return frames;
    }
    const argFrames = await this.fetchFrameArguments(null);
    if (argFrames.length === 0) {
      return frames;
    }
    const argMap = new Map();
    for (const frame of argFrames) {
      argMap.set(Number(frame.level || 0), normalizeArray(frame.args));
    }
    return frames.map((frame) => ({
      ...frame,
      args: frame.args || argMap.get(Number(frame.level || 0)) || []
    }));
  }

  async snapshotThreads() {
    if (!this.gdb) {
      return [{ id: 1, name: "main" }];
    }
    const result = await this.gdb.cmd("-thread-info").catch(() => ({ body: {} }));
    const currentThread = Number(result.body["current-thread-id"] || this.lastStop["thread-id"] || 1);
    const threads = normalizeArray(result.body.threads).map((thread) => ({
      id: Number(thread.id || 1),
      name: threadDisplayName(thread),
      state: thread.state || "",
      current: Number(thread.id || 0) === currentThread
    }));
    if (threads.length === 0) {
      return [{ id: currentThread || 1, name: "main", state: this.running ? "running" : "stopped", current: true }];
    }
    return threads.sort((a, b) => Number(b.current) - Number(a.current) || a.id - b.id);
  }

  async captureStopSnapshot(dapReason) {
    if (!this.gdb) {
      return;
    }
    try {
      this.lastFrames = await this.fetchStackFrames(true);
      this.lastBacktrace = this.formatBacktrace(this.lastFrames);
      if (dapReason !== "step" && this.lastBacktrace) {
        this.output(`[backtrace]\n${this.lastBacktrace}\n`, "console");
      }
    } catch (err) {
      this.output(`[backtrace] unavailable: ${err.message}\n`, "console");
    }
    try {
      this.lastThreads = await this.snapshotThreads();
      if (this.lastThreads.length > 1) {
        this.logSection("threads", {
          total: this.lastThreads.length,
          current: this.lastThreads.find((thread) => thread.current)?.name || this.lastThreads[0].name
        });
      }
    } catch {}
  }

  async dispatch(request) {
    try {
      const handler = this[`on_${request.command}`];
      if (!handler) {
        this.conn.response(request, true);
        return;
      }
      await handler.call(this, request);
    } catch (err) {
      this.logSection("error", {
        command: request.command,
        detail: err && err.message ? err.message : String(err)
      }, "stderr");
      this.conn.response(request, false, {}, err && err.message ? err.message : String(err));
    }
  }

  on_initialize(request) {
    this.conn.response(request, true, {
      supportsConfigurationDoneRequest: true,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsEvaluateForHovers: true,
      supportsSetVariable: false,
      supportsTerminateRequest: true,
      supportsStepBack: false,
      supportsLoadedSourcesRequest: true,
      supportsExceptionInfoRequest: true,
      supportsExceptionFilterOptions: true,
      supportsCompletionsRequest: false,
      supportsModulesRequest: true,
      supportsFunctionBreakpoints: true
    });
  }

  sourceMapEntries() {
    const map = this.config.sourceFileMap || {};
    if (!map || typeof map !== "object") {
      return [];
    }
    return Object.entries(map).map(([remote, local]) => [
      path.resolve(expandVars(remote, this.cwd)),
      path.resolve(expandVars(String(local), this.cwd))
    ]);
  }

  toClientPath(file) {
    if (!file) {
      return "";
    }
    const full = path.resolve(file);
    for (const [remote, local] of this.sourceMapEntries()) {
      if (full === remote || full.startsWith(remote + path.sep)) {
        return path.join(local, path.relative(remote, full));
      }
    }
    return full;
  }

  toGdbPath(file) {
    if (!file) {
      return "";
    }
    const full = path.resolve(file);
    for (const [remote, local] of this.sourceMapEntries()) {
      if (full === local || full.startsWith(local + path.sep)) {
        return path.join(remote, path.relative(local, full));
      }
    }
    return full;
  }

  resolveCwd(program) {
    return path.resolve(expandVars(this.config.cwd, program ? path.dirname(program) : process.cwd()) || (program ? path.dirname(program) : process.cwd()));
  }

  async setupGdb(gdb, binary, cwd) {
    const traceEnv = runtimeTraceEnv(this.config);
    this.gdb = new GdbMi(
      this,
      gdb,
      binary,
      cwd,
      { ...process.env, ...traceEnv, ...(this.config.env || {}) },
      this.config.trace === true
    );
    await this.gdb.cmd("-gdb-set pagination off");
    await this.gdb.cmd("-gdb-set confirm off");
    await this.gdb.cmd("-gdb-set breakpoint pending on");
    await this.gdb.cmd("-gdb-set target-async on");
    await this.gdb.cmd("-gdb-set startup-with-shell off");
    await this.gdb.cmd("-enable-pretty-printing").catch(() => {});
    if (Array.isArray(this.config.args) && this.config.args.length > 0) {
      await this.gdb.cmd(`-exec-arguments ${this.config.args.map(miQuote).join(" ")}`);
    }
    for (const [key, value] of Object.entries(this.config.env || {})) {
      await this.gdb.cmd(`-gdb-set environment ${key}=${value}`);
    }
    this.logSection("debug", {
      gdb,
      binary: compactPath(binary, cwd),
      cwd,
      args: Array.isArray(this.config.args) && this.config.args.length > 0 ? this.config.args.join(" ") : "(none)",
      env: Object.keys(this.config.env || {}).sort().join(", ") || "(none)",
      "source-map": this.sourceMapEntries().length ? `${this.sourceMapEntries().length} rule(s)` : "none",
      trace: this.config.trace === true ? "raw mi on" : "raw mi off"
    });
  }

  async on_launch(request) {
    const launchStartedAt = Date.now();
    this.sessionStartedAt = launchStartedAt;
    this.config = request.arguments || {};
    this.requestKind = "launch";
    const program = path.resolve(expandVars(this.config.program, this.config.cwd));
    const cwd = this.resolveCwd(program);
    this.cwd = cwd;
    const ny = expandVars(this.config.nyPath, cwd) || findOnPath("ny");
    const gdb = expandVars(this.config.gdbPath, cwd) || findOnPath("gdb");
    if (!program || !fs.existsSync(program)) {
      throw new Error(`program not found: ${program || "(empty)"}`);
    }
    if (!ny) {
      throw new Error("ny compiler not found; set nytrix.path or nyPath in launch.json");
    }
    if (!gdb) {
      throw new Error("gdb not found; install gdb or set nytrix.debug.gdbPath");
    }

    const outDirRaw = expandVars(this.config.outputDir, cwd) || path.join(cwd, "build", "cache", "vscode-dap");
    const outDir = path.resolve(outDirRaw);
    fs.mkdirSync(outDir, { recursive: true });
    const binary = path.join(outDir, `${safeName(program)}-${process.pid}`);
    this.binary = binary;
    const compilerArgs = Array.isArray(this.config.compilerArgs) ? this.config.compilerArgs : [];
    const debugLocals = typeof this.config.debugLocals === "boolean" ? this.config.debugLocals : false;
    const hasOptArg = compilerArgs.some(isOptArg);
    const hasDebugLocalsArg = compilerArgs.some((arg) => arg === "--debug-locals" || arg === "--no-debug-locals");
    const traceEnv = runtimeTraceEnv(this.config);
    const args = [
      ...(Object.keys(traceEnv).length > 0 ? ["-trace"] : []),
      ...compilerArgs.filter((a) => a !== "-g"),
      ...(hasOptArg ? [] : ["-O0"]),
      ...(hasDebugLocalsArg ? [] : [debugLocals ? "--debug-locals" : "--no-debug-locals"]),
      "-g",
      "-o",
      binary,
      program
    ];
    this.logSection("launch", {
      request: "launch",
      program: compactPath(program, cwd),
      cwd,
      ny,
      gdb,
      output: compactPath(binary, cwd),
      args: Array.isArray(this.config.args) && this.config.args.length > 0 ? this.config.args.join(" ") : "(none)",
      env: Object.keys(this.config.env || {}).sort().join(", ") || "(none)",
      compile: `${ny} ${args.map(miQuote).join(" ")}`,
      locals: hasDebugLocalsArg ? "compilerArgs override" : (debugLocals ? "full" : "safe"),
      trace: formatTraceMode(this.config),
      "source-map": this.sourceMapEntries().length ? `${this.sourceMapEntries().length} rule(s)` : "none"
    });
    const build = cp.spawnSync(ny, args, {
      cwd,
      env: { ...process.env, ...traceEnv, ...(this.config.env || {}) },
      encoding: "utf8"
    });
    const buildOutput = `${build.stdout || ""}${build.stderr || ""}`;
    const buildSummary = summarizeText(buildOutput);
    if (build.stdout) {
      this.output(build.stdout, "stdout");
    }
    if (build.stderr) {
      this.output(build.stderr, "stderr");
    }
    this.logSection("build", {
      status: build.status === 0 ? "ok" : "failed",
      exit: build.status == null ? "signal" : build.status,
      elapsed: formatDuration(Date.now() - launchStartedAt),
      lines: buildSummary.lines,
      errors: buildSummary.errors,
      warnings: buildSummary.warnings,
      notes: buildSummary.notes,
      hints: buildSummary.hints,
      trace: Object.keys(traceEnv).length > 0
        ? Object.entries(traceEnv).map(([k, v]) => `${k}=${v}`).join(" ")
        : "off"
    });
    if (build.status !== 0) {
      throw new Error(`ny debug build failed with code ${build.status}`);
    }

    await this.setupGdb(gdb, binary, cwd);
    if (this.config.stopOnEntry) {
      await this.gdb.cmd("-break-insert main").catch((err) => this.output(`${err.message}\n`, "stderr"));
    }
    this.launched = true;
    this.conn.response(request, true);
    this.conn.event("initialized");
  }

  async on_attach(request) {
    this.sessionStartedAt = Date.now();
    this.config = request.arguments || {};
    this.requestKind = "attach";
    const pid = parsePositiveInt(this.config.processId || this.config.pid);
    if (!pid) {
      throw new Error("attach needs processId");
    }
    const program = this.config.program ? path.resolve(expandVars(this.config.program, this.config.cwd)) : "";
    const cwd = this.resolveCwd(program);
    this.cwd = cwd;
    this.binary = program;
    const gdb = expandVars(this.config.gdbPath, cwd) || findOnPath("gdb");
    if (!gdb) {
      throw new Error("gdb not found; install gdb or set nytrix.debug.gdbPath");
    }
    this.logSection("attach", {
      request: "attach",
      pid,
      program: program ? compactPath(program, cwd) : "(inferior provided)",
      cwd,
      gdb
    });
    await this.setupGdb(gdb, program, cwd);
    await this.gdb.cmd(`-target-attach ${pid}`);
    this.launched = true;
    this.conn.response(request, true);
    this.conn.event("initialized");
  }

  async on_setBreakpoints(request) {
    const sourcePath = request.arguments && request.arguments.source && request.arguments.source.path;
    const requested = request.arguments && request.arguments.breakpoints ? request.arguments.breakpoints : [];
    if (!sourcePath) {
      this.conn.response(request, true, { breakpoints: [] });
      return;
    }
    this.breakpoints.set(sourcePath, requested.map((bp, i) => ({
      id: i + 1,
      line: bp.line,
      column: bp.column || 1,
      condition: bp.condition || "",
      hitCondition: bp.hitCondition || "",
      logMessage: bp.logMessage || ""
    })));
    let bps = this.breakpoints.get(sourcePath).map((bp) => ({
      id: bp.id,
      verified: this.launched ? false : true,
      source: { path: sourcePath },
      line: bp.line,
      column: bp.column
    }));
    if (this.launched && this.gdb) {
      bps = await this.applyBreakpoints(sourcePath);
    }
    this.conn.response(request, true, { breakpoints: bps });
  }

  async applyBreakpoints(sourcePath) {
    const old = this.gdbBreakpoints.get(sourcePath) || [];
    if (old.length > 0) {
      await this.gdb.cmd(`-break-delete ${old.join(" ")}`).catch(() => {});
    }
    const out = [];
    const ids = [];
    const wanted = this.breakpoints.get(sourcePath) || [];
    const gdbPath = this.toGdbPath(sourcePath);
    for (let i = 0; i < wanted.length; i++) {
      const bp = wanted[i];
      if (bp.logMessage) {
        out.push({
          id: bp.id,
          verified: false,
          source: sourceFor(sourcePath),
          line: bp.line,
          column: bp.column,
          message: "Logpoints need native Nytrix DAP support; gdb/MI breakpoints cannot log without stopping yet."
        });
        continue;
      }
      try {
        const result = await this.gdb.cmd(`-break-insert ${miQuote(`${gdbPath}:${bp.line}`)}`);
        const bkpt = result.body.bkpt || {};
        const id = Number(bkpt.number || i + 1);
        if (bp.condition) {
          await this.gdb.cmd(`-break-condition ${id} ${miQuote(bp.condition)}`);
        }
        if (bp.hitCondition) {
          const hits = parsePositiveInt(bp.hitCondition, 0);
          if (!hits) {
            throw new Error(`unsupported hit condition: ${bp.hitCondition}`);
          }
          await this.gdb.cmd(`-break-after ${id} ${Math.max(0, hits - 1)}`);
        }
        const actualLine = Number(bkpt.line || bp.line);
        ids.push(id);
        out.push({
          id,
          verified: true,
          source: sourceFor(sourcePath),
          line: actualLine,
          column: bp.column,
          message: breakpointMessage(sourcePath, bp.line, actualLine)
        });
      } catch (err) {
        out.push({
          id: bp.id,
          verified: false,
          source: sourceFor(sourcePath),
          line: bp.line,
          column: bp.column,
          message: err.message
        });
      }
    }
    this.gdbBreakpoints.set(sourcePath, ids);
    return out;
  }

  async applyAllBreakpoints() {
    let sources = 0;
    let requested = 0;
    let verified = 0;
    let rejected = 0;
    for (const sourcePath of this.breakpoints.keys()) {
      sources += 1;
      const applied = await this.applyBreakpoints(sourcePath);
      requested += applied.length;
      for (const bp of applied) {
        if (bp.verified) {
          verified += 1;
        } else {
          rejected += 1;
        }
      }
    }
    return { sources, requested, verified, rejected };
  }

  async armAutoEntryBreakpoint() {
    if (!this.gdb || !this.config.program) {
      return null;
    }
    const sourcePath = path.resolve(this.config.program);
    const gdbPath = this.toGdbPath(sourcePath);
    const line = firstInterestingSourceLine(sourcePath);
    try {
      const result = await this.gdb.cmd(`-break-insert -t ${miQuote(`${gdbPath}:${line}`)}`);
      const bkpt = result.body.bkpt || {};
      const actualLine = Number(bkpt.line || line);
      this.logSection("auto-break", {
        mode: "entry",
        source: compactPath(sourcePath, this.cwd),
        line: actualLine
      });
      return { sourcePath, line: actualLine, id: Number(bkpt.number || 0) };
    } catch (err) {
      this.logSection("auto-break", {
        mode: "entry",
        source: compactPath(sourcePath, this.cwd),
        status: "failed",
        detail: err.message
      }, "stderr");
      return null;
    }
  }

  async on_setFunctionBreakpoints(request) {
    const requested = request.arguments && request.arguments.breakpoints ? request.arguments.breakpoints : [];
    if (!this.gdb) {
      this.conn.response(request, true, {
        breakpoints: requested.map((bp, i) => ({ id: i + 1, verified: false, message: "Debugger is not ready yet" }))
      });
      return;
    }
    const out = [];
    for (let i = 0; i < requested.length; i++) {
      const bp = requested[i];
      try {
        const result = await this.gdb.cmd(`-break-insert ${miQuote(bp.name)}`);
        const bkpt = result.body.bkpt || {};
        const id = Number(bkpt.number || i + 1);
        if (bp.condition) {
          await this.gdb.cmd(`-break-condition ${id} ${miQuote(bp.condition)}`);
        }
        out.push({ id, verified: true, line: Number(bkpt.line || 1) });
      } catch (err) {
        out.push({ id: i + 1, verified: false, message: err.message });
      }
    }
    this.conn.response(request, true, { breakpoints: out });
  }

  async on_configurationDone(request) {
    if (this.gdb) {
      const bpSummary = await this.applyAllBreakpoints();
      this.logSection("breakpoints", bpSummary);
      if (this.requestKind === "launch") {
        if (!this.config.stopOnEntry && bpSummary.requested === 0) {
          await this.armAutoEntryBreakpoint();
        }
        this.clearVariableState(true);
        this.running = true;
        this.logEvent("session", "starting inferior");
        this.gdb.cmd("-exec-run").catch((err) => this.output(`${err.message}\n`, "stderr"));
      } else if (!this.config.stopOnEntry) {
        this.clearVariableState(true);
        this.running = true;
        this.logEvent("session", "continuing attached inferior");
        this.gdb.cmd("-exec-continue").catch((err) => this.output(`${err.message}\n`, "stderr"));
      } else {
        this.logEvent("session", "attached and paused at entry");
        this.conn.event("stopped", {
          reason: "pause",
          threadId: 1,
          allThreadsStopped: true,
          description: "attached"
        });
      }
    }
    this.conn.response(request, true);
  }

  async on_threads(request) {
    const threads = await this.snapshotThreads();
    this.lastThreads = threads;
    this.conn.response(request, true, {
      threads: threads.map((thread) => ({ id: thread.id, name: thread.name }))
    });
  }

  async on_stackTrace(request) {
    if (!this.gdb) {
      this.conn.response(request, true, { stackFrames: [], totalFrames: 0 });
      return;
    }
    const startFrame = Math.max(0, Number((request.arguments && request.arguments.startFrame) || 0));
    const levels = Math.max(0, Number((request.arguments && request.arguments.levels) || 0));
    const rawFrames = this.lastFrames.length > 0 ? this.lastFrames : await this.fetchStackFrames(true);
    this.lastFrames = rawFrames;
    const visibleFrames = this.visibleFrames(rawFrames);
    const totalFrames = visibleFrames.length;
    let frames = visibleFrames.map((frame, i) => this.frameToDap(frame, i));
    if (startFrame || levels) {
      frames = frames.slice(startFrame, levels ? startFrame + levels : undefined);
    }
    this.conn.response(request, true, { stackFrames: frames, totalFrames });
  }

  async on_loadedSources(request) {
    if (!this.gdb) {
      this.conn.response(request, true, { sources: [] });
      return;
    }
    const result = await this.gdb.cmd("-file-list-exec-source-files").catch(() => ({ body: {} }));
    const files = normalizeArray(result.body.files, "file")
      .map((f) => this.toClientPath(f.fullname || f.file || ""))
      .filter(Boolean);
    for (const frame of this.lastFrames) {
      const file = this.toClientPath(frame.fullname || frame.file || "");
      if (file) {
        files.push(file);
      }
    }
    const unique = [...new Set(files)].map((file) => sourceFor(file));
    this.conn.response(request, true, { sources: unique });
  }

  async on_modules(request) {
    const modules = [];
    if (this.binary) {
      modules.push({
        id: this.binary,
        name: path.basename(this.binary),
        path: this.binary,
        isOptimized: false
      });
    }
    if (this.gdb) {
      const result = await this.gdb.cmd("-file-list-shared-libraries").catch(() => ({ body: {} }));
      for (const lib of normalizeArray(result.body["shared-libraries"], "library")) {
        const file = lib.target || lib.host || lib.name || "";
        if (!file) {
          continue;
        }
        modules.push({
          id: file,
          name: path.basename(file),
          path: file,
          isOptimized: true
        });
      }
    }
    const start = Math.max(0, Number((request.arguments && request.arguments.startModule) || 0));
    const count = Math.max(0, Number((request.arguments && request.arguments.moduleCount) || 0));
    this.conn.response(request, true, {
      modules: modules.slice(start, count ? start + count : undefined),
      totalModules: modules.length
    });
  }

  on_scopes(request) {
    const level = parseFrameId(request.arguments.frameId);
    const argRef = this.allocVarRef({ kind: "args", level });
    const localRef = this.allocVarRef({ kind: "locals", level });
    const registerRef = this.allocVarRef({ kind: "registers", level });
    this.conn.response(request, true, {
      scopes: [
        { name: "Arguments", variablesReference: argRef, expensive: false },
        { name: "Locals", variablesReference: localRef, expensive: false },
        { name: "Registers", variablesReference: registerRef, expensive: true }
      ]
    });
  }

  allocVarRef(data) {
    const id = this.nextVariableRef++;
    this.variableRefs.set(id, data);
    return id;
  }

  clearVariableState(destroy = false) {
    if (destroy && this.gdb && this.varObjects.size > 0) {
      for (const name of this.varObjects.keys()) {
        this.gdb.cmd(`-var-delete ${name}`).catch(() => {});
      }
    }
    this.variableRefs.clear();
    this.varObjects.clear();
    this.nextVariableRef = 1;
  }

  async createVarObject(expression) {
    try {
      const result = await this.gdb.cmd(`-var-create - * ${miQuote(expression)}`);
      const body = result.body || {};
      const numchild = parsePositiveInt(body.numchild, 0);
      const variablesReference = numchild > 0
        ? this.allocVarRef({ kind: "varobj", varobj: body.name, expression })
        : 0;
      if (body.name) {
        this.varObjects.set(body.name, { expression, variablesReference });
      }
      return {
        value: body.value || "",
        type: body.type || "",
        variablesReference
      };
    } catch {
      return { value: "", type: "", variablesReference: 0 };
    }
  }

  childName(child) {
    if (child.exp) {
      return child.exp;
    }
    const name = child.name || "";
    const idx = Math.max(name.lastIndexOf("."), name.lastIndexOf("["));
    return idx >= 0 ? name.slice(idx + 1).replace(/\]$/, "") : name || "<unnamed>";
  }

  variableFromChild(child) {
    const numchild = parsePositiveInt(child.numchild, 0);
    const variablesReference = numchild > 0
      ? this.allocVarRef({ kind: "varobj", varobj: child.name, expression: child.exp || child.name })
      : 0;
    if (child.name) {
      this.varObjects.set(child.name, { expression: child.exp || child.name, variablesReference });
    }
    return {
      name: this.childName(child),
      value: child.value || "",
      type: child.type || undefined,
      variablesReference,
      evaluateName: child.exp || child.name || undefined
    };
  }

  async on_variables(request) {
    if (!this.gdb) {
      this.conn.response(request, true, { variables: [] });
      return;
    }
    const ref = this.variableRefs.get(request.arguments.variablesReference);
    if (!ref) {
      this.conn.response(request, true, { variables: [] });
      return;
    }
    if (ref.kind === "args") {
      await this.gdb.cmd(`-stack-select-frame ${ref.level}`).catch(() => {});
      const args = await this.fetchFrameArguments(ref.level);
      const vars = [];
      for (const arg of args) {
        const name = arg.name || arg.arg || "<arg>";
        const obj = await this.createVarObject(name);
        vars.push({
          name,
          value: obj.value || arg.value || "",
          type: obj.type || arg.type || undefined,
          variablesReference: obj.variablesReference,
          evaluateName: name
        });
      }
      this.conn.response(request, true, { variables: vars });
      return;
    }
    if (ref.kind === "locals") {
      await this.gdb.cmd(`-stack-select-frame ${ref.level}`).catch(() => {});
      const result = await this.gdb.cmd("-stack-list-variables --simple-values");
      const vars = [];
      for (const v of normalizeArray(result.body.variables)) {
        const name = v.name || "<unnamed>";
        const obj = await this.createVarObject(name);
        vars.push({
          name,
          value: obj.value || v.value || "",
          type: obj.type || v.type || undefined,
          variablesReference: obj.variablesReference,
          evaluateName: name
        });
      }
      this.conn.response(request, true, { variables: vars });
      return;
    }
    if (ref.kind === "varobj") {
      const result = await this.gdb.cmd(`-var-list-children --all-values ${ref.varobj}`);
      const children = normalizeArray(result.body.children, "child").map((child) => this.variableFromChild(child));
      this.conn.response(request, true, { variables: children });
      return;
    }
    if (ref.kind === "registers") {
      const names = await this.gdb.cmd("-data-list-register-names").catch(() => ({ body: {} }));
      const values = await this.gdb.cmd("-data-list-register-values x").catch(() => ({ body: {} }));
      const regNames = normalizeArray(names.body["register-names"]);
      const regs = normalizeArray(values.body["register-values"]).map((r) => {
        const n = Number(r.number || 0);
        return {
          name: regNames[n] || `$${n}`,
          value: r.value || "",
          variablesReference: 0
        };
      });
      this.conn.response(request, true, { variables: regs });
      return;
    }
    this.conn.response(request, true, { variables: [] });
  }

  async on_evaluate(request) {
    if (!this.gdb) {
      this.conn.response(request, true, { result: "", variablesReference: 0 });
      return;
    }
    const expression = request.arguments && request.arguments.expression;
    if (!expression) {
      this.conn.response(request, true, { result: "", variablesReference: 0 });
      return;
    }
    if (request.arguments && request.arguments.frameId) {
      await this.gdb.cmd(`-stack-select-frame ${parseFrameId(request.arguments.frameId)}`).catch(() => {});
    }
    const result = await this.gdb.cmd(`-data-evaluate-expression ${miQuote(expression)}`);
    const obj = await this.createVarObject(expression);
    this.conn.response(request, true, {
      result: obj.value || result.body.value || "",
      type: obj.type || undefined,
      variablesReference: obj.variablesReference
    });
  }

  async on_continue(request) {
    this.clearVariableState(true);
    this.running = true;
    this.logEvent("session", "continue");
    this.gdb.cmd("-exec-continue").catch((err) => this.output(`${err.message}\n`, "stderr"));
    this.conn.response(request, true, { allThreadsContinued: true });
  }

  async on_next(request) {
    this.clearVariableState(true);
    this.running = true;
    this.logEvent("session", "step over");
    this.gdb.cmd("-exec-next").catch((err) => this.output(`${err.message}\n`, "stderr"));
    this.conn.response(request, true);
  }

  async on_stepIn(request) {
    this.clearVariableState(true);
    this.running = true;
    this.logEvent("session", "step in");
    this.gdb.cmd("-exec-step").catch((err) => this.output(`${err.message}\n`, "stderr"));
    this.conn.response(request, true);
  }

  async on_stepOut(request) {
    this.clearVariableState(true);
    this.running = true;
    this.logEvent("session", "step out");
    this.gdb.cmd("-exec-finish").catch((err) => this.output(`${err.message}\n`, "stderr"));
    this.conn.response(request, true);
  }

  async on_pause(request) {
    this.logEvent("session", "pause requested");
    this.gdb.cmd("-exec-interrupt").catch((err) => this.output(`${err.message}\n`, "stderr"));
    this.conn.response(request, true);
  }

  async on_terminate(request) {
    this.dispose();
    this.conn.response(request, true);
  }

  async on_disconnect(request) {
    this.dispose();
    this.conn.response(request, true);
  }

  on_setExceptionBreakpoints(request) {
    this.conn.response(request, true, { breakpoints: [] });
  }

  async on_exceptionInfo(request) {
    const signal = this.lastStop["signal-name"] || this.lastStop.reason || "nytrix";
    const meaning = this.lastStop["signal-meaning"] || this.lastStop.reason || "Nytrix native debug session stopped";
    const frames = this.lastFrames.length > 0 ? this.lastFrames : await this.fetchStackFrames(true).catch(() => []);
    const stackTrace = this.lastBacktrace || this.formatBacktrace(frames);
    const recentMessage = this.recentExceptionMessage();
    const description = recentMessage || meaning;
    this.conn.response(request, true, {
      exceptionId: signal,
      description,
      breakMode: "always",
      details: {
        typeName: signal,
        fullTypeName: meaning,
        message: description,
        stackTrace: stackTrace || undefined
      }
    });
  }

  onStopped(body) {
    this.running = false;
    this.lastStop = body || {};
    this.clearVariableState(false);
    const reason = body.reason || "";
    const frame = body.frame || {};
    const frameFile = this.toClientPath(frame.fullname || frame.file || "");
    const location = frameFile ? `${compactPath(frameFile, this.cwd)}:${frame.line || 1}` : "";
    if (reason === "exited-normally") {
      this.logSection("session", {
        status: "exited",
        exit: 0,
        elapsed: formatDuration(Date.now() - this.sessionStartedAt)
      });
      this.conn.event("exited", { exitCode: 0 });
      this.conn.event("terminated");
      this.terminated = true;
      return;
    }
    if (reason === "exited") {
      const exitCode = Number(body["exit-code"] || 0);
      this.logSection("session", {
        status: "exited",
        exit: exitCode,
        elapsed: formatDuration(Date.now() - this.sessionStartedAt)
      });
      this.conn.event("exited", { exitCode });
      this.conn.event("terminated");
      this.terminated = true;
      return;
    }
    const dapReason = reason.includes("breakpoint")
      ? "breakpoint"
      : reason.includes("signal")
        ? "exception"
        : reason.includes("end-stepping-range")
          ? "step"
          : "pause";
    this.logSection("stop", {
      reason: dapReason,
      detail: body.reason || "stopped",
      thread: Number(body["thread-id"] || 1),
      func: this.userFrameName(frame),
      at: location,
      signal: body["signal-name"] || "",
      meaning: body["signal-meaning"] || ""
    });
    this.conn.event("stopped", {
      reason: dapReason,
      threadId: Number(body["thread-id"] || 1),
      allThreadsStopped: true,
      description: body.reason || "stopped"
    });
    void this.captureStopSnapshot(dapReason);
  }

  dispose() {
    if (this.gdb) {
      this.gdb.dispose();
      this.gdb = null;
    }
    if (!this.terminated) {
      this.logSection("session", {
        status: "terminated",
        elapsed: formatDuration(Date.now() - this.sessionStartedAt)
      });
      this.conn.event("terminated");
      this.terminated = true;
    }
  }
}

new NytrixDebugAdapter();
