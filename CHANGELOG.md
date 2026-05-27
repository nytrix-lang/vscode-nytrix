# Changelog

Compact release notes for the Nytrix VS Code extension.

## 0.1.2 - 2026-05-27

- Added compiler-parser fallback symbols, semantic tokens, and type completions
  using `ny --stop-after=parse --emit-artifact --emit-shapes` when `ny-lsp` is
  unavailable.
- Added `ny-doc` search commands for docs, modules, symbols, and API keyword
  tags.
- Added package-search and toolchain polish around settings, status-bar
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

- Added `.ny` and `.nshape` syntax support, including Ny/C embedded shape
  source blocks.
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
- Added language icon polish.

## 0.0.1 - 2026-01-13

- Initial syntax highlighting.
