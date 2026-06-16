# Nytrix for VS Code

Compact VS Code support for Nytrix source, shape tests, real language-server/debug tooling, and common project commands.

## Features

- `.ny` TextMate highlighting for modules, layouts, structs, impls, operators, attributes, f-strings, comptime forms, inline asm, and embedded JSON/XML/HTML/YAML/INI/SQL/regex strings.
- `.nshape` highlighting for the shape DSL plus embedded `source ny <<'NY'` and `source c <<'C'` heredocs.
- Markdown fences for `ny` and `nytrix`.
- Snippets for Nytrix files and fuzz/benchmark/error shape files.
- Real `ny-lsp` integration for diagnostics, hover, definitions, references, symbols, completions, and signature help.
- Compiler-parser fallback symbols, semantic tokens, and type completions only when `ny-lsp` is unavailable or still starting.
- Real `ny-dap` debugging through VS Code's debug UI.
- Commands for run, check, format, expand, analyze, trace, profile, tests, shapes, REPL, docs, and toolchain inspection.
- Tool discovery through settings, environment variables, workspace builds, bootstrap roots, and `PATH`.

## Install

Extension id: `x3ric.nytrix`

Marketplace: [VS Code][vscm] / [Open VSX][ovsx]

```sh
npm install
npm run validate
npm run package:ls
```

Open a `.ny` or `.nshape` file and run `Nytrix: Show Actions`.

## Tools

The extension uses the normal Nytrix tool names:

| Tool | Used for |
| --- | --- |
| `ny` | run/check/expand/analyze/trace/profile helpers |
| `ny-lsp` | language server |
| `ny-dap` | debug adapter |
| `ny-fmt` | formatting and formatter analysis |
| `ny-doc` | documentation and API search |
| `ny-test` | runtime tests and shape suites |
| `ny-perf` | benchmark/perf helpers |
| `ny-make` | project build helpers |

Discovery order is explicit setting, environment variable, workspace `build/release`, bootstrap root, then `PATH`.

## Commands

Common commands:

- `Nytrix: Show Actions`
- `Nytrix: Run File`, `Check File`, `Format File`
- `Nytrix: Expand File`, `Analyze File`, `Trace File`, `Profile File`
- `Nytrix: Run Runtime Tests`, `Run Shape File`, `Run Shape Suite`
- `Nytrix: Start REPL`, `Send Selection to REPL`, `Run File in REPL`
- `Nytrix: Search Docs / API`, `Search Docs for Selection`
- `Nytrix: Debug File`, `Restart Language Server`, `Show Toolchain`, `Install Toolchain`
- `Nytrix: Open README`, `Open Settings`, `Show Output`

## LSP

`ny-lsp` is the primary owner for editor intelligence. Extension-side symbol/completion/diagnostic helpers stay as a fallback and automatically stand down once the language server is ready.

Set `nytrix.lsp.path` or `NYTRIX_LSP` when `ny-lsp` is outside the workspace/toolchain. Use `Nytrix: Restart Language Server` after changing paths or rebuilding the toolchain.

## Debugging

The `nytrix` debug type now uses the real `ny-dap` executable directly. It is resolved from `nytrix.debugAdapter.path`, `NYTRIX_DAP`, workspace builds, bootstrap roots, or `PATH`.

```json
{
  "type": "nytrix",
  "request": "launch",
  "name": "Debug current Nytrix file",
  "program": "${file}",
  "cwd": "${workspaceFolder}",
  "args": [],
  "stopOnEntry": false
}
```

Use `sourceFileMap` when debug info was built under a different root, for example `{ "/build/root": "${workspaceFolder}" }`.

## Settings

Main settings:

- Tool paths: `nytrix.path`, `nytrix.lsp.path`, `nytrix.doc.path`, `nytrix.debugAdapter.path`.
- LSP/fallbacks: `nytrix.lsp.enabled`, `nytrix.language.compilerParser.*`.
- DAP: `nytrix.debugAdapter.arguments`, `nytrix.debug.*`.
- Bootstrap: `nytrix.bootstrap.mode`, `root`, `repo`, `ref`.
- Tests: `nytrix.test.runtimeSuitePath`, `nytrix.test.shapeSuitePath`.
- Run/REPL/output: `nytrix.run.*`, `nytrix.repl.*`, `nytrix.output.reveal`.
- Editor helpers: `nytrix.check.onSave`, `nytrix.codeLens.enabled`, `nytrix.errorLens.*`.
- Environment: `nytrix.env`.

Open `Nytrix: Open Settings` for the full schema and descriptions.

## Tasks

Example `.vscode/tasks.json` entries:

```json
{
  "version": "2.0.0",
  "tasks": [
    { "label": "nytrix: check", "type": "nytrix", "task": "check", "problemMatcher": [] },
    { "label": "nytrix: shapes", "type": "nytrix", "task": "shapes", "problemMatcher": [] }
  ]
}
```

## License

MIT. See `LICENSE`.

[Nytrix]: https://github.com/nytrix-lang
[vscm]: https://marketplace.visualstudio.com/items?itemName=x3ric.nytrix
[ovsx]: https://open-vsx.org/extension/x3ric/nytrix
