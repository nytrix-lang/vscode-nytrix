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

function expandHome(p) {
  return p && p.startsWith("~") ? path.join(require("os").homedir(), p.slice(1)) : p;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/* Directory holding ny-lsp/ny-dap: setting, NYTRIX_HOME, PATH, workspace build. */
function toolchainDir() {
  const candidates = [];
  const setting = expandHome(cfg().get("toolchain", ""));
  if (setting) candidates.push(isFile(setting) ? path.dirname(setting) : setting);
  for (const env of ["NYTRIX_HOME", "NYTRIX_ROOT"]) {
    if (process.env[env]) {
      candidates.push(path.join(process.env[env], "bin"), path.join(process.env[env], "build", "release"), process.env[env]);
    }
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir) candidates.push(dir);
  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(path.join(folder.uri.fsPath, "build", "release"));
  }
  return candidates.find((dir) => isFile(path.join(dir, "ny-lsp" + EXE))) || null;
}

function toolEnv() {
  return { ...process.env, ...cfg().get("server.environment", {}) };
}

/* Default arguments for a server command: the active file and cursor line. */
function currentArgs(input) {
  const editor = vscode.window.activeTextEditor;
  const args = {};
  if (editor && editor.document.uri.scheme === "file") {
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
    .map((c) => ({ label: c.title, description: c.id, command: c }));
  const choice = await vscode.window.showQuickPick(items, { placeHolder: "Nytrix command" });
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
  const dir = toolchainDir();
  if (!dir) {
    status.text = "$(warning) Nytrix";
    status.tooltip = "ny-lsp not found: set nytrix.toolchain";
    output.appendLine("ny-lsp not found. Set `nytrix.toolchain` to the directory containing ny-lsp and ny-dap.");
    return;
  }
  const manifestPath = path.join(context.extensionPath, "language", "languages.json");
  const manifest = isFile(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
  const selector = (manifest.server && manifest.server.documentSelector) || [{ language: "nytrix" }];
  const server = { command: path.join(dir, "ny-lsp" + EXE), args: cfg().get("server.arguments", []), options: { env: toolEnv() } };
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
  status.tooltip = `Toolchain: ${dir}`;
}

async function restartServer(context) {
  if (client) await client.stop().catch(() => {});
  client = undefined;
  await startServer(context);
}

function registerDebugger(context) {
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("nytrix", {
    createDebugAdapterDescriptor() {
      const dir = toolchainDir();
      if (!dir) throw new Error("ny-dap not found: set nytrix.toolchain");
      const args = cfg().get("debugger", "") ? ["--debugger", cfg().get("debugger")] : [];
      return new vscode.DebugAdapterExecutable(path.join(dir, "ny-dap" + EXE), args, { env: toolEnv() });
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
      vscode.window.showInformationMessage(`Nytrix toolchain: ${toolchainDir() || "not found"}`)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nytrix.toolchain") || e.affectsConfiguration("nytrix.server")) restartServer(context);
    }));
  registerDebugger(context);
  if (vscode.workspace.isTrusted) await startServer(context);
  else context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => startServer(context)));
}

async function deactivate() {
  if (client) await client.stop();
}

module.exports = { activate, deactivate };
