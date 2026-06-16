# Changelog

Compact release notes for the Nytrix VS Code extension.

### 0.1.7 - 2026-06-16

- Removed the duplicated JS/gdb debug adapter path from the extension runtime.
- Simplified debugging around the real `ny-dap` executable and autodiscovery.
- Added bootstrap path setup for `ny-dap` alongside `ny` and `ny-lsp`.
- Polished LSP startup/restart handling and fixed auto-bootstrap restart after installing `ny-lsp`.
- Kept extension-side symbols/completions/diagnostics as fallback-only behavior when `ny-lsp` is not ready.

### 0.1.6 - 2026-06-16

- Merged extension docs into one compact README.
- Replaced `LICENSE.md` with a standard `LICENSE` file.
- Renamed the docs command to `Nytrix: Open README`.
- Removed standalone DETAILS/CHANGELOG packaging noise.

### 0.1.5 - 2026-06-16

- Added external `ny-dap` autodiscovery.
- Added `.nshape` snippets, tasks, and commands for shape files/suites.
- Refined debug/toolchain docs.

## 0.1.4 - 2026-06-06

- Updated snippets, highlighting, and fallback symbol parsing for
  `fn name(type arg) RetType`.
- Highlighted `extern { ... }` and `extern "abi" { ... }` consistently.
- Normalized fallback hover/signature output to the current compact syntax.
- Folded JS smokes into one shared runner and removed duplicate activation
  entries for contributed commands.

## 0.1.3 - 2026-06-03

- Fixed string highlighting after escaped trailing backslashes.
- Reduced Markdown fence aliases to `ny` and `nytrix`.
- Trimmed public extension metadata and docs wording.

## 0.1.2 - 2026-05-27

- Added compiler-parser fallback symbols, semantic tokens, and type completions
  using `ny --stop-after=parse --emit-artifact --emit-shapes` when `ny-lsp` is
  unavailable.
- Added `ny-doc` search commands for docs, modules, symbols, and API keywords.
- Added package-search and toolchain updates around settings, status-bar
  actions, walkthroughs, and command discovery.
- Refined syntax highlighting, snippets, and command metadata.
- Improved built-in gdb/MI debug adapter tests and launch/attach smoke checks.
- Tightened packaging so generated builds, caches, tests, and VSIX artifacts do
  not ship or get committed by mistake.
- Added validation and package smoke tests for metadata, packaging, bootstrap,
  code actions, and debug-symbol handling.

## 0.1.1 - 2026-05-25

- Improved Nytrix syntax highlighting for newer language forms and embedded
  source blocks.
- Refined token scopes so editors can color imports, declarations, keywords,
  comments, strings, numbers, and punctuation more consistently.

## 0.1.0 - 2026-05-21

- Added `.ny` syntax support.
- Added `ny-lsp` integration with diagnostics, hover, definitions, references,
  symbols, completion, and signature help.
- Added run/check/format/expand/analyze/trace/profile/test/REPL commands.
- Added built-in gdb/MI debug adapter for launch and attach workflows.
- Added tool discovery/bootstrap for local builds, env paths, managed installs,
  and `PATH`.
- Moved long-form docs to `DETAILS.md`; kept `README.md` short.

## 0.0.3 - 2026-01-14

- Fixed changelog typos.

## 0.0.2 - 2026-01-14

- Refined use-syntax highlighting and README wording.
- Added language icon updates.

## 0.0.1 - 2026-01-13

- Initial syntax highlighting.
