# Language assets

The editor-facing description of the Nytrix languages lives here and is the
single source of truth editors read.

| Path | Contents |
| --- | --- |
| `languages.json` | Manifest: language ids, extensions, grammars, snippets, breakpoints, the language server and debug adapter |
| `syntaxes/` | TextMate grammars (`.ny`, `.nshape`, embedded shaders, Markdown fences) |
| `configuration/` | Comment, bracket, indentation and word rules per language |
| `snippets/` | Snippets per language |

`npm run sync` copies `languages.json` into the `package.json` sections VS Code
reads, and `npm run check` verifies every contributed path. Edit the manifest
and the grammars here, never the generated `package.json` sections.

Behaviour comes from the toolchain, not from these files:

- `ny-lsp` serves diagnostics, completion, hover, navigation, rename,
  semantic tokens, inlay hints, code lenses, formatting, and the editor
  command list (`nytrix/commands`). Commands return portable actions
  (`process`, `debug`, `message`) for the editor to perform.
- `ny-dap` is a Debug Adapter Protocol proxy. A launch whose `program` is a
  `.ny` file or an `.nshape` fixture is built with debug info, then handed to
  GDB 14+ or lldb-dap; fixture paths are mapped both ways.

Other editors can do the same: register `languages.json`, start `ny-lsp` over
stdio, and launch `ny-dap` as a stdio debug adapter.
