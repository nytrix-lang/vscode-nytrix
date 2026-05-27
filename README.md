# Nytrix

Nytrix language support for VS Code.

Nytrix project and source repositories live at [github.com/nytrix-lang][Nytrix].

## What You Get

- Syntax highlighting for `.ny` and `.nshape`.
- Markdown codeblock highlighting for `ny`, `nytrix`, and `nshape`.
- `ny-lsp` diagnostics, hover, definitions, references, symbols, completion,
  and signature help when the language server is available.
- Compiler-backed fallback symbols, semantic tokens, and type completions from
  `ny --stop-after=parse --emit-artifact --emit-shapes` when LSP is unavailable.
- Run, check, format, expand, analyze, trace, profile, REPL, and debug commands.
- `ny-doc` search commands for docs, modules, symbols, and API keyword tags.
- Built-in gdb/MI debug adapter for Nytrix launch/attach workflows.
- Toolchain discovery from settings, environment variables, workspace builds,
  managed bootstrap roots, and `PATH`.

## Install

The extension is available as `x3ric.nytrix` from the
[VS Code Marketplace][vscm] and [Open VSX][ovsx].


[Nytrix]: https://github.com/nytrix-lang
[vscm]: https://marketplace.visualstudio.com/items?itemName=x3ric.nytrix
[ovsx]: https://open-vsx.org/extension/x3ric/nytrix
[license]: https://opensource.org/license/mit

## Quick Start

```sh
npm install
npm run validate
npm run package:ls
```

Open a `.ny` or `.nshape` file, then run `Nytrix: Show Actions` from the command
palette for the compact command surface.

## Useful Commands

- `Nytrix: Show Actions`
- `Nytrix: Run File`
- `Nytrix: Check File`
- `Nytrix: Format File`
- `Nytrix: Search Docs / API`
- `Nytrix: Debug File`
- `Nytrix: Start REPL`
- `Nytrix: Install Toolchain`
- `Nytrix: Show Toolchain`
- `Nytrix: Open Settings`
- `Nytrix: Open Extension Details`

## More

Detailed commands, settings, tool discovery, debugging notes, and test harness
docs live in [DETAILS.md](DETAILS.md).

## License

MIT. See [LICENSE.md](LICENSE.md).
