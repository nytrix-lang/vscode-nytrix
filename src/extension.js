"use strict";

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

let client = null;
let output = null;
let checkDiagnostics = null;
let adviceDiagnostics = null;
let runStatus = null;
let lspStatus = null;
let cachedTools = null;
let extensionContext = null;
let sharedTerminal = null;
let sharedReplTerminal = null;
let sharedReplBooted = false;
let lspReady = false;
let outputSectionCount = 0;
let errorLensTypes = null;
let diagnosticsRefreshTimer = null;
let bootstrapPromise = null;
let workspaceSymbolIndex = null;

const NYTRIX_BOOTSTRAP_REPO = "https://github.com/nytrix-lang/nytrix";
const NYTRIX_FILE_SELECTOR = { language: "nytrix", scheme: "file" };
const SEMANTIC_TOKEN_TYPES = ["function", "class", "enum", "type", "variable", "property", "namespace", "operator"];
const TOOL_SPECS = {
  ny: { bin: "ny", config: "path", env: "NYTRIX_NY" },
  lsp: { bin: "ny-lsp", config: "lsp.path", env: "NYTRIX_LSP" },
  fmt: { bin: "ny-fmt" },
  doc: { bin: "ny-doc", config: "doc.path", env: "NYTRIX_DOC" },
  test: { bin: "ny-test" },
  perf: { bin: "ny-perf" },
  make: { bin: "ny-make" }
};

function lspOwnsLanguageFeatures() {
  return cfg().get("lsp.enabled", true) && lspReady;
}

function registerCommands(context, entries) {
  context.subscriptions.push(
    ...entries.map(([id, handler]) => vscode.commands.registerCommand(id, handler))
  );
}

function subscribe(context, ...disposables) {
  context.subscriptions.push(...disposables);
}

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel("Nytrix");
  checkDiagnostics = vscode.languages.createDiagnosticCollection("nytrix");
  adviceDiagnostics = vscode.languages.createDiagnosticCollection("nytrix-assist");
  errorLensTypes = createErrorLensTypes();
  runStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
  lspStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 87);
  runStatus.command = "nytrix.showActions";
  lspStatus.command = "nytrix.showToolchain";

  subscribe(context, output, checkDiagnostics, adviceDiagnostics, runStatus, lspStatus);
  if (errorLensTypes) {
    subscribe(context, ...Object.values(errorLensTypes));
  }
  registerCommands(context, [
    ["nytrix.showActions", showActions],
    ["nytrix.showOutput", () => showOutput(true)],
    ["nytrix.clearOutput", clearOutputChannel],
    ["nytrix.pickRunMode", pickRunMode],
    ["nytrix.pickOutputReveal", pickOutputReveal],
    ["nytrix.startRepl", startRepl],
    ["nytrix.focusRepl", focusRepl],
    ["nytrix.resetRepl", resetRepl],
    ["nytrix.clearRepl", clearRepl],
    ["nytrix.sendSelectionToRepl", sendSelectionToRepl],
    ["nytrix.runFileInRepl", runFileInRepl],
    ["nytrix.loadFileInRepl", loadFileInRepl],
    ["nytrix.runFile", runFile],
    ["nytrix.runSelection", runSelection],
    ["nytrix.checkFile", checkFile],
    ["nytrix.debugFile", debugFile],
    ["nytrix.expandFile", expandFile],
    ["nytrix.formatFile", formatFile],
    ["nytrix.optimizeFile", optimizeFile],
    ["nytrix.analyzeFile", analyzeFile],
    ["nytrix.traceFile", traceFile],
    ["nytrix.dumpAst", dumpAst],
    ["nytrix.dumpLlvm", dumpLlvm],
    ["nytrix.dumpStats", dumpStats],
    ["nytrix.runTests", runTests],
    ["nytrix.profileFile", profileFile],
    ["nytrix.searchDocs", searchDocs],
    ["nytrix.searchDocsForSelection", searchDocsForSelection],
    ["nytrix.openSettings", openSettings],
    ["nytrix.openDetails", openDetails],
    ["nytrix.goToDefinition", () => editorCommand("editor.action.revealDefinition")],
    ["nytrix.peekDefinition", () => editorCommand("editor.action.peekDefinition")],
    ["nytrix.findDefinitionByName", () => findDefinitionByName(workspaceSymbolIndex)],
    ["nytrix.findReferences", () => editorCommand("references-view.findReferences")],
    ["nytrix.renameSymbol", () => editorCommand("editor.action.rename")],
    ["nytrix.showHover", () => editorCommand("editor.action.showHover")],
    ["nytrix.showSignatureHelp", () => editorCommand("editor.action.triggerParameterHints")],
    ["nytrix.gotoDocumentSymbol", () => editorCommand("workbench.action.gotoSymbol")],
    ["nytrix.gotoWorkspaceSymbol", () => editorCommand("workbench.action.showAllSymbols")],
    ["nytrix.navigateBack", () => vscode.commands.executeCommand("workbench.action.navigateBack")],
    ["nytrix.navigateForward", () => vscode.commands.executeCommand("workbench.action.navigateForward")],
    ["nytrix.restartLsp", () => restartLsp(context)],
    ["nytrix.installToolchain", () => installToolchain(context)],
    ["nytrix.showToolchain", showToolchain],
    ["nytrix.pickProcess", pickProcess]
  ]);
  subscribe(context, vscode.window.onDidChangeActiveTextEditor(() => {
    updateStatus();
    scheduleActiveEditorDiagnosticsRefresh();
  }));
  subscribe(context, vscode.window.onDidChangeVisibleTextEditors(() => scheduleActiveEditorDiagnosticsRefresh()));
  subscribe(context, vscode.languages.onDidChangeDiagnostics(() => scheduleActiveEditorDiagnosticsRefresh()));
  subscribe(context, vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === sharedTerminal) {
      sharedTerminal = null;
    }
    if (terminal === sharedReplTerminal) {
      sharedReplTerminal = null;
      sharedReplBooted = false;
    }
  }));
  subscribe(context, vscode.workspace.onDidSaveTextDocument(onSaveCheck));
  subscribe(context, vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("nytrix")) {
      cachedTools = null;
      updateStatus();
      restartLsp(context);
      scheduleActiveEditorDiagnosticsRefresh(20);
    }
  }));
  subscribe(context, vscode.languages.registerCodeLensProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixCodeLensProvider()
  ));
  subscribe(context, vscode.languages.registerCodeActionsProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixCodeActionProvider(),
    {
      providedCodeActionKinds: [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.SourceFixAll,
        vscode.CodeActionKind.SourceOrganizeImports
      ]
    }
  ));
  subscribe(context, vscode.languages.registerDocumentFormattingEditProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixDocumentFormattingProvider()
  ));
  const symbolIndex = new NytrixSymbolIndex();
  workspaceSymbolIndex = symbolIndex;
  subscribe(context, symbolIndex);
  subscribe(context, vscode.languages.registerDefinitionProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixDefinitionProvider(symbolIndex)
  ));
  subscribe(context, vscode.languages.registerReferenceProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixReferenceProvider(symbolIndex)
  ));
  subscribe(context, vscode.languages.registerHoverProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixHoverProvider(symbolIndex)
  ));
  subscribe(context, vscode.languages.registerDocumentSymbolProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixDocumentSymbolProvider(symbolIndex)
  ));
  if (typeof vscode.SemanticTokensLegend === "function" && typeof vscode.SemanticTokensBuilder === "function") {
    subscribe(context, vscode.languages.registerDocumentSemanticTokensProvider(
      NYTRIX_FILE_SELECTOR,
      new NytrixSemanticTokensProvider(symbolIndex),
      new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES, [])
    ));
  }
  subscribe(context, vscode.languages.registerWorkspaceSymbolProvider(
    new NytrixWorkspaceSymbolProvider(symbolIndex)
  ));
  subscribe(context, vscode.languages.registerCompletionItemProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixCompletionProvider(symbolIndex),
    ".", ":", "(", "_"
  ));
  subscribe(context, vscode.languages.registerSignatureHelpProvider(
    NYTRIX_FILE_SELECTOR,
    new NytrixSignatureProvider(symbolIndex),
    "(", ","
  ));
  subscribe(context, vscode.workspace.onDidSaveTextDocument((document) => {
    symbolIndex.updateDocument(document);
    symbolIndex.refreshCompilerSymbols(document);
  }));
  subscribe(context, vscode.workspace.onDidChangeTextDocument((event) => {
    symbolIndex.updateDocument(event.document);
    if (isNytrixDocument(event.document)) {
      scheduleActiveEditorDiagnosticsRefresh(120);
    }
  }));
  subscribe(context, vscode.debug.registerDebugConfigurationProvider(
    "nytrix",
    new NytrixDebugConfigurationProvider()
  ));
  subscribe(context, vscode.debug.registerDebugAdapterDescriptorFactory(
    "nytrix",
    new NytrixDebugAdapterFactory()
  ));
  subscribe(context, vscode.tasks.registerTaskProvider("nytrix", new NytrixTaskProvider()));

  updateStatus();
  startLsp(context);
}

function deactivate() {
  if (client) {
    const old = client;
    client = null;
    return old.stop();
  }
  return undefined;
}

function createErrorLensTypes() {
  if (!vscode.window || typeof vscode.window.createTextEditorDecorationType !== "function") {
    return null;
  }
  const makeType = (themeColor) => vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor(themeColor),
      fontStyle: "italic",
      margin: "0 0 0 1.6em"
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  return {
    error: makeType("editorError.foreground"),
    warning: makeType("editorWarning.foreground"),
    information: makeType("editorInfo.foreground"),
    hint: makeType("editorHint.foreground")
  };
}

function clearErrorLensDecorations(editor) {
  if (!errorLensTypes || !editor) {
    return;
  }
  for (const decorationType of Object.values(errorLensTypes)) {
    editor.setDecorations(decorationType, []);
  }
}

function diagnosticSeverityBucket(severity) {
  if (severity === vscode.DiagnosticSeverity.Error) {
    return "error";
  }
  if (severity === vscode.DiagnosticSeverity.Warning) {
    return "warning";
  }
  if (severity === vscode.DiagnosticSeverity.Hint) {
    return "hint";
  }
  return "information";
}

function isNytrixDiagnosticSource(diagnostic) {
  const source = String(diagnostic && diagnostic.source ? diagnostic.source : "");
  return source === "nytrix" || source === "nytrix-analyze";
}

function summarizeDiagnosticCounts(diagnostics) {
  const counts = {
    error: 0,
    warning: 0,
    information: 0,
    hint: 0,
    total: 0,
    fixable: 0
  };
  for (const diagnostic of diagnostics || []) {
    if (!diagnostic) {
      continue;
    }
    const bucket = diagnosticSeverityBucket(diagnostic.severity);
    counts[bucket] += 1;
    counts.total += 1;
    const code = diagnosticCodeString(diagnostic);
    if (isFormatDiagnostic(code) || isOptimizationDiagnostic(code) || code === "NYFMT2000") {
      counts.fixable += 1;
    }
  }
  return counts;
}

function formatDiagnosticCountsLabel(counts) {
  const parts = [];
  if (counts.error) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
  }
  if (counts.warning) {
    parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
  }
  if (counts.information) {
    parts.push(`${counts.information} note${counts.information === 1 ? "" : "s"}`);
  }
  if (counts.hint) {
    parts.push(`${counts.hint} hint${counts.hint === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function formatErrorLensMessage(diagnostic) {
  const bucket = diagnosticSeverityBucket(diagnostic.severity);
  const code = diagnosticCodeString(diagnostic);
  const source = diagnostic && diagnostic.source ? String(diagnostic.source).replace(/^nytrix-?/, "") : "ny";
  const label = code ? `${source} ${bucket} [${code}]` : `${source} ${bucket}`;
  return compactLogValue(`${label}: ${diagnostic.message}`, 132);
}

function buildErrorLensHover(diagnostic) {
  const lines = [];
  const bucket = diagnosticSeverityBucket(diagnostic.severity);
  const code = diagnosticCodeString(diagnostic);
  lines.push(`**${bucket.toUpperCase()}**${code ? ` \`${code}\`` : ""}`);
  lines.push(String(diagnostic.message || ""));
  const related = Array.isArray(diagnostic.relatedInformation) ? diagnostic.relatedInformation : [];
  for (const item of related.slice(0, 3)) {
    if (item && item.message) {
      lines.push(`- ${item.message}`);
    }
  }
  return new vscode.MarkdownString(lines.join("\n\n"));
}

function scheduleActiveEditorDiagnosticsRefresh(delayMs = 80) {
  if (diagnosticsRefreshTimer) {
    clearTimeout(diagnosticsRefreshTimer);
  }
  diagnosticsRefreshTimer = setTimeout(() => {
    diagnosticsRefreshTimer = null;
    const editors = Array.isArray(vscode.window.visibleTextEditors) ? vscode.window.visibleTextEditors : [];
    for (const editor of editors) {
      if (isNytrixDocument(editor.document)) {
        updateErrorLens(editor);
      }
    }
  }, delayMs);
}

function updateErrorLens(editor) {
  if (!errorLensTypes || !editor) {
    return;
  }
  if (!cfg().get("errorLens.enabled", true) || !isNytrixDocument(editor.document)) {
    clearErrorLensDecorations(editor);
    return;
  }
  const includeHints = cfg().get("errorLens.includeHints", true);
  const maxItems = Math.max(0, Number(cfg().get("errorLens.maxItems", 40)) || 40);
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
    .filter((diagnostic) => isNytrixDiagnosticSource(diagnostic))
    .filter((diagnostic) => includeHints || diagnostic.severity !== vscode.DiagnosticSeverity.Hint)
    .sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return a.range.start.line - b.range.start.line;
      }
      return a.range.start.character - b.range.start.character;
    });
  const buckets = {
    error: [],
    warning: [],
    information: [],
    hint: []
  };
  for (const diagnostic of diagnostics.slice(0, maxItems)) {
    const lineNumber = Math.min(Math.max(0, diagnostic.range.end.line), Math.max(0, editor.document.lineCount - 1));
    const lineText = editor.document.lineAt(lineNumber).text;
    const anchor = lineText.length;
    const bucket = diagnosticSeverityBucket(diagnostic.severity);
    buckets[bucket].push({
      range: new vscode.Range(lineNumber, anchor, lineNumber, anchor),
      hoverMessage: buildErrorLensHover(diagnostic),
      renderOptions: {
        after: {
          contentText: `  ${formatErrorLensMessage(diagnostic)}`
        }
      }
    });
  }
  editor.setDecorations(errorLensTypes.error, buckets.error);
  editor.setDecorations(errorLensTypes.warning, buckets.warning);
  editor.setDecorations(errorLensTypes.information, buckets.information);
  editor.setDecorations(errorLensTypes.hint, buckets.hint);
}

function cfg() {
  return vscode.workspace.getConfiguration("nytrix");
}

function bootstrapMode() {
  return cfg().get("bootstrap.mode", "prompt");
}

function bootstrapRoot() {
  const fallback = path.join(os.homedir(), ".local", "share", "nytrix");
  return path.resolve(expandVars(cfg().get("bootstrap.root", fallback)) || fallback);
}

function bootstrapRepo() {
  return expandVars(cfg().get("bootstrap.repo", NYTRIX_BOOTSTRAP_REPO)) || NYTRIX_BOOTSTRAP_REPO;
}

function bootstrapRef() {
  return String(cfg().get("bootstrap.ref", "main") || "main").trim() || "main";
}

function exeName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function bootstrapToolPaths(root = bootstrapRoot()) {
  const release = path.join(root, "build", "release");
  return {
    root,
    ny: path.join(release, exeName(TOOL_SPECS.ny.bin)),
    lsp: path.join(release, exeName(TOOL_SPECS.lsp.bin)),
    fmt: path.join(release, exeName(TOOL_SPECS.fmt.bin)),
    doc: path.join(release, exeName(TOOL_SPECS.doc.bin)),
    test: path.join(release, exeName(TOOL_SPECS.test.bin)),
    perf: path.join(release, exeName(TOOL_SPECS.perf.bin)),
    makeScript: path.join(root, "make")
  };
}

function bootstrapPlan(root = bootstrapRoot()) {
  const repo = bootstrapRepo();
  const ref = bootstrapRef();
  const paths = bootstrapToolPaths(root);
  const git = findOnPath("git");
  const python = findOnPath("python3") || findOnPath("python");
  const buildCommand = process.platform === "win32"
    ? (python || "python3")
    : paths.makeScript;
  const buildArgs = process.platform === "win32" ? [paths.makeScript] : [];
  return {
    repo,
    ref,
    root,
    git,
    python,
    paths,
    cloneArgs: ["clone", "--depth", "1", "--branch", ref, repo, root],
    fetchArgs: ["-C", root, "fetch", "--depth", "1", "origin", ref],
    resetArgs: ["-C", root, "reset", "--hard", "FETCH_HEAD"],
    buildCommand,
    buildArgs
  };
}

function isNytrixDocument(document) {
  return document && document.languageId === "nytrix";
}

function activeNytrixEditor() {
  const editor = vscode.window.activeTextEditor;
  return editor && isNytrixDocument(editor.document) ? editor : null;
}

async function resolveNytrixDocument(target) {
  if (!target) {
    const editor = activeNytrixEditor();
    return editor ? editor.document : null;
  }
  if (isNytrixDocument(target)) {
    return target;
  }
  if (target.document && isNytrixDocument(target.document)) {
    return target.document;
  }
  let uri = null;
  if (target instanceof vscode.Uri) {
    uri = target;
  } else if (typeof target === "string" && target) {
    uri = vscode.Uri.file(target);
  } else if (target.uri instanceof vscode.Uri) {
    uri = target.uri;
  }
  if (!uri) {
    return null;
  }
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  if (open) {
    return isNytrixDocument(open) ? open : null;
  }
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    return isNytrixDocument(document) ? document : null;
  } catch {
    return null;
  }
}

function diagnosticCollection(kind) {
  return kind === "advice" ? adviceDiagnostics : checkDiagnostics;
}

async function editorCommand(command) {
  const editor = activeNytrixEditor();
  if (!editor) {
    return;
  }
  await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  return vscode.commands.executeCommand(command);
}

function expandVars(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  let out = value;
  if (out === "~" || out.startsWith("~/")) {
    out = path.join(os.homedir(), out.slice(2));
  }
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (folder) {
    out = out.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
  }
  out = out.replace(/\$\{home\}/g, os.homedir());
  return out;
}

function candidateNames(name) {
  if (process.platform === "win32" && !name.endsWith(".exe")) {
    return [name + ".exe", name];
  }
  return [name];
}

function isRunnable(file) {
  if (!file || !fs.existsSync(file)) {
    return false;
  }
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return process.platform === "win32";
  }
}

function pushRootCandidates(roots, root) {
  if (!root) {
    return;
  }
  let cur = path.resolve(expandVars(root));
  for (let i = 0; i < 8; i++) {
    roots.push(cur);
    const next = path.dirname(cur);
    if (next === cur) {
      break;
    }
    cur = next;
  }
}

function candidateRoots(context) {
  const roots = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    pushRootCandidates(roots, folder.uri.fsPath);
  }
  if (context && context.extensionPath) {
    pushRootCandidates(roots, context.extensionPath);
  }
  if (process.env.NYTRIX_HOME) {
    roots.push(expandVars(process.env.NYTRIX_HOME));
  }
  roots.push(bootstrapRoot());
  roots.push(path.join(os.homedir(), "nytrix"));
  roots.push(path.join(os.homedir(), ".nytrix"));

  const seen = new Set();
  return roots.filter((root) => {
    const real = path.resolve(root);
    if (seen.has(real)) {
      return false;
    }
    seen.add(real);
    return true;
  });
}

function findOnPath(name) {
  const paths = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
    for (const candidate of candidateNames(name)) {
      const full = path.join(dir, candidate);
      if (isRunnable(full)) {
        return full;
      }
    }
  }
  return "";
}

function configKeyForTool(tool) {
  const spec = Object.values(TOOL_SPECS).find((entry) => entry.bin === tool);
  return spec && spec.config ? spec.config : "";
}

function envKeyForTool(tool) {
  const spec = Object.values(TOOL_SPECS).find((entry) => entry.bin === tool);
  if (spec && spec.env) {
    return spec.env;
  }
  return `NYTRIX_${tool.replace(/^ny-/, "").replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

function findTool(context, tool) {
  const configuration = cfg();
  const configKey = configKeyForTool(tool);
  const configured = configKey ? expandVars(configuration.get(configKey, "")) : "";
  if (configured && isRunnable(configured)) {
    return { path: configured, source: "settings" };
  }

  const envKey = envKeyForTool(tool);
  const envPath = expandVars(process.env[envKey] || "");
  if (envPath && isRunnable(envPath)) {
    return { path: envPath, source: envKey };
  }

  const rels = [
    ["build", "release", tool],
    ["build", "debug", tool],
    ["build", tool],
    [tool]
  ];
  for (const root of candidateRoots(context)) {
    for (const rel of rels) {
      const base = path.join(root, ...rel);
      for (const candidate of candidateNames(base)) {
        if (isRunnable(candidate)) {
          return { path: candidate, source: root };
        }
      }
    }
  }

  const onPath = findOnPath(tool);
  if (onPath) {
    return { path: onPath, source: "PATH" };
  }
  return { path: "", source: "not found" };
}

function findRepoRoot(context) {
  for (const root of candidateRoots(context || extensionContext)) {
    if (fs.existsSync(path.join(root, "make")) && fs.existsSync(path.join(root, "src"))) {
      return root;
    }
  }
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : process.cwd();
}

function tools(context) {
  if (!cachedTools) {
    const ctx = context || extensionContext;
    cachedTools = Object.fromEntries(
      Object.entries(TOOL_SPECS).map(([key, spec]) => [key, findTool(ctx, spec.bin)])
    );
    cachedTools.dap = findDebugAdapter(ctx);
  }
  return cachedTools;
}

function findDebugAdapter(context) {
  if (cfg().get("debugAdapter.useInternal", true)) {
    return { path: "", source: "built-in" };
  }

  const configured = expandVars(cfg().get("debugAdapter.path", ""));
  if (configured && isRunnable(configured)) {
    return { path: configured, source: "settings" };
  }
  return { path: "", source: "not found" };
}

function findNodeRuntime() {
  return findOnPath("node") || process.execPath;
}

function toolEnv() {
  const env = { ...process.env };
  const extra = cfg().get("env", {});
  if (extra && typeof extra === "object") {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = String(value);
    }
  }
  return env;
}

function noteBootstrapOutputHeader(plan, reason) {
  if (cfg().get("output.clearBeforeRun", false)) {
    output.clear();
    outputSectionCount = 0;
  } else if (outputSectionCount > 0) {
    output.appendLine("");
    output.appendLine("-".repeat(72));
  }
  outputSectionCount += 1;
  output.appendLine("== Nytrix Install Toolchain ==");
  appendOutputFields({
    started: logTimestamp(Date.now()),
    reason,
    repo: plan.repo,
    ref: plan.ref,
    root: plan.root
  });
  output.appendLine("");
}

async function runBootstrapStep(label, command, args, cwd, progress) {
  appendOutputSection("bootstrap", {
    step: label,
    cwd,
    command: commandLine(command, args)
  });
  if (progress) {
    progress.report({ message: label });
  }
  const result = await captureProcess(command, args, cwd);
  const text = stripAnsi(result.output || "").trimEnd();
  if (text) {
    output.appendLine(text);
  }
  output.appendLine("");
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit ${result.code}`);
  }
}

async function applyBootstrapToolSettings(plan) {
  const target = preferredConfigTarget();
  await cfg().update("path", plan.paths.ny, target);
  await cfg().update("lsp.path", plan.paths.lsp, target);
}

async function promptForToolPath(name, label) {
  const configKey = name === "dap" ? "debugAdapter.path" : configKeyForTool(name === "lsp" ? "ny-lsp" : name);
  if (!configKey) {
    await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:x3ric.nytrix ${label}`);
    return null;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: `Select ${label}`,
    openLabel: `Use ${label}`
  });
  if (!picked || !picked.length) {
    return null;
  }
  const selected = picked[0].fsPath;
  await cfg().update(configKey, selected, preferredConfigTarget());
  cachedTools = null;
  vscode.window.showInformationMessage(`Nytrix: using ${label} at ${selected}`);
  if (name === "lsp" && extensionContext) {
    await restartLsp(extensionContext);
  } else {
    updateStatus();
  }
  const found = tools(extensionContext)[name];
  return found && found.path ? found : null;
}

async function installToolchain(context, options = {}) {
  const mode = bootstrapMode();
  const allowPrompt = options.prompt !== false;
  const force = options.force === true;
  const reason = options.reason || "Nytrix tools were not found";
  if (bootstrapPromise) {
    return bootstrapPromise;
  }
  if (!force && mode === "off") {
    return null;
  }
  if (!force) {
    if (!allowPrompt) {
      return null;
    }
    const choice = await vscode.window.showWarningMessage(
      "Nytrix tools were not found. Clone and build the official Nytrix toolchain now, or set paths yourself?",
      "Install Nytrix",
      "Set Paths",
      "Not Now"
    );
    if (choice === "Set Paths") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:x3ric.nytrix nytrix.path");
      return null;
    }
    if (choice !== "Install Nytrix") {
      return null;
    }
  }
  const plan = bootstrapPlan();
  if (!plan.git) {
    vscode.window.showErrorMessage("Nytrix bootstrap needs git on PATH.");
    return null;
  }
  bootstrapPromise = vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Nytrix: installing toolchain",
    cancellable: false
  }, async (progress) => {
    const startedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(plan.root), { recursive: true });
      noteBootstrapOutputHeader(plan, reason);
      showOutput(true);
      const hasGitCheckout = fs.existsSync(path.join(plan.root, ".git"));
      if (!hasGitCheckout) {
        await runBootstrapStep("clone", plan.git, plan.cloneArgs, path.dirname(plan.root), progress);
      } else {
        await runBootstrapStep("fetch", plan.git, plan.fetchArgs, plan.root, progress);
        await runBootstrapStep("reset", plan.git, plan.resetArgs, plan.root, progress);
      }
      if (process.platform !== "win32" && fs.existsSync(plan.paths.makeScript)) {
        try {
          fs.chmodSync(plan.paths.makeScript, 0o755);
        } catch {
          /* best effort */
        }
      }
      if (!plan.buildCommand) {
        throw new Error("No build command available for Nytrix bootstrap");
      }
      await runBootstrapStep("build", plan.buildCommand, plan.buildArgs, plan.root, progress);
      await applyBootstrapToolSettings(plan);
      cachedTools = null;
      if (context || extensionContext) {
        await restartLsp(context || extensionContext);
      } else {
        updateStatus();
      }
      appendOutputSection("result", {
        status: "ok",
        elapsed: formatElapsedMs(Date.now() - startedAt),
        ny: plan.paths.ny,
        lsp: plan.paths.lsp
      });
      vscode.window.showInformationMessage("Nytrix toolchain installed and linked to this extension.");
      return tools(context || extensionContext);
    } catch (err) {
      appendOutputSection("result", {
        status: "failed",
        elapsed: formatElapsedMs(Date.now() - startedAt),
        detail: err && err.message ? err.message : String(err)
      });
      showOutput(true);
      vscode.window.showErrorMessage("Nytrix bootstrap failed.", "Open Output").then((choice) => {
        if (choice === "Open Output") {
          showOutput(true);
        }
      });
      return null;
    } finally {
      bootstrapPromise = null;
      cachedTools = null;
      updateStatus();
    }
  });
  return bootstrapPromise;
}

function workspaceCwd(document) {
  const configured = expandVars(cfg().get("run.cwd", ""));
  if (configured) {
    return configured;
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) {
    return folder.uri.fsPath;
  }
  return path.dirname(document.uri.fsPath);
}

function shellQuote(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '\\"')}"`;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandLine(command, args) {
  return [shellQuote(command), ...args.map(shellQuote)].join(" ");
}

function terminalCommandLine(command, args, cwd) {
  const cmd = commandLine(command, args);
  if (!cwd) {
    return cmd;
  }
  if (process.platform === "win32") {
    return `cd /d ${shellQuote(cwd)} && ${cmd}`;
  }
  return `cd ${shellQuote(cwd)} && ${cmd}`;
}

function replMode() {
  return cfg().get("run.mode", "terminal");
}

function runModeMeta(mode = replMode()) {
  switch (mode) {
    case "repl":
      return {
        mode,
        label: "REPL",
        detail: "Send files and snippets into a persistent Nytrix REPL.",
        statusText: "$(terminal) Nytrix",
        statusMessage: "Nytrix: run mode set to REPL"
      };
    case "output":
      return {
        mode,
        label: "Output",
        detail: "Run through the shared Nytrix output channel with structured logs.",
        statusText: "$(output) Nytrix",
        statusMessage: "Nytrix: run mode set to Output"
      };
    default:
      return {
        mode: "terminal",
        label: "Terminal",
        detail: "Run in the shared integrated terminal for a shell-first workflow.",
        statusText: "$(play) Nytrix",
        statusMessage: "Nytrix: run mode set to Terminal"
      };
  }
}

function outputRevealMeta(mode = cfg().get("output.reveal", "errors")) {
  switch (mode) {
    case "always":
      return {
        mode,
        label: "Always",
        detail: "Reveal the Nytrix output channel whenever a command starts or finishes."
      };
    case "never":
      return {
        mode,
        label: "Never",
        detail: "Keep the Nytrix output channel tucked away unless you open it yourself."
      };
    default:
      return {
        mode: "errors",
        label: "Errors",
        detail: "Only reveal the Nytrix output channel for failures or commands that stream output."
      };
  }
}

function preferredConfigTarget() {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

async function pickRunMode() {
  const current = runModeMeta();
  const items = [
    runModeMeta("terminal"),
    runModeMeta("output"),
    runModeMeta("repl")
  ].map((item) => ({
    label: item.label,
    description: item.mode === current.mode ? "Current" : "",
    detail: item.detail,
    mode: item.mode
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Choose how Nytrix Run File and Run Selection should execute",
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) {
    return;
  }
  await cfg().update("run.mode", picked.mode, preferredConfigTarget());
  updateStatus();
  vscode.window.setStatusBarMessage(runModeMeta(picked.mode).statusMessage, 2200);
}

async function pickOutputReveal() {
  const current = outputRevealMeta();
  const items = [
    outputRevealMeta("errors"),
    outputRevealMeta("always"),
    outputRevealMeta("never")
  ].map((item) => ({
    label: item.label,
    description: item.mode === current.mode ? "Current" : "",
    detail: item.detail,
    mode: item.mode
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Choose when Nytrix should reveal the shared output channel",
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) {
    return;
  }
  await cfg().update("output.reveal", picked.mode, preferredConfigTarget());
  updateStatus();
  vscode.window.setStatusBarMessage(`Nytrix: output reveal set to ${picked.label}`, 2200);
}

function nytrixTerminal(label, cwd) {
  const reuse = cfg().get("run.reuseTerminal", true);
  if (reuse && sharedTerminal) {
    return sharedTerminal;
  }
  const term = vscode.window.createTerminal({
    name: reuse ? "Nytrix" : label,
    cwd,
    env: toolEnv()
  });
  if (reuse) {
    sharedTerminal = term;
  }
  return term;
}

function runTerminal(label, command, args, cwd) {
  const term = nytrixTerminal(label, cwd);
  term.show(true);
  term.sendText(terminalCommandLine(command, args, cwd));
}

function replCwd(document) {
  const configured = expandVars(cfg().get("repl.cwd", ""));
  if (configured) {
    return configured;
  }
  if (document) {
    return workspaceCwd(document);
  }
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : findRepoRoot();
}

function replTerminal(document) {
  if (sharedReplTerminal) {
    return sharedReplTerminal;
  }
  const term = vscode.window.createTerminal({
    name: "Nytrix REPL",
    cwd: replCwd(document),
    env: toolEnv()
  });
  sharedReplTerminal = term;
  sharedReplBooted = false;
  return term;
}

function replStartupArgs() {
  const args = [];
  if (cfg().get("repl.usePlain", false)) {
    args.push("--plain-repl");
  }
  args.push("-i");
  for (const arg of cfg().get("repl.arguments", [])) {
    args.push(String(arg));
  }
  return args;
}

async function ensureRepl(document, options = {}) {
  const ny = await nyOrShow({ reason: "Starting the REPL needs the Nytrix compiler" });
  if (!ny) {
    return null;
  }
  const term = replTerminal(document);
  const reveal = options.reveal !== undefined ? options.reveal : cfg().get("repl.revealTerminal", true);
  if (!sharedReplBooted) {
    if (reveal) {
      term.show(true);
    }
    term.sendText(terminalCommandLine(ny.path, replStartupArgs(), replCwd(document)));
    sharedReplBooted = true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  } else if (reveal) {
    term.show(true);
  }
  return term;
}

async function sendReplCommand(text, document, options = {}) {
  const term = await ensureRepl(document, options);
  if (!term || !text || !String(text).trim()) {
    return false;
  }
  const reveal = options.reveal !== undefined ? options.reveal : cfg().get("repl.revealTerminal", true);
  if (reveal) {
    term.show(true);
  }
  term.sendText(String(text), true);
  vscode.window.setStatusBarMessage(`Nytrix REPL: ${options.status || "snippet sent"}`, 1800);
  return true;
}

function showOutput(preserveFocus = true) {
  if (output) {
    output.show(preserveFocus);
  }
}

function clearOutputChannel() {
  outputSectionCount = 0;
  if (output) {
    output.clear();
  }
  vscode.window.setStatusBarMessage("Nytrix: output cleared", 1500);
}

async function resolveToolWithBootstrap(name, label, options = {}) {
  let found = tools(extensionContext)[name];
  if (found && found.path) {
    return found;
  }
  if (options.attemptInstall === true) {
    const installed = await installToolchain(extensionContext, {
      prompt: true,
      reason: options.reason || `${label} was not found`
    });
    if (installed && installed[name] && installed[name].path) {
      return installed[name];
    }
    cachedTools = null;
    found = tools(extensionContext)[name];
    if (found && found.path) {
      return found;
    }
  }
  if (options.showError === false) {
    return null;
  }
  const choice = await vscode.window.showErrorMessage(
    `${label} not found. Install Nytrix now, set the tool path in settings, or inspect the resolved toolchain paths.`,
    "Install Nytrix",
    "Set Path",
    "Show Toolchain"
  );
  if (choice === "Install Nytrix") {
    const installed = await installToolchain(extensionContext, {
      force: true,
      reason: options.reason || `${label} was not found`
    });
    if (installed && installed[name] && installed[name].path) {
      return installed[name];
    }
    cachedTools = null;
    found = tools(extensionContext)[name];
    if (found && found.path) {
      return found;
    }
    return null;
  }
  if (choice === "Set Path") {
    return promptForToolPath(name, label);
  }
  if (choice === "Show Toolchain") {
    await showToolchain();
  }
  return null;
}

async function nyOrShow(options = {}) {
  return resolveToolWithBootstrap("ny", "Nytrix compiler", options);
}

async function toolOrShow(name, label, options = {}) {
  return resolveToolWithBootstrap(name, label, options);
}

async function saveDocument(document) {
  if (document.isDirty) {
    await document.save();
  }
}

async function preparedToolDocument(document, toolName, label, reason, options = {}) {
  const target = await resolveNytrixDocument(document);
  if (!target || !isNytrixDocument(target)) {
    return null;
  }
  const resolver = toolName === "ny" ? nyOrShow : (toolOptions) => toolOrShow(toolName, label, toolOptions);
  const tool = await resolver({ reason, ...options });
  if (!tool) {
    return null;
  }
  await saveDocument(target);
  return { target, tool, cwd: workspaceCwd(target) };
}

async function runActiveNyCommand(label, makeArgs, options = {}) {
  const editor = activeNytrixEditor();
  if (!editor) {
    return null;
  }
  const ny = await nyOrShow({ reason: options.reason });
  if (!ny) {
    return null;
  }
  await saveDocument(editor.document);
  return runProcess(
    ny.path,
    makeArgs(editor.document),
    workspaceCwd(editor.document),
    label,
    options.process || {}
  );
}

async function runFmtDocument(document, args, label, reason, options = {}) {
  const prepared = await preparedToolDocument(document, "fmt", "ny-fmt", reason);
  if (!prepared) {
    return null;
  }
  const result = await runProcess(prepared.tool.path, [...args, prepared.target.uri.fsPath], prepared.cwd, label, options);
  await refreshAnalyzeDiagnostics(prepared.target, {
    quiet: true,
    fallbackOutput: result.output,
    fallbackCode: result.code
  });
  return result;
}

async function runFile() {
  const editor = activeNytrixEditor();
  if (!editor) {
    return;
  }
  if (replMode() === "repl") {
    await runFileInRepl(editor.document);
    return;
  }
  const ny = await nyOrShow();
  if (!ny) {
    return;
  }
  await saveDocument(editor.document);
  const args = [editor.document.uri.fsPath, ...cfg().get("run.arguments", [])];
  const cwd = workspaceCwd(editor.document);
  if (replMode() === "output" || !cfg().get("run.useIntegratedTerminal", true)) {
    await runProcess(ny.path, args, cwd, "Run File");
  } else {
    runTerminal("Nytrix", ny.path, args, cwd);
  }
}

async function runSelection() {
  const editor = activeNytrixEditor();
  if (!editor) {
    return;
  }
  if (replMode() === "repl") {
    await sendSelectionToRepl(editor);
    return;
  }
  const ny = await nyOrShow();
  if (!ny) {
    return;
  }
  let selection = editor.document.getText(editor.selection);
  if (!selection.trim()) {
    selection = editor.document.lineAt(editor.selection.active.line).text;
  }
  if (!selection.trim()) {
    return;
  }
  await runProcess(ny.path, ["-c", selection], workspaceCwd(editor.document), "Run Selection", { reveal: "always" });
}

async function startRepl() {
  const editor = activeNytrixEditor();
  await ensureRepl(editor ? editor.document : null, { reveal: true });
}

async function focusRepl() {
  const editor = activeNytrixEditor();
  const term = await ensureRepl(editor ? editor.document : null, { reveal: true });
  if (term) {
    term.show(false);
  }
}

async function resetRepl() {
  const editor = activeNytrixEditor();
  await sendReplCommand(":reset", editor ? editor.document : null, { status: "reset requested" });
}

async function clearRepl() {
  const editor = activeNytrixEditor();
  await sendReplCommand(":clear", editor ? editor.document : null, { status: "clear requested" });
}

async function sendSelectionToRepl(editorArg) {
  const editor = editorArg && editorArg.document ? editorArg : activeNytrixEditor();
  if (!editor) {
    return;
  }
  await saveDocument(editor.document);
  let snippet = editor.document.getText(editor.selection);
  let label = "selection sent";
  if (!snippet.trim()) {
    snippet = editor.document.lineAt(editor.selection.active.line).text;
    label = "line sent";
  }
  if (!snippet.trim()) {
    return;
  }
  await sendReplCommand(snippet, editor.document, { status: label });
}

async function runFileInRepl(documentArg) {
  const editor = activeNytrixEditor();
  const document = documentArg || (editor && editor.document);
  if (!document || !isNytrixDocument(document)) {
    return;
  }
  await saveDocument(document);
  await sendReplCommand(`:run ${document.uri.fsPath}`, document, { status: "file sent to REPL" });
}

async function loadFileInRepl(documentArg) {
  const editor = activeNytrixEditor();
  const document = documentArg || (editor && editor.document);
  if (!document || !isNytrixDocument(document)) {
    return;
  }
  await saveDocument(document);
  await sendReplCommand(`:load ${document.uri.fsPath}`, document, { status: "file loaded into REPL" });
}

async function checkFile(document, options = {}) {
  const prepared = await preparedToolDocument(document, "ny", "Nytrix compiler", "Nytrix check needs the compiler", {
    prompt: options.prompt !== false,
    showError: options.showError !== false,
    attemptInstall: options.attemptInstall !== false
  });
  if (!prepared) {
    return;
  }
  const result = await runProcess(
    prepared.tool.path,
    ["--diag-compact", "-emit-only", prepared.target.uri.fsPath],
    prepared.cwd,
    "Check File",
    { quietSuccess: true }
  );
  publishDiagnostics("check", prepared.target, result.output, result.code);
  if (result.code === 0) {
    vscode.window.setStatusBarMessage("Nytrix: check passed", 2000);
  }
}

async function debugFile() {
  const editor = activeNytrixEditor();
  if (!editor) {
    return;
  }
  const ny = await nyOrShow({ reason: "Debug launch needs the Nytrix compiler" });
  if (!ny) {
    return;
  }
  await saveDocument(editor.document);
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const cwd = workspaceCwd(editor.document);
  await vscode.debug.startDebugging(folder, resolveNytrixDebugConfig(folder, {
    request: "launch",
    name: "Nytrix: Debug Current File",
    program: editor.document.uri.fsPath,
    cwd,
    args: cfg().get("run.arguments", []),
    stopOnEntry: false
  }, editor.document));
}

async function expandFile() {
  await runActiveNyCommand("Expand File", (document) => ["--expand", document.uri.fsPath]);
}

async function pickProcess() {
  const command = process.platform === "win32" ? "wmic" : "ps";
  const args = process.platform === "win32"
    ? ["process", "get", "ProcessId,CommandLine", "/FORMAT:CSV"]
    : ["-axo", "pid=,comm=,args="];
  const result = cp.spawnSync(command, args, { encoding: "utf8" });
  const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    if (process.platform === "win32") {
      const cols = line.split(",");
      const pid = cols.pop();
      const label = cols.join(" ").trim();
      if (/^\d+$/.test(pid)) {
        items.push({ label: `${pid}  ${label || "process"}`, pid });
      }
      continue;
    }
    const match = line.match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (match) {
      items.push({ label: `${match[1]}  ${match[2]}`, description: match[3], pid: match[1] });
    }
  }
  const picked = await vscode.window.showQuickPick(items.slice(0, 1000), {
    placeHolder: "Attach Nytrix debugger to process"
  });
  return picked ? picked.pid : "";
}

async function formatFile(document) {
  await runFmtDocument(document, ["--fix"], "Format File", "Formatting needs ny-fmt");
}

async function optimizeFile(document) {
  await runFmtDocument(document, ["--optimize", "--apply"], "Optimize File", "Optimization needs ny-fmt");
}

async function analyzeFile(document) {
  await runFmtDocument(document, ["--analyze", "--no-color"], "Analyze File", "Analyze needs ny-fmt", { reveal: "always" });
}

function selectedOrWord(editor) {
  if (!editor) {
    return "";
  }
  const selected = editor.document.getText(editor.selection).trim();
  if (selected) {
    return selected;
  }
  const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][A-Za-z0-9_.-]*/);
  return range ? editor.document.getText(range).trim() : "";
}

async function runDocSearch(query, label = "Search Docs") {
  const doc = await toolOrShow("doc", "ny-doc", { reason: "Documentation search needs ny-doc" });
  if (!doc) {
    return;
  }
  const cwd = activeNytrixEditor() ? workspaceCwd(activeNytrixEditor().document) : findRepoRoot();
  await runProcess(doc.path, ["search", query], cwd, label, { reveal: "always" });
}

async function searchDocs() {
  const editor = activeNytrixEditor();
  const seed = selectedOrWord(editor);
  const query = await vscode.window.showInputBox({
    title: "Search Nytrix docs and symbols",
    prompt: "Search stdlib modules, symbols, docs, and keyword tags through ny-doc.",
    value: seed,
    placeHolder: "e.g. list flatten power_mod std.math regex fmt"
  });
  if (!query || !query.trim()) {
    return;
  }
  await runDocSearch(query.trim(), "Search Docs");
}

async function searchDocsForSelection() {
  const editor = activeNytrixEditor();
  const query = selectedOrWord(editor);
  if (!query) {
    return searchDocs();
  }
  await runDocSearch(query, "Search Docs for Selection");
}

async function openSettings() {
  await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:x3ric.nytrix");
}

async function openDetails() {
  if (!extensionContext) {
    return;
  }
  const uri = vscode.Uri.file(path.join(extensionContext.extensionPath, "DETAILS.md"));
  await vscode.commands.executeCommand("markdown.showPreview", uri);
}

async function traceFile() {
  await runActiveNyCommand("Trace File", (document) => ["-trace", "-run", document.uri.fsPath], { process: { reveal: "always" } });
}

async function dumpAst() {
  await runActiveNyCommand("Dump AST", (document) => ["-dump-ast", document.uri.fsPath], { process: { reveal: "always" } });
}

async function dumpLlvm() {
  await runActiveNyCommand("Dump LLVM", (document) => ["-dump-llvm", document.uri.fsPath], { process: { reveal: "always" } });
}

async function dumpStats() {
  await runActiveNyCommand("Dump Stats", (document) => ["-dump-stats", "-time", document.uri.fsPath], { process: { reveal: "always" } });
}

async function runTests() {
  const test = await toolOrShow("test", "ny-test", { reason: "Running tests needs ny-test" });
  if (!test) {
    return;
  }
  runTerminal("Nytrix Tests", test.path, ["--with-stdlib", runtimeSuitePath()], findRepoRoot());
}

async function profileFile() {
  const editor = activeNytrixEditor();
  const perf = await toolOrShow("perf", "ny-perf", { reason: "Profiling needs ny-perf" });
  if (!editor || !perf) {
    return;
  }
  await saveDocument(editor.document);
  runTerminal("Nytrix Profile", perf.path, ["profile", editor.document.uri.fsPath, "--"], workspaceCwd(editor.document));
}

async function showActions() {
  const editor = activeNytrixEditor();
  const items = [];
  const modeMeta = runModeMeta();
  const revealMeta = outputRevealMeta();
  const fileSections = editor ? [
    ["Session", [
      [`Run Mode: ${modeMeta.label}`, "nytrix.pickRunMode", modeMeta.detail, "Config"],
      [`Output Reveal: ${revealMeta.label}`, "nytrix.pickOutputReveal", revealMeta.detail, "Config"]
    ]],
    ["File", [
      ["Run Current File", "nytrix.runFile", `Compile and run the active Nytrix file through ${modeMeta.label.toLowerCase()} mode.`, "Run"],
      ["Check Current File", "nytrix.checkFile", "Compiler diagnostics with problems integration.", "Check"],
      ["Expand Current File", "nytrix.expandFile", "Show sugar / expansion metadata in the Nytrix output.", "Expand"],
      ["Debug Current File", "nytrix.debugFile", "Launch the built-in Nytrix debug adapter.", "Debug"],
      ["Format Current File", "nytrix.formatFile", "Apply ny-fmt fixes to the active file.", "Format"],
      ["Analyze Current File", "nytrix.analyzeFile", "Run ny-fmt analysis notes and publish diagnostics.", "Analyze"],
      ["Trace Current File", "nytrix.traceFile", "Run with runtime call tracing.", "Trace"],
      ["Dump AST", "nytrix.dumpAst", "Print the compiler AST to the Nytrix output.", "AST"],
      ["Dump LLVM", "nytrix.dumpLlvm", "Print the lowered LLVM IR to the Nytrix output.", "LLVM"],
      ["Dump Compile Stats", "nytrix.dumpStats", "Emit compile stats and timings.", "Stats"]
    ]],
    ["REPL", [
      ["Start REPL", "nytrix.startRepl", "Boot a persistent Nytrix REPL in an integrated terminal.", "REPL"],
      ["Focus REPL", "nytrix.focusRepl", "Reveal the persistent Nytrix REPL terminal.", "REPL"],
      ["Send Selection / Line to REPL", "nytrix.sendSelectionToRepl", "Send the current selection, or the current line when nothing is selected.", "REPL"],
      ["Load Current File in REPL", "nytrix.loadFileInRepl", "Use :load on the active file to keep defs in the persistent REPL state.", "REPL"],
      ["Run Current File in REPL", "nytrix.runFileInRepl", "Use :run on the active file inside the persistent REPL.", "REPL"],
      ["Reset REPL", "nytrix.resetRepl", "Reset the persistent REPL state without closing the terminal.", "REPL"],
      ["Clear REPL Screen", "nytrix.clearRepl", "Clear the REPL display while keeping its state alive.", "REPL"]
    ]],
    ["Inspect", [
      ["Show Symbol Hover", "nytrix.showHover", "Open the richer Nytrix hover card for the symbol at the cursor.", "Inspect"],
      ["Show Signature Help", "nytrix.showSignatureHelp", "Preview the active call signature and parameter list.", "Inspect"],
      ["Go to Definition", "nytrix.goToDefinition", "Jump to the best definition match for the symbol at the cursor.", "Inspect"],
      ["Peek Definition", "nytrix.peekDefinition", "Preview the symbol definition inline without leaving the editor.", "Inspect"],
      ["Find Definition by Name", "nytrix.findDefinitionByName", "Type a function or symbol name and jump to the best indexed match.", "Inspect"],
      ["Find References", "nytrix.findReferences", "List symbol usages across the workspace.", "Inspect"],
      ["Go to Symbol in File", "nytrix.gotoDocumentSymbol", "Quick-jump to a symbol inside the current file.", "Inspect"],
      ["Go to Symbol in Workspace", "nytrix.gotoWorkspaceSymbol", "Search symbols across the indexed workspace and stdlib.", "Inspect"]
    ]],
    ["Docs", [
      ["Search Docs / API", "nytrix.searchDocs", "Search ny-doc across stdlib modules, symbols, docs, and keyword tags.", "Docs"],
      ["Search Docs for Selection", "nytrix.searchDocsForSelection", "Search ny-doc for the selected text or symbol under cursor.", "Docs"]
    ]]
  ] : [];
  const sections = [...fileSections, ["Workspace", [
    ["Install / Update Nytrix Toolchain", "nytrix.installToolchain", "Clone or refresh the official Nytrix repo, build the toolchain, and wire the extension settings automatically.", "Tools"],
    ["Run Runtime Tests", "nytrix.runTests", "Run the runtime suite through ny-test.", "Tests"],
    ["Show Toolchain", "nytrix.showToolchain", "Inspect resolved ny / ny-lsp / formatter / debug paths.", "Tools"],
    ["Open Settings", "nytrix.openSettings", "Open this extension's settings with the Nytrix filter applied.", "Config"],
    ["Open Extension Details", "nytrix.openDetails", "Open the full Nytrix extension reference.", "Docs"],
    ["Show Output", "nytrix.showOutput", "Reveal the shared Nytrix output channel.", "Output"],
    ["Clear Output", "nytrix.clearOutput", "Clear the Nytrix output channel.", "Output"],
    ["Restart Language Server", "nytrix.restartLsp", "Restart ny-lsp and refresh extension-side fallback state.", "LSP"]
  ]]];
  for (const [section, actions] of sections) {
    items.push({ label: section, kind: vscode.QuickPickItemKind.Separator });
    for (const [label, command, detail, description] of actions) {
      items.push({ label, command, detail, description });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: editor ? "Nytrix actions for the current file" : "Nytrix workspace actions",
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (picked && picked.command) {
    await vscode.commands.executeCommand(picked.command);
  }
}

function runProcess(command, args, cwd, label, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let done = false;
    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      resolve(result);
    };
    if (cfg().get("output.clearBeforeRun", false)) {
      output.clear();
      outputSectionCount = 0;
    } else if (outputSectionCount > 0) {
      output.appendLine("");
      output.appendLine("-".repeat(72));
    }
    outputSectionCount += 1;
    output.appendLine(`== Nytrix ${label} ==`);
    appendOutputFields({
      started: logTimestamp(startedAt),
      cwd,
      tool: command,
      command: commandLine(command, args)
    });
    output.appendLine("");
    if (shouldRevealOutput(options, "start")) {
      showOutput(true);
    }
    const child = cp.spawn(command, args, {
      cwd,
      env: toolEnv(),
      shell: false
    });
    let text = "";
    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      text += s;
      output.append(s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      text += s;
      output.append(s);
    });
    child.on("error", (err) => {
      if (done) {
        return;
      }
      const msg = `${label} failed: ${err.message}`;
      text += msg + "\n";
      output.appendLine(msg);
      output.appendLine("");
      appendOutputSection("result", {
        status: "failed",
        exit: -1,
        elapsed: formatElapsedMs(Date.now() - startedAt)
      });
      showOutput(true);
      presentProcessFailure(label, -1, { errors: 1, warnings: 0, notes: 0, hints: 0 });
      finish({ code: -1, output: text, elapsedMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      if (done) {
        return;
      }
      const elapsedMs = Date.now() - startedAt;
      const summary = summarizeOutputText(text);
      output.appendLine("");
      appendOutputSection("result", {
        status: code === 0 ? "ok" : "failed",
        exit: code || 0,
        elapsed: formatElapsedMs(elapsedMs),
        lines: summary.lines,
        errors: summary.errors,
        warnings: summary.warnings,
        notes: summary.notes,
        hints: summary.hints
      });
      if (shouldRevealOutput(options, "done", code || 0)) {
        showOutput(true);
      }
      if ((code || 0) !== 0) {
        presentProcessFailure(label, code || 0, summary);
      }
      vscode.window.setStatusBarMessage(
        `Nytrix: ${label} ${code === 0 ? "ok" : "failed"} in ${formatElapsedMs(elapsedMs)}`,
        2500
      );
      finish({ code: code || 0, output: text, elapsedMs, summary });
    });
  });
}

function captureProcess(command, args, cwd, options = {}) {
  return new Promise((resolve) => {
    let done = false;
    const child = cp.spawn(command, args, {
      cwd,
      env: toolEnv(),
      shell: false
    });
    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    const timeoutMs = Math.max(0, Number(options.timeoutMs || 0) || 0);
    const timer = timeoutMs > 0 ? setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish({
        code: -1,
        timedOut: true,
        output: `timed out after ${timeoutMs}ms\n`,
        summary: { lines: 1, errors: 1, warnings: 0, notes: 0, hints: 0 }
      });
    }, timeoutMs) : null;
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      text += chunk.toString();
    });
    child.on("error", (err) => {
      finish({
        code: -1,
        output: `${err.message}\n`,
        summary: { lines: 1, errors: 1, warnings: 0, notes: 0, hints: 0 }
      });
    });
    child.on("close", (code) => {
      finish({
        code: code || 0,
        output: text,
        summary: summarizeOutputText(text)
      });
    });
  });
}

function parseJsonText(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function documentTextLength(document) {
  try {
    return typeof document.getText === "function" ? document.getText().length : 0;
  } catch {
    return 0;
  }
}

function documentStamp(document) {
  return `${document && document.version != null ? document.version : "no-version"}:${documentTextLength(document)}`;
}

function compilerSymbolKind(kind) {
  const value = String(kind || "");
  if (value === "extern" || value === "macro") {
    return "fn";
  }
  if (value === "use") {
    return "module";
  }
  if (value === "define") {
    return "def";
  }
  if (value === "del") {
    return "mut";
  }
  return value || "fn";
}

function symbolNeedle(name, kind) {
  const raw = String(name || "");
  if (kind === "operator") {
    return raw.replace(/^operator\s+/, "").trim() || raw;
  }
  if (kind === "module" && raw.includes(".")) {
    return raw;
  }
  return raw.includes(".") ? raw.split(".").pop() : raw;
}

function documentLineText(document, row) {
  if (!document || row < 0 || row >= document.lineCount) {
    return "";
  }
  try {
    return document.lineAt(row).text || "";
  } catch {
    return "";
  }
}

function symbolRangeFromCompiler(document, raw) {
  const row = Math.min(
    Math.max(0, Number(raw && raw.line ? raw.line : 1) - 1),
    Math.max(0, (document && document.lineCount ? document.lineCount : 1) - 1)
  );
  const text = documentLineText(document, row);
  const kind = String(raw && raw.kind ? raw.kind : "");
  const name = String(raw && raw.name ? raw.name : "");
  const needles = [symbolNeedle(name, kind), name].filter(Boolean);
  let start = -1;
  let width = 1;
  for (const needle of needles) {
    start = text.indexOf(needle);
    if (start >= 0) {
      width = Math.max(needle.length, 1);
      break;
    }
  }
  if (start < 0) {
    start = Math.max(0, Math.min(Number(raw && raw.col ? raw.col : 1) - 1, text.length));
    width = Math.max(1, Math.min(String(name || "symbol").length, Math.max(1, text.length - start)));
  }
  return new vscode.Range(row, start, row, Math.min(text.length, start + width));
}

function compilerArtifactToSymbols(document, artifact) {
  if (!artifact || !Array.isArray(artifact.symbols)) {
    return null;
  }
  const symbols = [];
  for (const raw of artifact.symbols) {
    if (!raw || !raw.name) {
      continue;
    }
    const kind = compilerSymbolKind(raw.kind);
    const range = symbolRangeFromCompiler(document, raw);
    symbols.push({
      name: String(raw.name),
      kind,
      uri: document.uri,
      range,
      selectionRange: range,
      line: documentLineText(document, range.start.line).trim(),
      signature: String(raw.signature || raw.name),
      doc: String(raw.doc || ""),
      params: Array.isArray(raw.params) ? raw.params : [],
      output: raw.return ? String(raw.return) : ""
    });
  }
  return symbols;
}

async function parseCompilerArtifactForDocument(document) {
  if (!shouldUseCompilerParser(document)) {
    return null;
  }
  const ny = tools(extensionContext).ny;
  if (!ny || !ny.path) {
    return null;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nytrix-vscode-parse-"));
  const artifactPath = path.join(tempDir, "parse-artifact.json");
  let sourcePath = document.uri.fsPath;
  try {
    if (document.isDirty) {
      sourcePath = path.join(tempDir, path.basename(document.uri.fsPath || "buffer.ny"));
      fs.writeFileSync(sourcePath, document.getText(), "utf8");
    }
    const args = [
      "--color=never",
      "--stop-after=parse",
      "--emit-shapes",
      `--emit-artifact=${artifactPath}`,
      "-emit-only",
      sourcePath
    ];
    const result = await captureProcess(ny.path, args, workspaceCwd(document), {
      timeoutMs: compilerParserTimeoutMs()
    });
    if (result.code !== 0 || !fs.existsSync(artifactPath)) {
      return null;
    }
    const artifact = parseJsonText(fs.readFileSync(artifactPath, "utf8"));
    return artifact && Array.isArray(artifact.symbols) ? artifact : null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort temp cleanup */
    }
  }
}

function compilerParserEnabled() {
  return cfg().get("language.compilerParser.enabled", true);
}

function compilerParserDirtyBuffersEnabled() {
  return cfg().get("language.compilerParser.dirtyBuffers", true);
}

function compilerParserMaxDirtyBytes() {
  return Math.max(0, Number(cfg().get("language.compilerParser.maxDirtyBytes", 200000)) || 0);
}

function compilerParserTimeoutMs() {
  return Math.max(250, Number(cfg().get("language.compilerParser.timeoutMs", 2500)) || 2500);
}

function shouldUseCompilerParser(document) {
  if (!compilerParserEnabled() || !document || document.uri.scheme !== "file") {
    return false;
  }
  if (document.isDirty !== false && !compilerParserDirtyBuffersEnabled()) {
    return false;
  }
  const maxDirtyBytes = compilerParserMaxDirtyBytes();
  return document.isDirty === false || maxDirtyBytes === 0 || documentTextLength(document) <= maxDirtyBytes;
}

function shouldRevealOutput(options, phase, exitCode = 0) {
  const reveal = options.reveal || cfg().get("output.reveal", "errors");
  if (phase === "start") {
    return reveal === "always";
  }
  if (reveal === "always") {
    return true;
  }
  if (reveal === "never") {
    return false;
  }
  if (options.quietSuccess && exitCode === 0) {
    return false;
  }
  return exitCode !== 0;
}

function presentProcessFailure(label, exitCode, summary) {
  const detail = [];
  if (summary && typeof summary === "object") {
    if (summary.errors) {
      detail.push(`${summary.errors} error${summary.errors === 1 ? "" : "s"}`);
    }
    if (summary.warnings) {
      detail.push(`${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}`);
    }
  }
  const suffix = detail.length ? ` (${detail.join(", ")})` : "";
  vscode.window.showErrorMessage(
    `Nytrix: ${label} failed with exit ${exitCode}${suffix}.`,
    "Open Output"
  ).then((choice) => {
    if (choice === "Open Output") {
      showOutput(true);
    }
  });
}

function logTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatElapsedMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) {
    return `${n} ms`;
  }
  return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
}

function compactLogValue(value, max = 220) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function appendOutputFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) {
    return;
  }
  const width = Math.max(...entries.map(([key]) => key.length));
  for (const [key, value] of entries) {
    output.appendLine(`  ${key.padEnd(width)} ${compactLogValue(value)}`);
  }
}

function appendOutputSection(title, fields) {
  output.appendLine(`[${title}]`);
  appendOutputFields(fields);
}

function summarizeOutputText(text) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    lines: lines.length,
    errors: countOutputMatches(clean, /\berror\b|\bfailed\b|\bpanic\b/gi),
    warnings: countOutputMatches(clean, /\bwarning\b/gi),
    notes: countOutputMatches(clean, /\bnote\b/gi),
    hints: countOutputMatches(clean, /\bhint\b|\bfix\b/gi)
  };
}

function diagnosticSeverityFromName(name) {
  const sev = String(name || "").toLowerCase();
  if (sev === "error") {
    return vscode.DiagnosticSeverity.Error;
  }
  if (sev === "warning" || sev === "warn") {
    return vscode.DiagnosticSeverity.Warning;
  }
  if (sev === "hint") {
    return vscode.DiagnosticSeverity.Hint;
  }
  return vscode.DiagnosticSeverity.Information;
}

function fullDocumentRange(document) {
  const lastLine = Math.max(0, document.lineCount - 1);
  const endCol = document.lineCount > 0 ? document.lineAt(lastLine).text.length : 0;
  return new vscode.Range(0, 0, lastLine, endCol);
}

function countOutputMatches(text, regex) {
  const matches = String(text || "").match(regex);
  return matches ? matches.length : 0;
}

function parseDiagnosticHeader(line) {
  const match = line.match(/^(.+?):(\d+):(\d+):\s+(?:(\[[A-Z]\d+\])\s+)?(?:(warning|error|note):?\s+)?(.*)$/i);
  if (!match) {
    return null;
  }
  const code = match[4] || "";
  const marker = `${code} ${match[5] || ""}`.toLowerCase();
  const severity = marker.includes("warn")
    ? vscode.DiagnosticSeverity.Warning
    : marker.includes("note")
      ? vscode.DiagnosticSeverity.Information
      : vscode.DiagnosticSeverity.Error;
  return {
    file: match[1],
    row: Math.max(0, Number(match[2]) - 1),
    col: Math.max(0, Number(match[3]) - 1),
    severity,
    code: code || undefined,
    message: (match[6] || line).trim()
  };
}

function parseDiagnosticDetail(line) {
  const match = line.match(/^\s+(hint|fix|note):\s+(.*)$/i);
  if (!match) {
    return null;
  }
  return {
    kind: match[1].toLowerCase(),
    message: match[2].trim()
  };
}

function parseAnalyzeJson(text) {
  const parsed = parseJsonText(text);
  return parsed && Array.isArray(parsed.issues) ? parsed : null;
}

function publishDiagnostics(kind, document, text, code) {
  const collection = diagnosticCollection(kind);
  const found = [];
  const lines = stripAnsi(text).split(/\r?\n/);
  const docPath = document.uri.fsPath;
  let current = null;
  const flush = () => {
    if (current) {
      found.push(current);
      current = null;
    }
  };
  for (const line of lines) {
    const header = parseDiagnosticHeader(line);
    if (header) {
      if (header.file !== docPath && header.file !== path.basename(docPath) && !docPath.endsWith(header.file)) {
        flush();
        continue;
      }
      flush();
      const range = new vscode.Range(header.row, header.col, header.row, header.col + 1);
      current = new vscode.Diagnostic(range, header.message, header.severity);
      current.source = "nytrix";
      if (header.code) {
        current.code = header.code;
      }
      continue;
    }
    const detail = parseDiagnosticDetail(line);
    if (detail && current) {
      current.relatedInformation = current.relatedInformation || [];
      current.relatedInformation.push(new vscode.DiagnosticRelatedInformation(
        new vscode.Location(document.uri, current.range),
        `${detail.kind}: ${detail.message}`
      ));
      continue;
    }
    if (current && (/^\s*\d+\s+\|/.test(line) || /^\s*\|\s*[\^~]/.test(line) || /^\s*$/.test(line))) {
      continue;
    }
    flush();
  }
  flush();
  if (found.length === 0 && code !== 0) {
    const range = new vscode.Range(0, 0, 0, 1);
    const diagnostic = new vscode.Diagnostic(range, "Nytrix check failed. See Nytrix output.", vscode.DiagnosticSeverity.Error);
    diagnostic.source = "nytrix";
    found.push(diagnostic);
  }
  collection.set(document.uri, found);
  scheduleActiveEditorDiagnosticsRefresh(20);
}

function publishAnalyzeDiagnostics(document, jsonText, fallbackText = "", fallbackCode = 0) {
  const parsed = parseAnalyzeJson(jsonText);
  if (!parsed) {
    publishDiagnostics("advice", document, fallbackText || jsonText, fallbackCode);
    return;
  }
  const found = [];
  for (const issue of parsed.issues) {
    if (!issue || !issue.file) {
      continue;
    }
    const file = String(issue.file);
    const docPath = document.uri.fsPath;
    if (file !== docPath && file !== path.basename(docPath) && !docPath.endsWith(file)) {
      continue;
    }
    const row = Math.max(0, Number(issue.line || 1) - 1);
    const col = Math.max(0, Number(issue.col || 1) - 1);
    const range = new vscode.Range(row, col, row, col + 1);
    const diagnostic = new vscode.Diagnostic(
      range,
      String(issue.message || "Nytrix analyzer finding"),
      diagnosticSeverityFromName(issue.severity)
    );
    diagnostic.source = "nytrix-analyze";
    if (issue.code) {
      diagnostic.code = String(issue.code);
    }
    if (issue.note) {
      diagnostic.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(document.uri, range),
          `note: ${String(issue.note)}`
        )
      ];
    }
    found.push(diagnostic);
  }
  adviceDiagnostics.set(document.uri, found);
  scheduleActiveEditorDiagnosticsRefresh(20);
}

async function refreshAnalyzeDiagnostics(document, options = {}) {
  const target = await resolveNytrixDocument(document);
  const fmt = options.fmtPath
    ? { path: options.fmtPath }
    : await toolOrShow("fmt", "ny-fmt", {
      prompt: false,
      showError: !options.quiet,
      attemptInstall: bootstrapMode() === "auto",
      reason: "Analyzer hints need ny-fmt"
    });
  if (!target || !fmt || !fmt.path) {
    return null;
  }
  const cwd = workspaceCwd(target);
  const jsonResult = await captureProcess(
    fmt.path,
    ["--analyze", "--json", target.uri.fsPath],
    cwd
  );
  publishAnalyzeDiagnostics(
    target,
    jsonResult.output,
    options.fallbackOutput || "",
    options.fallbackCode != null ? options.fallbackCode : jsonResult.code
  );
  return jsonResult;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function onSaveCheck(document) {
  if (!isNytrixDocument(document)) {
    return;
  }
  if (cfg().get("check.onSave", true) && !lspReady) {
    await checkFile(document, {
      prompt: false,
      showError: false,
      attemptInstall: bootstrapMode() === "auto"
    });
  }
  if (cfg().get("analyze.onSave", true)) {
    await refreshAnalyzeDiagnostics(document, { quiet: true });
  }
  scheduleActiveEditorDiagnosticsRefresh(20);
}

async function startLsp(context) {
  lspReady = false;
  if (!cfg().get("lsp.enabled", true)) {
    setLspStatus("$(circle-slash) Ny LSP off", "Nytrix LSP disabled");
    return;
  }
  const lsp = tools(context).lsp;
  if (!lsp.path) {
    if (bootstrapMode() === "auto") {
      const installed = await installToolchain(context, {
        prompt: true,
        reason: "ny-lsp was not found during startup"
      });
      if (installed && installed.lsp && installed.lsp.path) {
        return;
      }
    }
    setLspStatus("$(cloud-download) Install Nytrix", "ny-lsp not found; click to install the Nytrix toolchain", "nytrix.installToolchain");
    output.appendLine("[lsp]");
    output.appendLine("  status  unavailable");
    output.appendLine("  detail  ny-lsp not found. Set nytrix.lsp.path, NYTRIX_LSP, or run Nytrix: Install Toolchain.");
    return;
  }
  let languageClient;
  try {
    languageClient = require("vscode-languageclient/node");
  } catch (err) {
    setLspStatus("$(warning) Ny LSP", "Install extension dependencies to enable LSP");
    output.appendLine("[lsp]");
    output.appendLine("  status  unavailable");
    output.appendLine(`  detail  vscode-languageclient is missing: ${err.message}`);
    return;
  }
  const { LanguageClient, State } = languageClient;
  const serverOptions = {
    command: lsp.path,
    args: cfg().get("lsp.arguments", []),
    options: {
      env: toolEnv()
    }
  };
  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "nytrix" }],
    outputChannel: output,
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.ny")
    }
  };
  client = new LanguageClient("nytrix", "Nytrix Language Server", serverOptions, clientOptions);
  if (State && client.onDidChangeState) {
    context.subscriptions.push(client.onDidChangeState((event) => {
      if (event.newState === State.Stopped) {
        lspReady = false;
        setLspStatus("$(warning) Ny LSP", "Language server stopped; save-time fallback diagnostics are enabled");
      }
    }));
  }
  setLspStatus("$(sync~spin) Ny LSP", `Starting ${lsp.path}`);
  output.appendLine("[lsp]");
  output.appendLine("  status  starting");
  output.appendLine(`  path    ${lsp.path}`);
  client.start().then(
    () => {
      lspReady = true;
      checkDiagnostics.clear();
      setLspStatus("$(check) Ny LSP", `${lsp.path} (${lsp.source})`);
      output.appendLine("[lsp]");
      output.appendLine("  status  ready");
      output.appendLine(`  source  ${lsp.source}`);
      scheduleActiveEditorDiagnosticsRefresh(20);
    },
    (err) => {
      lspReady = false;
      setLspStatus("$(error) Ny LSP", String(err && err.message ? err.message : err));
      output.appendLine("[lsp]");
      output.appendLine("  status  failed");
      output.appendLine(`  detail  ${compactLogValue(err && err.stack ? err.stack : err, 500)}`);
      scheduleActiveEditorDiagnosticsRefresh(20);
    }
  );
}

async function restartLsp(context) {
  if (client) {
    const old = client;
    client = null;
    lspReady = false;
    await old.stop();
  }
  cachedTools = null;
  await startLsp(context);
}

function commandLink(command, label) {
  return `[${label}](command:${command})`;
}

function statusMarkdown(lines, actions = []) {
  const md = new vscode.MarkdownString("", true);
  md.isTrusted = true;
  md.supportHtml = false;
  md.appendMarkdown(lines.join("\n\n"));
  if (actions.length) {
    md.appendMarkdown("\n\n---\n\n");
    md.appendMarkdown(actions.map(([command, label]) => commandLink(command, label)).join(" · "));
  }
  return md;
}

function setLspStatus(text, tooltip, command = "nytrix.showToolchain") {
  if (!lspStatus) {
    return;
  }
  lspStatus.text = text;
  lspStatus.tooltip = statusMarkdown([
    "**Nytrix Language Server**",
    tooltip
  ], [
    [command, command === "nytrix.installToolchain" ? "Install toolchain" : "Show toolchain"],
    ["nytrix.restartLsp", "Restart LSP"],
    ["nytrix.openSettings", "Settings"]
  ]);
  lspStatus.command = command;
  lspStatus.show();
}

function updateStatus() {
  const editor = activeNytrixEditor();
  if (!runStatus) {
    return;
  }
  if (!editor) {
    runStatus.hide();
    return;
  }
  const t = tools();
  const modeMeta = runModeMeta();
  const revealMeta = outputRevealMeta();
  runStatus.text = modeMeta.statusText;
  runStatus.tooltip = statusMarkdown([
    "**Nytrix**",
    `Run mode: **${modeMeta.label}**  \nOutput reveal: **${revealMeta.label}**`,
    `Compiler: \`${t.ny.path || "not found"}\` (${t.ny.source})  \nLSP: \`${t.lsp.path || "not found"}\` (${t.lsp.source})`,
    `Bootstrap: **${bootstrapMode()}** at \`${bootstrapRoot()}\``
  ], [
    ["nytrix.showActions", "Actions"],
    ["nytrix.searchDocs", "Docs"],
    ["nytrix.showToolchain", "Toolchain"],
    ["nytrix.openSettings", "Settings"]
  ]);
  runStatus.show();
}

async function showToolchain() {
  cachedTools = null;
  const t = tools();
  output.clear();
  output.appendLine("== Nytrix Toolchain ==");
  appendOutputSection("bootstrap", {
    mode: bootstrapMode(),
    repo: bootstrapRepo(),
    ref: bootstrapRef(),
    root: bootstrapRoot(),
    install: "Nytrix: Install Toolchain"
  });
  output.appendLine("");
  appendOutputSection("core", {
    ny: `${t.ny.path || "not found"} (${t.ny.source})`,
    lsp: `${t.lsp.path || "not found"} (${t.lsp.source})`
  });
  const internalAdapter = path.join(extensionContext.extensionPath, "src", "nytrixDebugAdapter.js");
  const dapMode = cfg().get("debugAdapter.useInternal", true)
    ? `built-in (${internalAdapter})`
    : `${t.dap.path || "not found"} (${t.dap.source})`;
  output.appendLine("");
  appendOutputSection("debug", {
    dap: dapMode,
    gdb: expandVars(cfg().get("debug.gdbPath", "")) || findOnPath("gdb") || "not found",
    node: findNodeRuntime() || "not found"
  });
  output.appendLine("");
  appendOutputSection("tools", {
    fmt: `${t.fmt.path || "not found"} (${t.fmt.source})`,
    doc: `${t.doc.path || "not found"} (${t.doc.source})`,
    test: `${t.test.path || "not found"} (${t.test.source})`,
    perf: `${t.perf.path || "not found"} (${t.perf.source})`
  });
  output.show(true);
  vscode.window.setStatusBarMessage("Nytrix: toolchain written to Output", 2500);
}

class NytrixCodeLensProvider {
  provideCodeLenses(document) {
    if (!cfg().get("codeLens.enabled", true)) {
      return [];
    }
    const range = new vscode.Range(0, 0, 0, 0);
    const diagnostics = vscode.languages.getDiagnostics(document.uri).filter((diagnostic) => isNytrixDiagnosticSource(diagnostic));
    const counts = summarizeDiagnosticCounts(diagnostics);
    const lenses = [
      new vscode.CodeLens(range, { title: "Run", command: "nytrix.runFile" }),
      new vscode.CodeLens(range, { title: "Check", command: "nytrix.checkFile" }),
      new vscode.CodeLens(range, { title: "Expand", command: "nytrix.expandFile" }),
      new vscode.CodeLens(range, { title: "REPL", command: "nytrix.sendSelectionToRepl" }),
      new vscode.CodeLens(range, { title: "Debug", command: "nytrix.debugFile" })
    ];
    if (counts.total) {
      lenses.unshift(new vscode.CodeLens(range, {
        title: `Problems: ${formatDiagnosticCountsLabel(counts)}`,
        command: "workbench.actions.view.problems"
      }));
    }
    if (counts.fixable) {
      lenses.unshift(new vscode.CodeLens(range, {
        title: `Fixable: ${counts.fixable} issue${counts.fixable === 1 ? "" : "s"}`,
        command: "nytrix.formatFile"
      }));
    }
    return lenses;
  }
}

function diagnosticCodeString(diagnostic) {
  if (!diagnostic || diagnostic.code == null) {
    return "";
  }
  if (typeof diagnostic.code === "string") {
    return diagnostic.code;
  }
  if (typeof diagnostic.code === "object" && diagnostic.code.value) {
    return String(diagnostic.code.value);
  }
  return String(diagnostic.code);
}

function isImportStyleDiagnostic(code) {
  return code === "NYFMT1300" || code === "NYFMT1301" || code === "NYSYN1001" || code === "NYSYN1002";
}

function isFormatDiagnostic(code) {
  return isImportStyleDiagnostic(code) || code === "NYFMT1100" || code === "NYFMT1101";
}

function isOptimizationDiagnostic(code) {
  return code.startsWith("NYAUD") || code === "NYFMT2001" || code === "NYFMT3100";
}

function makeCommandAction(title, kind, command, document, diagnosticsForAction, preferred = false) {
  const action = new vscode.CodeAction(title, kind);
  action.command = {
    title,
    command,
    arguments: [document.uri]
  };
  if (diagnosticsForAction && diagnosticsForAction.length) {
    action.diagnostics = diagnosticsForAction;
  }
  action.isPreferred = preferred;
  return action;
}

function buildDocStubEdit(document, diagnostic) {
  const line = diagnostic.range.start.line;
  const text = document.lineAt(line).text;
  const match = text.match(/^(\s*)fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (!match) {
    return null;
  }
  const indent = match[1] || "";
  const name = match[2] || "function";
  const bodyIndent = `${indent}   `;
  const insertAtNextLine = line + 1 < document.lineCount;
  const position = insertAtNextLine
    ? new vscode.Position(line + 1, 0)
    : new vscode.Position(line, text.length);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(
    document.uri,
    position,
    `${insertAtNextLine ? "" : "\n"}${bodyIndent}"Describe ${name}."\n`
  );
  return edit;
}

class NytrixCodeActionProvider {
  provideCodeActions(document, range, context) {
    if (!isNytrixDocument(document)) {
      return [];
    }
    const actions = [];
    const seen = new Set();
    const addAction = (action) => {
      if (!action) {
        return;
      }
      const key = `${action.kind ? action.kind.value : ""}|${action.title}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      actions.push(action);
    };
    for (const diagnostic of context.diagnostics || []) {
      const code = diagnosticCodeString(diagnostic);
      if (isFormatDiagnostic(code)) {
        addAction(makeCommandAction(
          isImportStyleDiagnostic(code) ? "Normalize imports with ny-fmt" : "Format file with ny-fmt",
          vscode.CodeActionKind.QuickFix,
          "nytrix.formatFile",
          document,
          [diagnostic],
          true
        ));
      }
      if (code === "NYFMT2000") {
        const docEdit = buildDocStubEdit(document, diagnostic);
        if (docEdit) {
          const action = new vscode.CodeAction("Insert doc string stub", vscode.CodeActionKind.QuickFix);
          action.edit = docEdit;
          action.diagnostics = [diagnostic];
          action.isPreferred = true;
          addAction(action);
        }
      }
      if (isOptimizationDiagnostic(code)) {
        addAction(makeCommandAction(
          "Apply ny-fmt optimizations",
          vscode.CodeActionKind.QuickFix,
          "nytrix.optimizeFile",
          document,
          [diagnostic]
        ));
        addAction(makeCommandAction(
          "Re-run Nytrix analyze",
          vscode.CodeActionKind.QuickFix,
          "nytrix.analyzeFile",
          document,
          [diagnostic]
        ));
      }
      if (code.startsWith("NYFMT") || code.startsWith("NYSYN") || code.startsWith("NYAUD")) {
        addAction(makeCommandAction(
          "Show Nytrix output",
          vscode.CodeActionKind.QuickFix,
          "nytrix.showOutput",
          document,
          [diagnostic]
        ));
      }
    }
    addAction(makeCommandAction(
      "Fix all Nytrix style with ny-fmt",
      vscode.CodeActionKind.SourceFixAll,
      "nytrix.formatFile",
      document
    ));
    addAction(makeCommandAction(
      "Organize Nytrix imports",
      vscode.CodeActionKind.SourceOrganizeImports,
      "nytrix.formatFile",
      document
    ));
    addAction(makeCommandAction(
      "Analyze current Nytrix file",
      vscode.CodeActionKind.Source.append("analyze"),
      "nytrix.analyzeFile",
      document
    ));
    addAction(makeCommandAction(
      "Apply Nytrix optimizations",
      vscode.CodeActionKind.Source.append("optimize"),
      "nytrix.optimizeFile",
      document
    ));
    addAction(makeCommandAction(
      "Check current Nytrix file",
      vscode.CodeActionKind.Source.append("check"),
      "nytrix.checkFile",
      document
    ));
    return actions;
  }
}

async function formatDocumentText(document) {
  const fmt = await toolOrShow("fmt", "ny-fmt", {
    prompt: false,
    showError: false,
    attemptInstall: bootstrapMode() === "auto",
    reason: "Formatting needs ny-fmt"
  });
  if (!fmt || !fmt.path) {
    return null;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nytrix-vscode-fmt-"));
  const tempFile = path.join(tempDir, path.basename(document.uri.fsPath || "buffer.ny"));
  try {
    fs.writeFileSync(tempFile, document.getText(), "utf8");
    const result = await captureProcess(fmt.path, ["--fix", tempFile], workspaceCwd(document));
    if (result.code !== 0) {
      if (output) {
        output.appendLine("[format]");
        output.appendLine(`  status  failed`);
        output.appendLine(`  command ${commandLine(fmt.path, ["--fix", tempFile])}`);
        if (result.output.trim()) {
          output.appendLine(result.output.trimEnd());
        }
      }
      if (vscode.window && typeof vscode.window.showWarningMessage === "function") {
        vscode.window.showWarningMessage("Nytrix format request failed.", "Open Output").then((choice) => {
          if (choice === "Open Output") {
            showOutput(true);
          }
        });
      }
      return null;
    }
    return fs.readFileSync(tempFile, "utf8");
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort temp cleanup */
    }
  }
}

class NytrixDocumentFormattingProvider {
  async provideDocumentFormattingEdits(document) {
    const formatted = await formatDocumentText(document);
    if (typeof formatted !== "string" || formatted === document.getText()) {
      return [];
    }
    return [vscode.TextEdit.replace(fullDocumentRange(document), formatted)];
  }
}

const NYTRIX_KEYWORDS = [
  "module", "use", "as", "fn", "def", "mut", "return", "if", "elif", "else",
  "while", "for", "in", "break", "continue", "true", "false", "nil", "layout",
  "struct", "enum", "type", "impl", "operator", "comptime", "expand", "extern",
  "defer", "with", "match", "case", "try", "catch", "throw", "and", "or", "not"
];

const NYTRIX_BUILTINS = [
  "print", "assert", "len", "get", "set_idx", "append", "dict", "dict_get",
  "dict_set", "list", "str", "int", "float", "bool", "is_list", "is_dict",
  "is_int", "is_float", "is_str", "malloc", "free", "memcpy", "memset",
  "load8", "load16", "load32", "load64", "store8", "store16", "store32",
  "store64", "env", "__main"
];

function symbolKind(kind) {
  switch (kind) {
    case "module": return vscode.SymbolKind.Module;
    case "layout": return vscode.SymbolKind.Struct;
    case "struct": return vscode.SymbolKind.Struct;
    case "enum": return vscode.SymbolKind.Enum;
    case "type": return vscode.SymbolKind.TypeParameter;
    case "operator": return vscode.SymbolKind.Operator;
    case "def": return vscode.SymbolKind.Constant;
    case "mut": return vscode.SymbolKind.Variable;
    default: return vscode.SymbolKind.Function;
  }
}

function completionKind(kind) {
  switch (kind) {
    case "module": return vscode.CompletionItemKind.Module;
    case "layout":
    case "struct": return vscode.CompletionItemKind.Struct;
    case "enum": return vscode.CompletionItemKind.Enum;
    case "type": return vscode.CompletionItemKind.TypeParameter;
    case "def": return vscode.CompletionItemKind.Constant;
    case "mut": return vscode.CompletionItemKind.Variable;
    default: return vscode.CompletionItemKind.Function;
  }
}

function semanticTokenType(kind) {
  switch (kind) {
    case "module": return "namespace";
    case "layout":
    case "struct": return "class";
    case "enum": return "enum";
    case "type": return "type";
    case "operator": return "operator";
    case "def": return "property";
    case "mut": return "variable";
    default: return "function";
  }
}

function kindLabel(kind) {
  switch (kind) {
    case "module": return "Module";
    case "layout": return "Layout";
    case "struct": return "Struct";
    case "enum": return "Enum";
    case "type": return "Type";
    case "operator": return "Operator";
    case "def": return "Constant";
    case "mut": return "Variable";
    default: return "Function";
  }
}

function parseSignatureParts(signature) {
  const text = String(signature || "").trim();
  const match = text.match(/^fn\s+([^\s(]+)\s*\((.*)\)\s*(?::\s*(.+))?$/);
  if (!match) {
    return null;
  }
  const paramsText = match[2].trim();
  return {
    name: match[1].trim(),
    paramsText,
    params: paramsText ? paramsText.split(",").map((p) => p.trim()).filter(Boolean) : [],
    output: (match[3] || "").trim()
  };
}

function symbolPreviewMarkdown(symbol) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.appendCodeblock(symbol.signature || symbol.line || symbol.name || "", "ny");
  const details = [`- **Kind**: ${kindLabel(symbol.kind)}`];
  const sig = parseSignatureParts(symbol.signature || symbol.line);
  if (sig) {
    details.push(`- **Inputs**: ${sig.params.length ? sig.params.map((p) => `\`${p}\``).join(", ") : "_none_"}`);
    details.push(`- **Output**: ${sig.output ? `\`${sig.output}\`` : "_inferred_"}`);
  }
  if (symbol.uri && symbol.uri.fsPath && symbol.range) {
    details.push(`- **Source**: \`${path.basename(symbol.uri.fsPath)}:${symbol.range.start.line + 1}\``);
  }
  md.appendMarkdown(`\n\n${details.join("\n")}`);
  if (symbol.doc) {
    md.appendMarkdown(`\n\n${symbol.doc}`);
  }
  return md;
}

function wordAt(document, position) {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_.]*/);
  if (!range) {
    return { word: "", range: null };
  }
  return { word: document.getText(range), range };
}

function resolveBoolOption(configValue, settingValue, fallback = false) {
  if (typeof configValue === "boolean") {
    return configValue;
  }
  if (typeof settingValue === "boolean") {
    return settingValue;
  }
  return fallback;
}

function configArray(value, fallback = []) {
  return Array.isArray(value) ? value : (Array.isArray(fallback) ? fallback : []);
}

function hasDwarfVersionArg(args) {
  return configArray(args).some((arg) => arg === "--dwarf-version" || String(arg).startsWith("--dwarf-version="));
}

function withDwarfVersion(args, version) {
  const out = [...configArray(args)];
  const n = Number(version || 0);
  if (Number.isFinite(n) && n > 0 && !hasDwarfVersionArg(out)) {
    out.push(`--dwarf-version=${Math.trunc(n)}`);
  }
  return out;
}

function runtimeSuitePath() {
  return expandVars(cfg().get("test.runtimeSuitePath", "etc/tests/rt")) || "etc/tests/rt";
}

function resolveNytrixDebugConfig(folder, config = {}, document = null) {
  const editor = activeNytrixEditor();
  const request = config.request || "launch";
  const targetDoc = document || (editor && editor.document) || null;
  const program = config.program || (request === "launch" && targetDoc && targetDoc.uri && targetDoc.uri.fsPath) || (request === "launch" ? "${file}" : "");
  const cwd = config.cwd || (targetDoc ? workspaceCwd(targetDoc) : "") || (folder && folder.uri && folder.uri.fsPath) || "${workspaceFolder}";
  const compilerArgs = withDwarfVersion(
    configArray(config.compilerArgs, cfg().get("debug.compilerArguments", [])),
    config.dwarfVersion !== undefined ? config.dwarfVersion : cfg().get("debug.dwarfVersion", 0)
  );
  return {
    ...config,
    type: "nytrix",
    request,
    name: config.name || (request === "attach" ? "Nytrix: Attach" : "Nytrix: Launch"),
    program,
    processId: config.processId || config.pid,
    args: configArray(config.args, []),
    cwd,
    stopOnEntry: config.stopOnEntry === true,
    trace: resolveBoolOption(config.trace, false, false),
    env: config.env || {},
    sourceFileMap: config.sourceFileMap || cfg().get("debug.sourceFileMap", {}),
    dapPath: config.dapPath || cfg().get("debugAdapter.path", ""),
    dapArgs: configArray(config.dapArgs, cfg().get("debugAdapter.arguments", [])),
    nyPath: config.nyPath || tools().ny.path,
    gdbPath: config.gdbPath || expandVars(cfg().get("debug.gdbPath", "")) || findOnPath("gdb"),
    compilerArgs,
    dwarfVersion: config.dwarfVersion !== undefined ? config.dwarfVersion : cfg().get("debug.dwarfVersion", 0),
    debugLocals: resolveBoolOption(config.debugLocals, cfg().get("debug.debugLocals", false), false),
    justMyCode: resolveBoolOption(config.justMyCode, cfg().get("debug.justMyCode", true), true),
    traceRuntime: resolveBoolOption(config.traceRuntime, cfg().get("debug.traceRuntime", false), false),
    traceValues: resolveBoolOption(config.traceValues, cfg().get("debug.traceValues", false), false),
    traceVerbose: resolveBoolOption(config.traceVerbose, cfg().get("debug.traceVerbose", false), false),
    traceFilter: config.traceFilter || cfg().get("debug.traceFilter", ""),
    outputDir: config.outputDir || cfg().get("debug.outputDir", "")
  };
}

function fuzzySymbolScore(query, symbol, currentUri = "") {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return 1000;
  }
  const name = String(symbol.name || "").toLowerCase();
  const short = name.includes(".") ? name.split(".").pop() : name;
  let score = 100000;
  if (name === q || short === q) {
    score = 0;
  } else if (name.startsWith(q) || short.startsWith(q)) {
    score = 50;
  } else if (name.includes(q) || short.includes(q)) {
    score = 200;
  } else {
    let pos = 0;
    for (const ch of q) {
      pos = name.indexOf(ch, pos);
      if (pos < 0) {
        return score;
      }
      pos += 1;
    }
    score = 500 + name.length;
  }
  if (symbol.uri && symbol.uri.toString && symbol.uri.toString() === currentUri) {
    score -= 20;
  }
  if (symbol.kind === "fn") {
    score -= 10;
  }
  return score;
}

async function findDefinitionByName(index = workspaceSymbolIndex) {
  if (!index) {
    vscode.window.showWarningMessage("Nytrix symbol index is not ready yet.");
    return;
  }
  const editor = activeNytrixEditor();
  const currentUri = editor && editor.document && editor.document.uri ? editor.document.uri.toString() : "";
  const seed = editor ? wordAt(editor.document, editor.selection.active).word : "";
  const query = await vscode.window.showInputBox({
    title: "Nytrix: Find Definition by Name",
    prompt: "Type a function, module, constant, or symbol name.",
    placeHolder: "clamp",
    value: seed || ""
  });
  if (query === undefined) {
    return;
  }
  if (editor && editor.document) {
    await index.ensureDocument(editor.document);
  }
  const symbols = await index.searchSymbols(query, currentUri);
  if (!symbols.length) {
    vscode.window.showInformationMessage(`No Nytrix definition found for '${query}'.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(symbols.slice(0, 80).map((symbol) => ({
    label: symbol.name,
    description: `${kindLabel(symbol.kind)} - ${path.basename(symbol.uri.fsPath)}:${symbol.range.start.line + 1}`,
    detail: symbol.signature || symbol.line || "",
    symbol
  })), {
    placeHolder: `Nytrix definition: ${query}`,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked || !picked.symbol) {
    return;
  }
  await vscode.window.showTextDocument(picked.symbol.uri, {
    selection: picked.symbol.selectionRange,
    preview: false
  });
}

class NytrixSymbolIndex {
  constructor() {
    this.docs = new Map();
    this.compilerPending = new Map();
    this.compilerFacts = {
      types: new Set(),
      typeGroups: new Set()
    };
    this.workspaceReady = false;
    this.watcher = vscode.workspace && typeof vscode.workspace.createFileSystemWatcher === "function"
      ? vscode.workspace.createFileSystemWatcher("**/*.ny")
      : null;
    if (this.watcher) {
      this.watcher.onDidCreate((uri) => this.updateUri(uri));
      this.watcher.onDidChange((uri) => this.updateUri(uri));
      this.watcher.onDidDelete((uri) => this.deleteUri(uri));
    }
  }

  dispose() {
    if (this.watcher && typeof this.watcher.dispose === "function") {
      this.watcher.dispose();
    }
  }

  async ensureWorkspace() {
    if (this.workspaceReady) {
      return;
    }
    this.workspaceReady = true;
    const files = await vscode.workspace.findFiles(
      "**/*.ny",
      "{.git,build,node_modules,tmp,etc/assets,third_party}/**",
      600
    );
    await Promise.all(files.map(async (uri) => {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        this.updateDocument(document);
        this.refreshCompilerSymbols(document);
      } catch {}
    }));
  }

  updateDocument(document) {
    if (!isNytrixDocument(document) || document.uri.scheme !== "file") {
      return;
    }
    const symbols = this.parseLocalSymbols(document);
    this.docs.set(document.uri.toString(), {
      uri: document.uri,
      symbols,
      text: document.getText(),
      source: "local",
      stamp: documentStamp(document)
    });
  }

  parseLocalSymbols(document) {
    const symbols = [];
    const lines = document.getText().split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const patterns = [
        ["module", /^\s*module\s+([A-Za-z_][A-Za-z0-9_.]*)/],
        ["fn", /^\s*(?:@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?\s*)*fn\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(([^)]*)\)\s*(?::\s*([A-Za-z_?*][A-Za-z0-9_?*.]*))?/],
        ["layout", /^\s*layout\s+([A-Za-z_][A-Za-z0-9_]*)/],
        ["struct", /^\s*struct\s+([A-Za-z_][A-Za-z0-9_]*)/],
        ["enum", /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)/],
        ["type", /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)/],
        ["operator", /^\s*operator\s+(.+?)\s*(?::|=)/],
        ["def", /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/],
        ["mut", /^\s*mut\s+([A-Za-z_][A-Za-z0-9_]*)/]
      ];
      for (const [kind, regex] of patterns) {
        const match = line.match(regex);
        if (!match) {
          continue;
        }
        const name = kind === "operator" ? `operator ${match[1].trim()}` : match[1];
        const start = Math.max(0, line.indexOf(match[1]));
        const range = new vscode.Range(i, start, i, Math.max(start + match[1].length, line.length));
        const doc = this.nearbyDoc(lines, i);
        const signature = kind === "fn"
          ? `fn ${name}(${match[2] || ""})${match[3] ? `: ${match[3]}` : ""}`
          : line.trim();
        symbols.push({ name, kind, uri: document.uri, range, selectionRange: range, line: line.trim(), signature, doc });
        break;
      }
    }
    return symbols;
  }

  async refreshCompilerSymbols(document) {
    if (!isNytrixDocument(document) || !shouldUseCompilerParser(document)) {
      return null;
    }
    const key = document.uri.toString();
    const stamp = documentStamp(document);
    const current = this.docs.get(key);
    if (current && current.source === "compiler" && current.stamp === stamp) {
      return current.symbols;
    }
    const pendingKey = `${key}:${stamp}`;
    if (this.compilerPending.has(pendingKey)) {
      return this.compilerPending.get(pendingKey);
    }
    const pending = (async () => {
      const artifact = await parseCompilerArtifactForDocument(document);
      const symbols = compilerArtifactToSymbols(document, artifact);
      if (symbols) {
        this.updateCompilerFacts(artifact);
        this.docs.set(key, {
          uri: document.uri,
          symbols,
          text: document.getText(),
          source: "compiler",
          stamp
        });
        return symbols;
      }
      return current ? current.symbols : null;
    })().finally(() => {
      this.compilerPending.delete(pendingKey);
    });
    this.compilerPending.set(pendingKey, pending);
    return pending;
  }

  updateCompilerFacts(artifact) {
    if (!artifact || !artifact.type_groups || typeof artifact.type_groups !== "object") {
      return;
    }
    for (const [group, names] of Object.entries(artifact.type_groups)) {
      this.compilerFacts.typeGroups.add(group);
      if (Array.isArray(names)) {
        for (const name of names) {
          this.compilerFacts.types.add(String(name));
        }
      }
    }
  }

  compilerCompletionNames() {
    return {
      types: [...this.compilerFacts.types].sort(),
      typeGroups: [...this.compilerFacts.typeGroups].sort()
    };
  }

  async ensureDocument(document) {
    if (!isNytrixDocument(document) || document.uri.scheme !== "file") {
      return [];
    }
    const key = document.uri.toString();
    const stamp = documentStamp(document);
    const current = this.docs.get(key);
    if (!current || current.stamp !== stamp) {
      this.updateDocument(document);
    }
    if (shouldUseCompilerParser(document)) {
      await this.refreshCompilerSymbols(document);
    }
    return (this.docs.get(key) || { symbols: [] }).symbols;
  }

  async updateUri(uri) {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      this.updateDocument(document);
      await this.refreshCompilerSymbols(document);
    } catch {}
  }

  deleteUri(uri) {
    if (uri && uri.toString) {
      this.docs.delete(uri.toString());
    }
  }

  nearbyDoc(lines, defLine) {
    for (let i = defLine + 1; i < Math.min(lines.length, defLine + 4); i++) {
      const match = lines[i].trim().match(/^"([^"]+)"/);
      if (match) {
        return match[1];
      }
      if (lines[i].trim() && !lines[i].trim().startsWith(";;")) {
        break;
      }
    }
    const comments = [];
    for (let i = defLine - 1; i >= 0; i--) {
      const text = lines[i].trim();
      if (!text) {
        if (comments.length) {
          break;
        }
        continue;
      }
      const match = text.match(/^;;\s?(.*)$/);
      if (!match) {
        break;
      }
      comments.push(match[1]);
    }
    if (comments.length) {
      return comments.reverse().join("\n");
    }
    return "";
  }

  documentSymbols(document) {
    return (this.docs.get(document.uri.toString()) || { symbols: [] }).symbols;
  }

  async allSymbols() {
    await this.ensureWorkspace();
    const out = [];
    for (const entry of this.docs.values()) {
      out.push(...entry.symbols);
    }
    return out;
  }

  async findDefinitions(name, currentUri) {
    await this.ensureWorkspace();
    const short = name.includes(".") ? name.split(".").pop() : name;
    const current = currentUri ? currentUri.toString() : "";
    return (await this.allSymbols())
      .filter((s) => s.name === name || s.name === short || s.name.endsWith(`.${short}`))
      .sort((a, b) => {
        const ac = a.uri.toString() === current ? 0 : 1;
        const bc = b.uri.toString() === current ? 0 : 1;
        if (ac !== bc) {
          return ac - bc;
        }
        const ae = a.name === name ? 0 : 1;
        const be = b.name === name ? 0 : 1;
        if (ae !== be) {
          return ae - be;
        }
        const af = a.kind === "fn" ? 0 : 1;
        const bf = b.kind === "fn" ? 0 : 1;
        if (af !== bf) {
          return af - bf;
        }
        return a.range.start.line - b.range.start.line;
      });
  }

  async searchSymbols(query, currentUri) {
    await this.ensureWorkspace();
    const q = String(query || "").trim();
    const currentKey = String(currentUri || "");
    if (currentKey && this.docs.has(currentKey)) {
      const current = this.docs.get(currentKey);
      const rest = [];
      for (const [key, entry] of this.docs.entries()) {
        if (key !== currentKey) {
          rest.push(entry);
        }
      }
      const scored = [...current.symbols, ...rest.flatMap((entry) => entry.symbols)]
        .map((symbol) => ({ symbol, score: fuzzySymbolScore(q, symbol, currentKey) }))
        .filter((entry) => entry.score < 100000)
        .sort((a, b) => a.score - b.score || a.symbol.name.localeCompare(b.symbol.name));
      return scored.map((entry) => entry.symbol);
    }
    return (await this.allSymbols())
      .map((symbol) => ({ symbol, score: fuzzySymbolScore(q, symbol, currentKey) }))
      .filter((entry) => entry.score < 100000)
      .sort((a, b) => a.score - b.score || a.symbol.name.localeCompare(b.symbol.name))
      .map((entry) => entry.symbol);
  }

  async findReferences(name) {
    await this.ensureWorkspace();
    const out = [];
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");
    for (const entry of this.docs.values()) {
      const lines = entry.text.split(/\r?\n/);
      for (let row = 0; row < lines.length; row++) {
        let match;
        while ((match = regex.exec(lines[row]))) {
          out.push(new vscode.Location(entry.uri, new vscode.Range(row, match.index, row, match.index + name.length)));
        }
      }
    }
    return out;
  }
}

class NytrixDefinitionProvider {
  constructor(index) { this.index = index; }
  async provideDefinition(document, position) {
    if (lspOwnsLanguageFeatures()) {
      return null;
    }
    await this.index.ensureDocument(document);
    const { word } = wordAt(document, position);
    if (!word) {
      return null;
    }
    const defs = await this.index.findDefinitions(word, document.uri);
    if (!defs || defs.length === 0) {
      return null;
    }
    return defs.map((s) => new vscode.Location(s.uri, s.selectionRange));
  }
}

class NytrixReferenceProvider {
  constructor(index) { this.index = index; }
  async provideReferences(document, position) {
    if (lspOwnsLanguageFeatures()) {
      return null;
    }
    await this.index.ensureDocument(document);
    const { word } = wordAt(document, position);
    return word ? this.index.findReferences(word) : [];
  }
}

class NytrixHoverProvider {
  constructor(index) { this.index = index; }
  async provideHover(document, position) {
    if (lspOwnsLanguageFeatures()) {
      return null;
    }
    await this.index.ensureDocument(document);
    const { word, range } = wordAt(document, position);
    if (!word) {
      return null;
    }
    const defs = await this.index.findDefinitions(word, document.uri);
    if (defs.length === 0) {
      return null;
    }
    return new vscode.Hover(symbolPreviewMarkdown(defs[0]), range);
  }
}

class NytrixDocumentSymbolProvider {
  constructor(index) { this.index = index; }
  async provideDocumentSymbols(document) {
    if (lspOwnsLanguageFeatures()) {
      return null;
    }
    const symbols = await this.index.ensureDocument(document);
    return symbols.map((s) => new vscode.DocumentSymbol(
      s.name,
      s.signature,
      symbolKind(s.kind),
      s.range,
      s.selectionRange
    ));
  }
}

class NytrixSemanticTokensProvider {
  constructor(index) { this.index = index; }
  async provideDocumentSemanticTokens(document) {
    if (lspOwnsLanguageFeatures()) {
      return null;
    }
    const symbols = await this.index.ensureDocument(document);
    const builder = new vscode.SemanticTokensBuilder();
    for (const symbol of symbols) {
      const range = symbol.selectionRange || symbol.range;
      if (!range || range.start.line !== range.end.line) {
        continue;
      }
      const length = Math.max(1, range.end.character - range.start.character);
      const tokenType = semanticTokenType(symbol.kind);
      const tokenIndex = SEMANTIC_TOKEN_TYPES.indexOf(tokenType);
      if (tokenIndex >= 0) {
        builder.push(range.start.line, range.start.character, length, tokenIndex, 0);
      }
    }
    return builder.build();
  }
}

class NytrixWorkspaceSymbolProvider {
  constructor(index) { this.index = index; }
  async provideWorkspaceSymbols(query) {
    if (lspOwnsLanguageFeatures()) {
      return null;
    }
    const q = (query || "").toLowerCase();
    return (await this.index.allSymbols())
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .slice(0, 400)
      .map((s) => new vscode.SymbolInformation(s.name, symbolKind(s.kind), s.signature, new vscode.Location(s.uri, s.selectionRange)));
  }
}

class NytrixCompletionProvider {
  constructor(index) { this.index = index; }
  async provideCompletionItems(document) {
    if (lspOwnsLanguageFeatures()) {
      return null;
    }
    await this.index.ensureDocument(document);
    const items = [];
    for (const kw of NYTRIX_KEYWORDS) {
      items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
    }
    for (const bi of NYTRIX_BUILTINS) {
      items.push(new vscode.CompletionItem(bi, vscode.CompletionItemKind.Function));
    }
    const compilerNames = this.index.compilerCompletionNames();
    for (const name of compilerNames.types) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.TypeParameter);
      item.detail = "compiler type";
      items.push(item);
    }
    for (const name of compilerNames.typeGroups) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.TypeParameter);
      item.detail = "compiler type group";
      items.push(item);
    }
    for (const s of await this.index.allSymbols()) {
      const item = new vscode.CompletionItem(s.name, completionKind(s.kind));
      item.detail = s.signature;
      item.documentation = symbolPreviewMarkdown(s);
      items.push(item);
    }
    return items;
  }
}

class NytrixSignatureProvider {
  constructor(index) { this.index = index; }
  async provideSignatureHelp(document, position) {
    if (lspOwnsLanguageFeatures()) {
      return null;
    }
    await this.index.ensureDocument(document);
    const line = document.lineAt(position.line).text.slice(0, position.character);
    const match = line.match(/([A-Za-z_][A-Za-z0-9_.]*)\s*\([^()]*$/);
    if (!match) {
      return null;
    }
    const defs = await this.index.findDefinitions(match[1], document.uri);
    const fn = defs.find((s) => s.kind === "fn") || defs[0];
    if (!fn) {
      return null;
    }
    const help = new vscode.SignatureHelp();
    const sig = new vscode.SignatureInformation(fn.signature, fn.doc || "");
    const params = (fn.signature.match(/\((.*)\)/) || ["", ""])[1]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    sig.parameters = params.map((p) => new vscode.ParameterInformation(p));
    help.signatures = [sig];
    help.activeSignature = 0;
    help.activeParameter = Math.max(0, (line.match(/,/g) || []).length);
    return help;
  }
}

class NytrixDebugConfigurationProvider {
  async resolveDebugConfiguration(folder, config) {
    const editor = activeNytrixEditor();
    const request = config.request || "launch";
    if (request === "launch" && !(config.nyPath || tools().ny.path)) {
      const ny = await nyOrShow({ reason: "Debug launch needs the Nytrix compiler" });
      if (!ny) {
        return undefined;
      }
    }
    return resolveNytrixDebugConfig(folder, config, editor && editor.document);
  }

  provideDebugConfigurations(folder) {
    const program = "${file}";
    return [
      {
        type: "nytrix",
        request: "launch",
        name: "Nytrix: Debug Current File",
        program,
        cwd: folder ? folder.uri.fsPath : "${workspaceFolder}",
        args: [],
        stopOnEntry: false,
        trace: false,
        traceRuntime: cfg().get("debug.traceRuntime", false),
        traceValues: cfg().get("debug.traceValues", false),
        traceVerbose: cfg().get("debug.traceVerbose", false),
        traceFilter: cfg().get("debug.traceFilter", ""),
        debugLocals: cfg().get("debug.debugLocals", false),
        justMyCode: cfg().get("debug.justMyCode", true),
        compilerArgs: withDwarfVersion([], cfg().get("debug.dwarfVersion", 0)),
        dwarfVersion: cfg().get("debug.dwarfVersion", 0),
        sourceFileMap: cfg().get("debug.sourceFileMap", {}),
        gdbPath: expandVars(cfg().get("debug.gdbPath", "")) || findOnPath("gdb"),
        nyPath: tools().ny.path
      },
      {
        type: "nytrix",
        request: "attach",
        name: "Nytrix: Attach to Process",
        processId: "${command:nytrix.pickProcess}",
        cwd: folder ? folder.uri.fsPath : "${workspaceFolder}",
        stopOnEntry: true,
        trace: false,
        sourceFileMap: cfg().get("debug.sourceFileMap", {}),
        gdbPath: expandVars(cfg().get("debug.gdbPath", "")) || findOnPath("gdb")
      }
    ];
  }
}

class NytrixDebugAdapterFactory {
  createDebugAdapterDescriptor(session) {
    if (cfg().get("debugAdapter.useInternal", true)) {
      const node = findNodeRuntime();
      const adapter = path.join(extensionContext.extensionPath, "src", "nytrixDebugAdapter.js");
      if (!fs.existsSync(adapter)) {
        vscode.window.showErrorMessage(`Nytrix built-in debug adapter is missing: ${adapter}`);
        return undefined;
      }
      if (!node) {
        vscode.window.showErrorMessage("Nytrix debug adapter needs node or VS Code's Electron runtime.");
        return undefined;
      }
      return new vscode.DebugAdapterExecutable(node, [adapter], {
        cwd: expandVars(session.configuration.cwd || findRepoRoot()),
        env: {
          ...toolEnv(),
          ELECTRON_RUN_AS_NODE: "1"
        }
      });
    }
    const cfgPath = expandVars(session.configuration.dapPath || cfg().get("debugAdapter.path", ""));
    const dap = cfgPath && isRunnable(cfgPath) ? { path: cfgPath, source: "launch/settings" } : { path: "", source: "not found" };
    if (!dap.path) {
      vscode.window.showErrorMessage(
        "Nytrix external debug adapter not found. Keep the built-in adapter enabled or set nytrix.debugAdapter.path explicitly."
      );
      return undefined;
    }
    const args = [
      ...cfg().get("debugAdapter.arguments", []),
      ...(session.configuration.dapArgs || [])
    ];
    return new vscode.DebugAdapterExecutable(dap.path, args, {
      cwd: expandVars(session.configuration.cwd || findRepoRoot()),
      env: toolEnv()
    });
  }
}

class NytrixTaskProvider {
  provideTasks() {
    const root = findRepoRoot();
    const t = tools();
    const tasks = [];
    const add = (id, name, command, args, group) => {
      if (!command) {
        return;
      }
      const definition = { type: "nytrix", task: id };
      const task = new vscode.Task(
        definition,
        vscode.TaskScope.Workspace,
        name,
        "nytrix",
        new vscode.ShellExecution(commandLine(command, args), { cwd: root, env: toolEnv() }),
        "$nytrix"
      );
      if (group) {
        task.group = group;
      }
      tasks.push(task);
    };
    add("run", "Run current file", t.ny.path, ["${file}"]);
    add("check", "Check current file", t.ny.path, ["--diag-compact", "-emit-only", "${file}"]);
    add("expand", "Expand current file", t.ny.path, ["--expand", "${file}"]);
    add("trace", "Trace current file", t.ny.path, ["-trace", "-run", "${file}"]);
    add("dump-ast", "Dump AST for current file", t.ny.path, ["-dump-ast", "${file}"]);
    add("dump-llvm", "Dump LLVM for current file", t.ny.path, ["-dump-llvm", "${file}"]);
    add("dump-stats", "Dump compile stats for current file", t.ny.path, ["-dump-stats", "-time", "${file}"]);
    add("format", "Format current file", t.fmt.path, ["--fix", "${file}"]);
    add("analyze", "Analyze current file", t.fmt.path, ["--analyze", "${file}"]);
    add("tests", "Run runtime tests", t.test.path, ["--with-stdlib", runtimeSuitePath()], vscode.TaskGroup.Test);
    add("profile", "Profile current file", t.perf.path, ["profile", "${file}", "--"]);
    return tasks;
  }

  resolveTask(task) {
    return task;
  }
}

module.exports = {
  activate,
  deactivate,
  __test: {
    NytrixCodeLensProvider,
    NytrixCodeActionProvider,
    NytrixDocumentFormattingProvider,
    bootstrapRoot,
    bootstrapRepo,
    bootstrapRef,
    bootstrapToolPaths,
    bootstrapPlan,
    diagnosticCodeString,
    isFormatDiagnostic,
    isOptimizationDiagnostic,
    buildDocStubEdit,
    formatDocumentText,
    summarizeDiagnosticCounts,
    formatDiagnosticCountsLabel,
    formatErrorLensMessage,
    NytrixSymbolIndex,
    NytrixSemanticTokensProvider,
    NytrixDebugConfigurationProvider,
    resolveNytrixDebugConfig,
    withDwarfVersion,
    fuzzySymbolScore,
    findDefinitionByName,
    runtimeSuitePath,
    compilerArtifactToSymbols,
    semanticTokenType,
    parseJsonText,
    symbolRangeFromCompiler
  }
};
