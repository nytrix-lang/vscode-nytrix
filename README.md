# Nytrix for VS Code

Compact VS Code support for Nytrix source, shape tests, and the real `ny-lsp`
and `ny-dap` executables.

## Features

- `.ny` TextMate highlighting for modules, layouts, structs, impls, operators,
  attributes, f-strings, comptime forms, inline asm, and embedded
  JSON/XML/HTML/YAML/INI/SQL/regex strings.
- `.nshape` highlighting for the shape DSL plus embedded `source ny <<'NY'`
  and `source c <<'C'` heredocs.
- Markdown fence highlighting for `ny` and `nytrix` through the injected
  grammar.
- Snippets for Nytrix files and fuzz/benchmark/error shape files.
- Diagnostics, hover, definitions, references, symbols, completions, rename,
  semantic tokens, inlay hints and code lenses from `ny-lsp`.
- `ny-dap` debugging through the normal VS Code debug UI.
- One command palette entry (`Nytrix: Commands…`) that asks `ny-lsp` for the
  toolchain's command list, so the extension never carries its own list.

## Layout

| Path | Contents |
| --- | --- |
| `language/` | Canonical editor assets: manifest, grammars, language configuration, snippets |
| `src/extension.js` | The whole extension: toolchain discovery, `ny-lsp` client, `ny-dap` factory |
| `etc/scripts/sync.js` | Copies `language/languages.json` into the `package.json` sections VS Code reads |
| `etc/scripts/check.js` | Verifies manifest, assets, commands, settings and versions |
| `etc/scripts/package.js` | Deterministic package file list and VSIX build |

Edit the manifest and grammars in `language/`; `npm run sync` keeps
`package.json` in step and `npm run check` fails on drift.

## Install

Extension id: `x3ric.nytrix`

Marketplace: [VS Code][vscm] / [Open VSX][ovsx]

```sh
npm install
npm run check
npm run package
```

Open a `.ny` file, then run `Nytrix: Commands…` from the command palette.

## Toolchain

`ny-lsp` and `ny-dap` are discovered through, in order:

1. `nytrix.toolchain` (a directory, or the path to one of the executables)
2. `NYTRIX_HOME` / `NYTRIX_ROOT` (`bin/`, `build/release/`, or the root)
3. `PATH`
4. `build/release` inside the current workspace

## Settings

| Setting | Meaning |
| --- | --- |
| `nytrix.toolchain` | Directory holding `ny-lsp` and `ny-dap` |
| `nytrix.server.arguments` | Extra arguments for `ny-lsp` |
| `nytrix.server.environment` | Extra environment for `ny-lsp` and `ny-dap` |
| `nytrix.debugger` | Native DAP debugger used by `ny-dap` (`gdb` 14+ or `lldb-dap`) |
| `nytrix.trace.server` | Log language-server traffic to the Nytrix output channel |

## Debugging

```json
{
  "type": "nytrix",
  "request": "launch",
  "name": "Nytrix: Debug File",
  "program": "${file}",
  "cwd": "${fileDirname}",
  "args": [],
  "stopOnEntry": false
}
```

`ny-dap` builds `.ny` programs and `.nshape` fixtures with debug info before
handing them to the native debugger. Use `sourceLine` to pick the source `ny`
block of a fixture and `compilerArgs` for extra debug-build flags.

## License

MIT. See `LICENSE`.

[Nytrix]: https://github.com/nytrix-lang
[vscm]: https://marketplace.visualstudio.com/items?itemName=x3ric.nytrix
[ovsx]: https://open-vsx.org/extension/x3ric/nytrix
