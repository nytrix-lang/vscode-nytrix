# Nytrix for VS Code

Editor support for Nytrix: highlighting and snippets for `.ny` and `.nshape`,
plus the toolchain's own `ny-lsp` and `ny-dap`.

## Features

- `.ny` highlighting for modules, layouts, structs, impls, operators,
  attributes, f-strings, comptime forms, inline asm, embedded
  JSON/XML/HTML/YAML/INI/SQL/regex strings, and every comment form the lexer
  accepts.
- `.nshape` highlighting for the shape DSL with embedded `source ny <<'NY'`
  and `source c <<'C'` blocks, and `ny`/`nytrix` Markdown fences.
- Snippets for Nytrix sources and for fuzz, benchmark and error shapes.
- From `ny-lsp`: diagnostics, hover, definitions, references, symbols,
  completions, rename, semantic tokens, inlay hints, code lenses and
  formatting.
- Run and Debug buttons in the editor toolbar, a `Nytrix` right-click submenu
  for the other tools, and F5 launch configurations.
- One command palette entry, `Nytrix: Show Commands`, filled by `ny-lsp` so the
  extension never carries its own command list.
- Debugging through the normal VS Code UI, proxied by `ny-dap`.

## Layout

| Path | Contents |
| --- | --- |
| `language/` | Editor assets: manifest, grammars, language configuration, snippets |
| `src/extension.js` | Toolchain discovery, `ny-lsp` client, `ny-dap` factory |
| `src/scripts/` | `sync` (manifest → `package.json`), `check`, `package` |

Edit the manifest and grammars in `language/`; `npm run sync` updates
`package.json` and `npm run check` fails on drift.

## Install

Extension id `x3ric.nytrix` — [Marketplace][vscm] · [Open VSX][ovsx].

```sh
npm install
npm run package
```

Open a `.ny` file, then run `Nytrix: Show Commands` from the command palette.

## Toolchain

`ny-lsp` and `ny-dap` are discovered through `nytrix.toolchain`, then
`NYTRIX_HOME`/`NYTRIX_ROOT`, then `build/release` in the workspace, then
`PATH`. Each executable is resolved on its own.

## Settings

| Setting | Meaning |
| --- | --- |
| `nytrix.toolchain` | Directory holding `ny-lsp` and `ny-dap` |
| `nytrix.server.arguments` | Extra arguments for `ny-lsp` |
| `nytrix.server.environment` | Extra environment for `ny-lsp` and `ny-dap` |
| `nytrix.debugger` | Native debugger for `ny-dap` (`gdb` 14+ or `lldb-dap`) |
| `nytrix.trace.server` | Log language-server traffic |

## Debugging

```json
{
  "type": "nytrix",
  "request": "launch",
  "name": "Nytrix: Debug File",
  "program": "${file}",
  "cwd": "${fileDirname}"
}
```

`ny-dap` builds `.ny` programs and `.nshape` fixtures with debug info before
handing them to the native debugger. `sourceLine` picks the `ny` block of a
fixture and `compilerArgs` adds debug-build flags.

## License

MIT. See `LICENSE`.

[vscm]: https://marketplace.visualstudio.com/items?itemName=x3ric.nytrix
[ovsx]: https://open-vsx.org/extension/x3ric/nytrix
