# Changelog

All notable changes to the Nytrix VS Code extension.

## 0.2.1 - 2026-11-22

- Compacted the extension to one `src/extension.js`: toolchain discovery, the
  `ny-lsp` client, and the `ny-dap` debug adapter factory. The command list
  comes from `ny-lsp` (`nytrix/commands`), so the extension carries none.
- Moved the editor assets to `language/` (manifest, grammars, configuration,
  snippets) as the single source of truth; `npm run sync` writes the
  `package.json` sections and `npm run check` verifies them.
- Build scripts live in `src/scripts/{sync,check,package}.js`; the `Makefile`
  stages `language/` instead of the old `etc/syntax` tree.
- Removed the JS debug adapter, the protocol smoke suite, and the Markdown
  preview plugin; Markdown fences stay highlighted through the injected
  grammar.
- Highlight comments the way `ny` lexes them: `;` line comments, `;;`
  documentation comments, the `;{ }`, `;[ ]`, `;( )` and `;< >` symbol blocks,
  and `;MARKER … MARKER;` heredoc blocks.
- Resolve `ny-lsp` and `ny-dap` independently, preferring `nytrix.toolchain`,
  `NYTRIX_HOME`, then the workspace `build/release` over `PATH`, so a stale
  installed copy never shadows a fresh build.
- Run and Debug buttons in the editor toolbar, a `Nytrix` submenu in the
  editor context menu (check, trace, expand, AST, LLVM IR, stats, analyze,
  optimize, profile, REPL, tests, docs), Run/Debug in the Explorer menu, and
  `Ctrl+Alt+R` to run. All generated from `language/languages.json`.
- Short command titles (`Run File`, `Debug File`, `Show Commands`) and a
  command picker without raw ids.
- Debugging asks for a native debugger up front: a clear error when neither
  gdb 14+ nor lldb-dap is installed, an "Open Settings" prompt when a tool is
  missing, and `~` expansion in `nytrix.debugger`.
- Extension icon rendered from the project's `logo.svg`.
- Known gap: the native backend emits no local-variable DWARF yet, so the
  Variables view shows registers only.

## 0.2.0 - 2026-06-20

- Modularized extension source into `src/core`, `src/lsp`, `src/diagnostics`, `src/symbols`, `src/providers`, `src/debugger`, and `src/commands`.
- Added `;{lang ... };` block comment syntax with embedded language syntax highlighting (Python, JS, TS, C, C++, Rust, shell, JSON, XML, Nytrix). Language tag is highlighted distinctly; unlabeled blocks default to Nytrix.
- Changed default block comment from `;* ... *;` to `;{ ... };`.
- Replaced flat right-click context menu with organized `Run / Debug`, `Tools`, and `Navigation` submenus.
- Added `Nytrix: Toggle Type Inlay Hints` command and `nytrix.inlayHints.enabled` setting.

## 0.1.9 - 2026-06-16

- Reworked the Marketplace changelog into cleaner, shorter release notes.
- Bumped extension and lockfile metadata for a fresh Marketplace publish.
- Hardened debug configuration resolution when VS Code provides an empty config.
- Deduplicated package-script error formatting while keeping package lists deterministic.

## 0.1.8 - 2026-06-16

- Included `CHANGELOG.md` in deterministic package file lists so the Marketplace changelog tab renders correctly.
- Removed the legacy JS debug-adapter source from shipped artifacts.
- Improved debug-adapter launch fallback for missing paths, bad arguments, and empty working directories.
- Hardened package listing around malformed JSON, stale lockfiles, and dependency discovery.

## 0.1.7 - 2026-06-16

- Switched debugging to the real external `ny-dap` executable.
- Added `ny-dap` discovery through settings, environment variables, workspace builds, bootstrap roots, and `PATH`.
- Polished LSP startup/restart flow, including restart after toolchain bootstrap.
- Kept extension-side symbols, completions, and diagnostics as fallback-only behavior when `ny-lsp` is not ready.

## 0.1.6 - 2026-06-16

- Merged extension docs into one compact README.
- Replaced `LICENSE.md` with a standard `LICENSE` file.
- Renamed the docs command to `Nytrix: Open README`.
- Removed stale standalone docs from the packaged extension.

## 0.1.5 - 2026-06-16

- Added external `ny-dap` autodiscovery.
- Added `.nshape` snippets, tasks, and commands for shape files and shape suites.
- Refined debug and toolchain documentation.

## 0.1.4 - 2026-06-06

- Updated snippets, highlighting, and fallback symbol parsing for `fn name(type arg) RetType`.
- Highlighted `extern { ... }` and `extern "abi" { ... }` consistently.
- Normalized fallback hover and signature output to the current compact syntax.
- Folded JS smokes into one shared runner and removed duplicate command activation entries.

## 0.1.3 - 2026-06-03

- Fixed string highlighting after escaped trailing backslashes.
- Reduced Markdown fence aliases to `ny` and `nytrix`.
- Trimmed public extension metadata and README wording.

## 0.1.2 - 2026-05-27

- Added compiler-parser fallback symbols, semantic tokens, and type completions through `ny --stop-after=parse --emit-artifact --emit-shapes` when `ny-lsp` is unavailable.
- Added `ny-doc` search commands for docs, modules, symbols, and API keywords.
- Added toolchain status, settings, walkthroughs, command discovery, and package-search improvements.
- Refined syntax highlighting, snippets, and command metadata.
- Improved debug launch/attach smoke tests.
- Tightened packaging so generated builds, caches, tests, and VSIX artifacts do not ship by mistake.
- Added validation and smoke tests for metadata, packaging, bootstrap, code actions, and debug-symbol handling.

## 0.1.1 - 2026-05-25

- Improved Nytrix syntax highlighting for newer language forms and embedded source blocks.
- Refined token scopes for imports, declarations, keywords, comments, strings, numbers, and punctuation.

## 0.1.0 - 2026-05-21

- Added `.ny` syntax support.
- Added `ny-lsp` integration for diagnostics, hover, definitions, references, symbols, completions, and signature help.
- Added run, check, format, expand, analyze, trace, profile, test, and REPL commands.
- Added a built-in gdb/MI debug adapter for launch and attach workflows.
- Added tool discovery and bootstrap across local builds, env paths, managed installs, and `PATH`.
- Kept the README short and moved long-form docs to `DETAILS.md`.

## 0.0.3 - 2026-01-14

- Fixed changelog typos.

## 0.0.2 - 2026-01-14

- Refined syntax highlighting and README wording.
- Added language icon updates.

## 0.0.1 - 2026-01-13

- Initial syntax highlighting.
