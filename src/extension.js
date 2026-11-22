"use strict";
/*
 * Nytrix for VS Code: a thin, language-agnostic bridge.
 *
 * The language owns everything: ny-lsp serves editor features and the
 * command list (nytrix/commands) and answers each command with a portable
 * action; ny-dap builds and debugs programs. This file only finds the
 * toolchain, starts the two servers, and performs the actions they return.
 */
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { LanguageClient, ExecuteCommandRequest } = require("vscode-languageclient/node");

const EXE = process.platform === "win32" ? ".exe" : "";
let client;
let output;
let status;

const cfg = () => vscode.workspace.getConfiguration("nytrix");

let manifestCache;
function manifest(context) {
  if (!manifestCache) {
    try { manifestCache = JSON.parse(fs.readFileSync(path.join(context.extensionPath, "language", "languages.json"), "utf8")); }
    catch { manifestCache = {}; }
  }
  return manifestCache;
}

function expandHome(p) {
  return p && p.startsWith("~") ? path.join(require("os").homedir(), p.slice(1)) : p;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/* Directories searched for the toolchain, most specific first. A build in the
 * workspace or NYTRIX_HOME wins over a possibly stale copy on PATH. */
function toolchainDirs() {
  const dirs = [];
  const setting = expandHome(cfg().get("toolchain", ""));
  if (setting) dirs.push(isFile(setting) ? path.dirname(setting) : setting);
  for (const env of ["NYTRIX_HOME", "NYTRIX_ROOT"]) {
    const home = process.env[env];
    if (home) dirs.push(path.join(home, "bin"), path.join(home, "build", "release"), home);
  }
  for (const folder of vscode.workspace.workspaceFolders || []) {
    dirs.push(path.join(folder.uri.fsPath, "build", "release"));
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir) dirs.push(dir);
  return dirs;
}

/* Full path of a toolchain executable (ny-lsp, ny-dap), or null. */
function findTool(name) {
  for (const dir of toolchainDirs()) {
    const candidate = path.join(dir, name + EXE);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

async function missingTool(name) {
  output.appendLine(`${name} not found. Set \`nytrix.toolchain\` to the directory containing ny-lsp and ny-dap.`);
  const pick = await vscode.window.showWarningMessage(`Nytrix: ${name} not found.`, "Open Settings");
  if (pick) vscode.commands.executeCommand("workbench.action.openSettings", "nytrix.toolchain");
}

function onPath(name) {
  return (process.env.PATH || "").split(path.delimiter).some((dir) => dir && isFile(path.join(dir, name + EXE)));
}

function toolEnv() {
  return { ...process.env, ...cfg().get("server.environment", {}) };
}

/* Default arguments for a server command: the active file and cursor line. */
function currentArgs(input, resource) {
  const editor = vscode.window.activeTextEditor;
  const args = {};
  if (resource instanceof vscode.Uri && resource.scheme === "file") {
    args.uri = resource.toString();
  } else if (editor && editor.document.uri.scheme === "file") {
    args.uri = editor.document.uri.toString();
    args.line = editor.selection.active.line;
  }
  if (input !== undefined) args.input = input;
  return args;
}

async function saveUri(uri) {
  if (!uri) return;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
  if (doc && doc.isDirty) await doc.save();
}

/* Performs an action returned by ny-lsp. */
async function perform(action) {
  if (!action || typeof action !== "object") return;
  await saveUri(action.save);
  if (action.kind === "process") {
    const exec = new vscode.ProcessExecution(action.command, action.args || [], { cwd: action.cwd, env: toolEnv() });
    const task = new vscode.Task({ type: "nytrix" }, vscode.TaskScope.Workspace, action.title || "Nytrix", "nytrix", exec, []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true, panel: vscode.TaskPanelKind.Shared };
    await vscode.tasks.executeTask(task);
  } else if (action.kind === "debug") {
    const uri = action.save ? vscode.Uri.parse(action.save) : undefined;
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    await vscode.debug.startDebugging(folder, action.configuration);
  } else if (action.kind === "message") {
    vscode.window.showInformationMessage(action.text);
  }
}

async function pickCommand() {
  if (!client) return vscode.window.showWarningMessage("The Nytrix language server is not running.");
  const { commands } = await client.sendRequest("nytrix/commands", {});
  const editor = vscode.window.activeTextEditor;
  const lang = editor ? editor.document.languageId : "";
  const items = commands
    .filter((c) => c.scope.includes(lang) || c.scope.includes("workspace"))
    .map((c) => ({ label: c.title, command: c }));
  const choice = await vscode.window.showQuickPick(items, { placeHolder: "Run a Nytrix command" });
  if (!choice) return;
  let input;
  if (choice.command.input) {
    const word = editor && editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active) || editor.selection);
    input = await vscode.window.showInputBox({ prompt: choice.command.input, value: word || "" });
    if (input === undefined) return;
  }
  const action = await client.sendRequest(ExecuteCommandRequest.type, { command: choice.command.id, arguments: [currentArgs(input)] });
  await perform(action);
}

async function startServer(context) {
  const lsp = findTool("ny-lsp");
  if (!lsp) {
    status.text = "$(warning) Nytrix";
    status.tooltip = "ny-lsp not found: set nytrix.toolchain";
    await missingTool("ny-lsp");
    return;
  }
  const selector = (manifest(context).server && manifest(context).server.documentSelector) || [{ language: "nytrix" }];
  const server = { command: lsp, args: cfg().get("server.arguments", []), options: { env: toolEnv() } };
  client = new LanguageClient("nytrix", "Nytrix", server, {
    documentSelector: selector.map((s) => ({ scheme: "file", ...s })),
    outputChannel: output,
    middleware: {
      // Server commands (code lenses, keybindings) return actions to perform.
      executeCommand: async (command, args, next) => {
        const action = await next(command, args && args.length ? args : [currentArgs()]);
        await perform(action);
        return action;
      }
    }
  });
  await client.start();
  status.text = "$(check) Nytrix";
  status.tooltip = `Toolchain: ${path.dirname(lsp)}`;
}

async function restartServer(context) {
  if (client) await client.stop().catch(() => {});
  client = undefined;
  await startServer(context);
}

function registerDebugger(context) {
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("nytrix", {
    createDebugAdapterDescriptor() {
      const dap = findTool("ny-dap");
      if (!dap) {
        missingTool("ny-dap");
        throw new Error("ny-dap not found: set nytrix.toolchain");
      }
      const debuggerPath = cfg().get("debugger", "");
      if (!debuggerPath && !onPath("gdb") && !onPath("lldb-dap")) {
        vscode.window.showErrorMessage("Nytrix debugging needs gdb 14+ or lldb-dap on PATH, or set nytrix.debugger.", "Open Settings")
          .then((pick) => pick && vscode.commands.executeCommand("workbench.action.openSettings", "nytrix.debugger"));
        throw new Error("no native debugger found (gdb 14+ or lldb-dap)");
      }
      const args = debuggerPath ? ["--debugger", expandHome(debuggerPath)] : [];
      return new vscode.DebugAdapterExecutable(dap, args, { env: toolEnv() });
    }
  }));
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("nytrix", {
    resolveDebugConfiguration(_folder, config) {
      const editor = vscode.window.activeTextEditor;
      if (!config.type && !config.request) {
        if (!editor) return config;
        config = { type: "nytrix", request: "launch", name: "Nytrix: Debug File", program: "${file}", cwd: "${fileDirname}" };
      }
      if (config.sourceLine === undefined && editor) config.sourceLine = editor.selection.active.line;
      return config;
    }
  }));
}

/* Runs a server command and performs the action it returns. */
async function runServerCommand(def, resource) {
  if (!client) return vscode.window.showWarningMessage("The Nytrix language server is not running.");
  let input;
  if (def.input) {
    const editor = vscode.window.activeTextEditor;
    const word = editor && editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active) || editor.selection);
    input = await vscode.window.showInputBox({ prompt: def.input, value: word || "" });
    if (input === undefined) return;
  }
  const action = await client.sendRequest(ExecuteCommandRequest.type, { command: def.server, arguments: [currentArgs(input, resource)] });
  await perform(action);
}

/* Debugs a file (the active editor by default) with the F5 configuration. */
async function debugFile(resource) {
  const uri = resource instanceof vscode.Uri ? resource : (vscode.window.activeTextEditor || {}).document?.uri;
  if (!uri) return vscode.window.showWarningMessage("Open a Nytrix file to debug.");
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc && doc.isDirty) await doc.save();
  await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), {
    type: "nytrix", request: "launch", name: `Nytrix: ${path.basename(uri.fsPath)}`,
    program: uri.fsPath, cwd: path.dirname(uri.fsPath)
  });
}

/* One wrapper per manifest command: toolbar buttons, menus and the palette. */
function registerUiCommands(context) {
  for (const def of manifest(context).commands || []) {
    const handler = def.id === "debug" ? debugFile : (resource) => runServerCommand(def, resource);
    context.subscriptions.push(vscode.commands.registerCommand(`nytrix.ui.${def.id}`, handler));
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel("Nytrix");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = "nytrix.commands";
  status.text = "Nytrix";
  status.show();
  context.subscriptions.push(output, status,
    vscode.commands.registerCommand("nytrix.commands", pickCommand),
    vscode.commands.registerCommand("nytrix.restartServer", () => restartServer(context)),
    vscode.commands.registerCommand("nytrix.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("nytrix.showToolchain", () =>
      vscode.window.showInformationMessage(
        `Nytrix toolchain — ny-lsp: ${findTool("ny-lsp") || "not found"}, ny-dap: ${findTool("ny-dap") || "not found"}`)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nytrix.toolchain") || e.affectsConfiguration("nytrix.server")) restartServer(context);
    }));
  registerUiCommands(context);
  registerDebugger(context);
  if (vscode.workspace.isTrusted) await startServer(context);
  else context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => startServer(context)));
}

async function deactivate() {
  if (client) await client.stop();
}

module.exports = { activate, deactivate };
