# Nytrix

VS Code extension for Nytrix.

Project repositories: [github.com/nytrix-lang][Nytrix].

## Support

- Highlighting for `.ny` files.
- Markdown highlighting for `ny` and `nytrix` code fences.
- `ny-lsp` diagnostics, hover, definitions, references, symbols, completions,
  and signature help when the language server is available.
- Compiler-backed fallback symbols, semantic tokens, and type completions when
  LSP is unavailable.
- Commands for run, check, format, expand, analyze, trace, profile, REPL,
  documentation, and debug.
- Tool discovery from settings, environment variables, workspace builds,
  bootstrap roots, and `PATH`.

## Install

Extension id: `x3ric.nytrix`

[VS Code Marketplace][vscm] / [Open VSX][ovsx]

[Nytrix]: https://github.com/nytrix-lang
[vscm]: https://marketplace.visualstudio.com/items?itemName=x3ric.nytrix
[ovsx]: https://open-vsx.org/extension/x3ric/nytrix
[license]: https://opensource.org/license/mit

## Local Commands

```sh
npm install
npm run validate
npm run package:ls
```

Open a `.ny` file and run `Nytrix: Show Actions` from the command palette.

## Commands

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

## Reference

Commands, settings, tool discovery, debugging notes, and test details live in
[DETAILS.md](DETAILS.md).

## License

MIT. See [LICENSE.md](LICENSE.md).
