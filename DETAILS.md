# Nytrix Extension Details

Reference for the Nytrix VS Code extension.

## Support

- TextMate highlighting for `.ny` files.
- Highlighting covers modules, layouts, structs, impl blocks, typed
  operators, attributes, f-strings, comptime syntax, `handle`, low-level
  builtins, inline asm, and detectable embedded JSON/XML/HTML/YAML/INI/SQL/regex
  strings.
- Markdown fenced code blocks labeled `ny` or `nytrix` use the Nytrix grammar.
- Starts `ny-lsp` when available.
- LSP-backed diagnostics, hover, definition, references, symbols, completion,
  and signature help, with an extension-side symbol index fallback.
- The fallback symbol index can use the compiler parser artifact
  (`ny --stop-after=parse --emit-artifact --emit-shapes`) before local regex
  heuristics.
- Inline Nytrix diagnostic lenses for errors, warnings, notes, and analyzer
  hints.
- Hover cards for Nytrix symbols, including function inputs, output type hints,
  docs, and source location.
- Editor title buttons for Run and Debug.
- Tool commands call Nytrix binaries: `ny`, `ny-doc`, `ny-fmt`,
  `ny-test`, `ny-perf`, and `ny-make`.
- Built-in toolchain bootstrap: when `ny` / `ny-lsp` is missing, the extension
  asks before cloning/building `https://github.com/nytrix-lang/nytrix`, or lets
  you set explicit binary paths instead.
- Editor commands for `Check File`, `Expand File`, document/workspace symbol
  jumps, hover, signature help, references, and stdlib navigation.
- REPL commands for send-selection/line, run-file-in-REPL, and
  load-file-in-REPL.
- Nytrix snippets for common module, function, layout, comptime-template, and
  inline-asm scaffolds.
- VS Code tasks for run/check/expand/trace/dumps/format/analyze/tests/profile.
- Nytrix debug configuration type with launch/attach, source/function
  breakpoints, conditions, hit counts, source maps, stack frames, locals,
  expandable values, registers, evaluate, loaded sources, and modules through
  the built-in gdb/MI-backed DAP adapter.
- Automatic `ny-lsp` diagnostics while editing, with compiler diagnostics as a
  save-time fallback only when the language server is unavailable.

## Editor Commands

- `Nytrix: Show Actions` opens a picker for the active file:
  run, check, expand, debug, trace, REPL, symbols, docs, and run settings.
- `Nytrix: Show Output` and `Nytrix: Clear Output` manage the shared output
  channel directly.
- `Nytrix: Install Toolchain` clones or refreshes the official Nytrix repo,
  builds the toolchain, and writes `nytrix.path` / `nytrix.lsp.path`.
  Missing-tool prompts also offer `Set Path`.
- `Nytrix: Set Run Mode` and `Nytrix: Set Output Reveal Mode` set run behavior.
- `Nytrix: Search Docs / API` runs `ny-doc search` across modules, symbols,
  docs, and keywords. `Nytrix: Search Docs for Selection` seeds the query
  from the selected text or symbol under the cursor.
- The status bar entries link to Actions, Docs, Toolchain, Settings, and LSP
  restart.
- The extension contributes a walkthrough for toolchain discovery, actions,
  docs/API search, and debug setup.
- `nytrix.run.mode` lets you choose between one-off terminal runs, output-panel
  runs, or routing file/selection execution into the persistent REPL.
- `nytrix.output.reveal` controls whether command output auto-opens on errors,
  always, or never.
- `nytrix.output.clearBeforeRun` lets you choose between a persistent command
  history and a fresh output pane every run.

## Tool Discovery

The extension searches in this order:

1. `nytrix.path`, `nytrix.lsp.path`, `nytrix.doc.path`, and explicit debug
   adapter settings.
2. `NYTRIX_NY`, `NYTRIX_LSP`, and `NYTRIX_DOC` environment variables.
3. Workspace roots and their parents, including `build/release/ny`,
   `build/release/ny-lsp`, `build/release/ny-doc`, `build/release/ny-fmt`,
   `build/release/ny-test`, `build/release/ny-perf`, and `build/release/ny-make`.
4. `NYTRIX_HOME`.
5. The extension-managed bootstrap root (`nytrix.bootstrap.root`), which
   defaults to `~/.local/share/nytrix`.
6. `~/nytrix` and `~/.nytrix`.
7. `PATH`.

Opening the Nytrix repository root uses repo-local binaries after a normal
build. `Nytrix: Install Toolchain` can set up the managed toolchain after
approval.

## Commands

- `Nytrix: Run File`
- `Nytrix: Run Selection`
- `Nytrix: Check File`
- `Nytrix: Debug File`
- `Nytrix: Find Definition by Name`
- `Nytrix: Expand File`
- `Nytrix: Format File`
- `Nytrix: Optimize File`
- `Nytrix: Analyze File`
- `Nytrix: Trace File`
- `Nytrix: Dump AST`
- `Nytrix: Dump LLVM`
- `Nytrix: Dump Compile Stats`
- `Nytrix: Run Runtime Tests`
- `Nytrix: Profile File`
- `Nytrix: Restart Language Server`
- `Nytrix: Open Settings`
- `Nytrix: Open Extension Details`
- `Nytrix: Show Toolchain`
- `Nytrix: Install Toolchain`
- `Nytrix: Set Run Mode`
- `Nytrix: Set Output Reveal Mode`
- `Nytrix: Start REPL`
- `Nytrix: Focus REPL`
- `Nytrix: Reset REPL`
- `Nytrix: Clear REPL`
- `Nytrix: Send Selection to REPL`
- `Nytrix: Run File in REPL`
- `Nytrix: Load File in REPL`

## Debugging

The extension contributes a `nytrix` debug type and breakpoint support. By
default it uses the built-in DAP adapter, which compiles the file with
`ny -O0 -g -o ...` and drives `gdb --interpreter=mi2` for stepping, stack frames,
expandable locals, registers, expression evaluation, loaded sources, and
modules. You can disable it and point at an external adapter with
`nytrix.debugAdapter.useInternal=false`.

Example launch config:

```json
{
  "type": "nytrix",
  "request": "launch",
  "name": "Nytrix: Debug Current File",
  "program": "${file}",
  "cwd": "${workspaceFolder}",
  "args": [],
  "stopOnEntry": false
}
```

Attach config:

```json
{
  "type": "nytrix",
  "request": "attach",
  "name": "Nytrix: Attach",
  "processId": "${command:nytrix.pickProcess}",
  "cwd": "${workspaceFolder}",
  "stopOnEntry": true
}
```

For reliable `.ny` line stepping and source breakpoints, Nytrix debug builds
must emit DWARF line tables and locals for the original `.ny` source paths. If a
build machine path differs from your workspace, use `sourceFileMap`, for example
`{"/build/root": "${workspaceFolder}"}`.

## Settings

- `nytrix.path`: path to `ny`.
- `nytrix.lsp.path`: path to `ny-lsp`.
- `nytrix.doc.path`: path to `ny-doc`.
- `nytrix.language.compilerParser.enabled`: use the compiler parser artifact
  for fallback symbols, semantic tokens, and type/type-group completions.
- `nytrix.language.compilerParser.dirtyBuffers`: also parse unsaved buffers
  through the compiler fallback. Enabled by default so syntax changes flow from
  the compiler into editor features without extension edits.
- `nytrix.language.compilerParser.maxDirtyBytes`: size guard for unsaved buffer
  compiler parsing. `0` disables the guard.
- `nytrix.language.compilerParser.timeoutMs`: compiler parser fallback timeout;
  stale/local results are kept if the compiler exceeds the budget.
- `nytrix.lsp.enabled`: start/disable the language server.
- `nytrix.bootstrap.mode`: choose `prompt`, `auto`, or `off` for missing-tool
  recovery. `prompt` asks on demand, `auto` asks as soon as a missing tool is
  needed, and `off` leaves discovery to explicit paths/environment/PATH.
- `nytrix.bootstrap.root`: install/update root for the extension-managed
  Nytrix checkout.
- `nytrix.bootstrap.repo`: git repository cloned by `Nytrix: Install
  Toolchain`.
- `nytrix.bootstrap.ref`: branch/tag/ref fetched by bootstrap.
- `nytrix.debugAdapter.path`: explicit path to a compatible external debug
  adapter when the built-in adapter is disabled.
- `nytrix.debugAdapter.useInternal`: use the built-in gdb/MI debug adapter.
- `nytrix.debugAdapter.arguments`: extra adapter arguments.
- `nytrix.debug.gdbPath`: path to `gdb`.
- `nytrix.debug.compilerArguments`: extra debug-build compiler args.
- `nytrix.debug.dwarfVersion`: optional DWARF version appended to debug
  compiler args unless `--dwarf-version` is already present.
- `nytrix.debug.outputDir`: temporary debug ELF directory.
- `nytrix.debug.sourceFileMap`: default debugger source root mapping.
- `nytrix.test.runtimeSuitePath`: runtime test suite path passed to `ny-test`;
  defaults to `etc/tests/rt`.
- `nytrix.run.arguments`: extra arguments passed after the current file.
- `nytrix.run.cwd`: command working directory.
- `nytrix.run.mode`: choose `terminal`, `output`, or `repl`.
- `nytrix.output.reveal`: choose `errors`, `always`, or `never`.
- `nytrix.run.reuseTerminal`: reuse one integrated terminal for repeated run,
  test, and profile commands.
- `nytrix.repl.cwd`: REPL working directory.
- `nytrix.repl.arguments`: extra startup args appended after `-i`.
- `nytrix.repl.usePlain`: start the persistent REPL with `--plain-repl`.
- `nytrix.repl.revealTerminal`: reveal the REPL terminal when the extension
  boots it or sends code into it.
- `nytrix.check.onSave`: fallback compiler diagnostics on save when `ny-lsp`
  is unavailable.
- `nytrix.codeLens.enabled`: show Run/Check/Expand/Debug action lenses.
- `nytrix.errorLens.enabled`: show inline Nytrix diagnostic summaries after the
  affected line.
- `nytrix.errorLens.includeHints`: include analyzer hints and notes in inline
  diagnostic lenses.
- `nytrix.errorLens.maxItems`: cap how many inline diagnostic lenses render in
  one editor.
- `nytrix.env`: extra environment variables for Nytrix tools.

## License

This extension is licensed under the [MIT][license].

[Nytrix]: https://github.com/nytrix-lang
[license]: https://opensource.org/license/mit
