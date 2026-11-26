# elm-lsp-rust

A fast Elm language server written in Rust, for coding agents. It gives an agent go to definition, find references, compiler diagnostics and project-wide refactorings as tools, over MCP or from the command line.

It is a stdio MCP server, so a harness with an MCP client can register it. [docs/harnesses.md](docs/harnesses.md) has the entry for Claude Code, OpenAI Codex, GitHub Copilot, Cursor, OpenCode, Gemini CLI, Google Antigravity, Cline, Goose, Pi and Oh My Pi. The Claude Code and Codex entries are tested in those harnesses. The other nine follow each harness's documentation and have not been run there. Aider, which has no MCP client, and any script can call the same tools through the command-line interface.

## Installation

### Any harness

```bash
git clone https://github.com/CharlonTank/elm-lsp-rust
cd elm-lsp-rust
scripts/setup.sh                            # builds the language server (needs cargo and Node.js 18+)
node mcp-wrapper/cli.mjs doctor             # checks the installation
node mcp-wrapper/cli.mjs config             # lists the harnesses
node mcp-wrapper/cli.mjs config <harness>   # prints where your harness keeps its MCP servers and the entry to add
```

[docs/harnesses.md](docs/harnesses.md) shows the entry for every harness. A harness that is not listed needs a stdio MCP server whose command is `node` and whose argument is the absolute path of `mcp-wrapper/index.mjs`.

You can also hand the job to your agent. Tell it to read [docs/agent-install.md](docs/agent-install.md) in the clone and follow it.

The server starts from any directory, and each tool finds the Elm project from the file it is given. One registration therefore serves every Elm project on the machine. Pass absolute file paths, because a relative path resolves against the directory the harness started the server in.

The skill in `skills/elm-refactoring` tells an agent when and how to use the tools. Copy it into the project's `.agents/skills/` directory, or `.claude/skills/` for Claude Code.

### Claude Code plugin

In Claude Code, run:

```bash
/plugin marketplace add CharlonTank/elm-lsp-plugin
/plugin install elm-lsp-rust@CharlonTank/elm-lsp-plugin
```

Then restart Claude Code.

#### How plugin distribution works

```
┌─────────────────────────────────────────────────────────────────┐
│                     elm-lsp-plugin                              │
│            (Marketplace Repository)                             │
│     https://github.com/CharlonTank/elm-lsp-plugin              │
│                                                                 │
│  .claude-plugin/marketplace.json                                │
│  └── plugins: [                                                 │
│        { name: "elm-lsp-rust",                                  │
│          source: "CharlonTank/elm-lsp-rust" }                   │
│      ]                                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ references
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     elm-lsp-rust                                │
│              (This Repository - Plugin)                         │
│      https://github.com/CharlonTank/elm-lsp-rust               │
│                                                                 │
│  .claude-plugin/plugin.json ─► Plugin metadata                  │
│  src/                       ─► Rust LSP server                  │
│  mcp-wrapper/               ─► MCP server (bridges MCP↔LSP)     │
│  scripts/setup.sh           ─► Builds Rust binary on install    │
└─────────────────────────────────────────────────────────────────┘
```

When you install via the marketplace:
1. Claude Code fetches plugin metadata from `elm-lsp-plugin/marketplace.json`
2. The marketplace points to this repository (`elm-lsp-rust`)
3. Claude Code clones this repo and runs `scripts/setup.sh` to build the Rust binary
4. The MCP wrapper (`mcp-wrapper/index.mjs`) becomes available as the MCP server `elr`, whose tools Claude Code names `mcp__plugin_elm-lsp-rust_elr__elm_definition` and so on

The plugin starts the server with `--elm-projects-only`, so its tools appear only in sessions opened in an Elm project.

## Command line

`mcp-wrapper/cli.mjs` runs one tool per call and prints its result. Each argument of the tool is a flag.

```bash
node mcp-wrapper/cli.mjs tools                 # list the tools, add --json for their arguments
node mcp-wrapper/cli.mjs elm_references --file_path src/Main.elm --line 10 --character 4
node mcp-wrapper/cli.mjs elm_rename_function --help
```

`--args '<json>'` passes all arguments as one JSON object. `--project-tools` works as it does for the server, see below. The exit status is 0 on success, 1 when the tool fails and 2 when the command line is wrong.

## Server options

Append these to the arguments of `mcp-wrapper/index.mjs` in your harness's config.

| Option | Effect |
|--------|--------|
| `--read-only` | Offers only the nine tools that never edit a source file |
| `--project-tools` | Takes the compiler and `elm-format` from a project's `node_modules/.bin` when they are there. Only for projects you trust |
| `--elm-projects-only` | Exits at once unless the working directory, or a direct child of it, holds an `elm.json`. The harness then lists the server as not connected |
| `--http`, `--host`, `--port` | Serves over HTTP instead of stdio, see [Shared MCP server](#shared-mcp-server-manual-http). `--host` and `--port` need `--http` |

Every tool carries MCP annotations. Nine are marked read-only: `elm_definition`, `elm_references`, `elm_symbols`, `elm_diagnostics`, `elm_code_actions`, `elm_notify_file_changed` and the three `elm_prepare_*` previews. The rest are marked as writing to disk, so a harness that reads annotations asks before it runs them. Read-only means that a tool edits no source file. `elm_diagnostics` still runs the compiler, which writes its cache to `elm-stuff/` and downloads packages it does not have yet.

Diagnostics build a Lamdera project with `lamdera` and any other project with `elm`. The compiler and `elm-format` are found on `PATH`. With `--project-tools`, a copy in the project's `node_modules/.bin` wins, so a project gets the versions it pins. That also lets a repository choose the program these tools run, and a harness may call `elm_diagnostics` without asking first. Turn it on only for code you trust.

The server starts one language server per Elm project on first use and stops it after ten idle minutes. Before each call the language server compares its index with the project on disk. It reads the source files that changed, and builds the index anew when `elm.json` did, so edits an agent made with its own tools are taken into account. While `elm.json`, a source file or a directory of source files cannot be read, every tool that asks the language server fails and says which one and why, because a refactoring would pass over what the index could not read. `elm_format` asks it nothing, and formats the file it is given all the same.

The index covers the source directories that `elm.json` lists, also one outside the project root such as `../shared`, and the modules under `tests/`, with the `test-dependencies` of `elm.json` in scope. Renames, references and symbols reach `tests/` automatically, from the MCP server and from the command line alike. A file outside both the source directories and `tests/` joins the index when a tool is called on that file. The language server then follows it like the rest, also when it builds its index anew. Such a file is gone from the index again once the language server restarts, which it does after ten idle minutes. Until a tool is called on the file again, a rename does not reach it. From the command line every call starts a new language server, so a rename there never reaches a file outside the source directories and `tests/`.

`elm_diagnostics` on a file under `tests/` builds it in a temporary project directory named `elm-lsp-test-modules-<hash>` under the system's temporary directory, with an `elm.json` that adds `tests/` and the `test-dependencies`, and keeps that directory between calls for the compiler's cache. On a test module of a package, `elm_diagnostics` gives no verdict because `elm-test` picks the versions of a package's `test-dependencies`.

All rename tools, `elm_references`, `elm_move_function`, `elm_add_variant`, `elm_remove_variant` and `elm_remove_field` resolve a name the way the compiler does. A qualified name resolves through the import whose module name or alias is its qualifier. A bare name resolves through local bindings, then the module's own declarations, then the imports that expose it. Modules, files and edits are walked in path order, so no result depends on the order of a hash map.

Two files can declare one module: a copy of `Utils.elm` says `module Utils` until its first line is edited. The index keeps one file for each module name, the one whose path spells the name, `src/Utils.elm`. Below a source directory that is the compiler's rule too, so the other file is no module of the project. A rename, or a change to a type, leaves it alone, and a tool that is called on it says so and names both files. `elm_rename_file` and `elm_move_file` give it a name of its own, and `elm_diagnostics` and `elm_format` take it like any file. Two things are less tidy. A file in no source directory that declares the name of a module in one, such as `examples/Demo/Main.elm` beside `src/Main.elm`, compiles when the compiler is given its path, and the tools refuse it all the same. And `elm_move_function` works on the text of every Elm file below the project, so it changes the import in a copy as well.

A refactoring reads every file it changes, and checks that it may write each of them, before it writes the first. A file that cannot be read or written leaves the project as it was, and the error names the file. A file move also checks first that its two directories take the change. These are checks ahead of the work and no transaction: a disk that fills up half way still leaves a refactoring half done.

The calls for one project run one at a time, in the order they arrive, whether they come from one client or from several clients of an HTTP server. Two servers that work on the same project know nothing of each other, so do not let two of them refactor at once.

When the harness closes the server's input, the server answers the requests it has already received, stops its language servers and exits.

### Known limitations

- **Columns on lines with non-ASCII text.** The language server counts columns in bytes. On a line with a non-ASCII character before the symbol, a column in a result is larger than the count of characters by the extra bytes: in `"café " ++ formatName name`, `formatName` is at column 12 and not at 11. Pass a column to a tool as a result gave it. A column you count yourself has to count UTF-8 bytes too, so pass 12 for `formatName` there. Edits land where they belong, on such a line as on any other. `elm_diagnostics` is the exception: it prints the line and the column of the compiler's own report, which count from 1 and by characters.
- **Linked directories.** A directory below a source directory that is a link to another directory is not followed, though the compiler follows it. The modules behind it are not in the index, and a rename passes them over. A link to a single file is followed.
- **Source directories outside the project root.** A refactoring that starts inside the project changes the files in a directory such as `../shared` too. A call cannot name a file there itself, because the project is found from the path of the file a call names, and that path leads to no `elm.json`. Two projects that share such a directory are not kept from refactoring it at the same time.
- **What a moved function leaves behind.** `elm_move_function` moves the function, updates calls with qualifiers, aliases or `exposing (..)` to point at the new module, imports the function into the old module only where the old module still calls it, and carries the names the function uses through the new module's imports or new plain `import M` lines, which its answer lists. It refuses, changing no file and naming the place and reason, any move that would close an import cycle, also through a third module, that uses a name the old module does not expose or an operator no import of the destination gives, that would clash with a name in the destination, or that updates a record the destination can name only with a qualifier. An import in a caller that listed nothing else stays as `import Utils`, and other imports left unused stay as they are. It also rewrites the exposing list in a copy of a module, which the other refactorings leave alone. In a package, the `@docs` lines of both modules stay as they were, and only `elm make --docs` reads them. In a module without imports, the only doc comment above the first declaration moves with that function when the function starts right below it, though the compiler reads the comment as the module's. The word `@docs` anywhere in it keeps it in the module, as in `{-| @docs a, b -}`, and so does a blank line below it, which `elm-format` writes there. Run `elm_diagnostics` on the project's entry module afterwards, and for a package run `elm make --docs=docs.json` as well, which writes that file.
- **Cross-file `elm_definition` with shared names.** `elm_definition` still looks up a cross-file name without the module it belongs to, so where `Aaa`, `Other` and `Utils` each declare `helper`, asking for the definition at `Other.helper` can return the one in `Aaa`. Look at the path of such an answer before you rely on it. `elm_references`, the rename tools, `elm_move_function`, `elm_add_variant`, `elm_remove_variant` and `elm_remove_field` resolve names by module and scope and leave namesakes alone.
- **Type inference limits for field tools.** `elm_rename_field`, `elm_references` on a field, `elm_prepare_remove_field` and `elm_remove_field` decide which record each use belongs to by whole-project type inference in `src/field_inference.rs`. Every field of a record type gets a slot, and unification joins matched slots, so a generic function over `{ a | title : String }` ties together every record passed to it. Package types come from the compiler's package cache, honouring `ELM_HOME`. Inference covers annotations and aliases with parameters, extensible and nested records, custom types, record aliases used as constructors, `let` bindings generalized per mutually recursive group, lambdas, all pattern forms, operator precedence, qualified names, import aliases, exposing lists and default imports. It stops at `glsl` blocks, kernel code, packages missing from the cache, top-level mutually recursive functions without annotations, which stay monomorphic, and `number` and `comparable`, which it treats as plain type variables. A use in a module that does not compile blocks the field tools. Where another alias or a package record shares the field, where code using the field cannot be typed, or for rename where the new name exists on such a record or as a variable at a renamed pattern, the tool refuses with the place and the words "not possible" and changes nothing.
- **Test modules of a package.** `elm_diagnostics` builds application test modules under `tests/`, and gives no verdict on a test module of a package because `elm-test` picks the versions of a package's `test-dependencies`.
- **Lines the parser does not read.** The language server reads a file with tree-sitter-elm, which does not know every layout that the compiler accepts. One is a `case` in parentheses that close on the line of its last branch, which `elm-format` never writes. From such a declaration on, and around a syntax error in a file that is being edited, `elm_symbols` can lack declarations. `elm_move_function` does not move a function that such lines reach, or the first one below them. It names the lines, because it cannot tell where the function begins and ends. A function above them moves. Where a line of its body starts in the first column, the parser ends the function above that line, as the compiler does, and the rest of the body stays behind. `elm_format` lays out a file that compiles in a way the parser reads. The language server also pairs a type signature with a definition by their name, wherever in the file the two stand. Where a signature stands apart from its definition, or a file defines a name twice, `elm_symbols` gives that function the lines of the declarations in between. `elm_move_function` then moves nothing where `elm_symbols` lists one of those declarations, and takes along the ones it does not list: in `view : Int -> Int`, then `helper : Int` with no definition, then `view n = n`, moving `view` takes `helper : Int` with it. Where the signature stands below its definition, the tool moves nothing either, and names the line of the signature.
- **A build that takes longer than 30 seconds.** The wrapper waits 30 seconds for each answer of the language server, and the language server runs the compiler before it answers `elm_diagnostics`. A longer build, a first one that downloads packages for one, fails the call with an answer that says so, and the compiler goes on running. The MCP server keeps its language server, which answers no other call for that project until the compiler ends. The calls that wait in line behind the build and ask the language server fail one after the other, each after 30 seconds of its own, with an answer that says that the compiler of an earlier `elm_diagnostics` call is still running. `elm_format` asks the language server nothing and is answered in its turn, though a harness that gives up on a call sooner, as the MCP SDK's client does after 60 seconds, reports it as failed all the same. Make the call again once the build is done. The command line stops its language server when the command ends, and the compiler goes on in the background without it. A later command starts a language server of its own and is not held up. An `elm_diagnostics` among such commands starts a second compiler beside the first, so wait for the first one to end before you ask for diagnostics again.
- **Lines that end in CRLF.** A line that a tool adds ends in LF, also in a file whose lines end in CRLF. `elm_move_function` takes the lines of a function to the target with the line ends they had, so a function from such a file leaves lines that end in CRLF in a file whose lines end in LF. The lines that the tool adds around it, the import that it adds to the old module and the blank lines where the function stood end in LF. Both files still compile. `elm_add_variant`, and the import that `elm_apply_code_action` adds, break their lines with LF in the same way, and the file compiles as well. `elm_format` writes a whole file with LF.
- **Windows.** File paths and the setup script assume a POSIX system.

## Features

| Feature | Description |
|---------|-------------|
| **Go to Definition** | Jump to symbol definitions |
| **Find References** | All usages across workspace |
| **Rename** | Safe rename across all files (functions, types, variants, fields) |
| **Document Symbols** | List all symbols in a file |
| **Diagnostics** | Compiler errors via `elm make` / `lamdera make` |
| **Formatting** | Via `elm-format` |
| **Code Actions** | Quick fixes and refactorings |
| **Move Function** | Move function to another module with import updates |
| **File Rename/Move** | Rename or move Elm files with module/import updates |
| **Add Variant** | Add variant to custom type with auto case branch updates |
| **Remove Variant** | Smart union type variant removal |
| **Remove Field** | Remove field from type alias with usage updates |
| **ERD Generation** | Generate Mermaid diagrams from types |

### Smart type operations

**Renames.** `elm_rename_function`, `elm_rename_type` and `elm_rename_variant` leave namesakes in other modules, on other types and in packages alone. They refuse, with file and line, a new name that a local binding would hide, that would clash with a declaration or import where the renamed symbol is used, or that an existing use of the new name would come to mean. `elm_rename_function` also refuses a new name that a local variable already uses anywhere in the declaring module, because Elm forbids that shadowing. A new name appearing only in a comment, string, field or type variable of the declaring file is accepted. `elm_rename_type` keeps a variant called like its type and renames a record alias's constructor along with the alias. `elm_rename_file` and `elm_move_file` find qualified uses in the syntax tree, leave strings, comments and `src/Evergreen/` alone, and update `exposed-modules` in `elm.json` in both list and titled-group forms.

**Add variant.** `elm_add_variant` inserts the variant behind the last variant, past comments, and adds a branch to each `case` on the type that lacks a catch-all, taking the qualifier of the first branch on the type and adding one wildcard per variant argument. A `case` on a tuple or `Maybe` gets a branch such as `( It, _ )` or `Just It`, or none where a catch-all covers those values. No branch goes into a `case` on another type that shares a variant's name. The tool changes nothing and names the places when a `case` matches the type inside a list or cons pattern, when whether a partly covered position needs a branch depends on a type it cannot list, such as a number or string, or when a pattern outside a `case` takes apart a single-variant type.

**Remove variant.** `elm_remove_variant` removes the variant, removes every `case` branch whose pattern names it and every branch that would then match nothing, and replaces constructor uses with `Debug.todo`. It refuses, changing nothing and naming the place, when removing the only variant, when a pattern outside a `case` names the variant, or when a branch shares its line with other code. `elm_prepare_remove_variant` fails with an error when it cannot read the project.

**Remove field.** `elm_remove_field` uses whole-project type inference to remove the field from the type alias, record literals, record updates and record patterns, turning a single-field update into its base record and a single-field pattern into `_`. Reads, accessors and variables bound by record patterns become `Debug.todo`, and `elm_prepare_remove_field` counts those pattern variables on their own line. Both tools refuse, changing nothing and naming the place, where another alias or package record shares the field, where the alias is called as a constructor, where the field is the only one using a type variable of the alias, or where code using a field of that name cannot be typed.

## MCP tools (22 total)

| Tool | Description |
|------|-------------|
| `elm_definition` | Go to definition |
| `elm_references` | Find all references |
| `elm_symbols` | List file symbols |
| `elm_diagnostics` | Get compiler errors for a file and what it imports |
| `elm_code_actions` | Get available actions |
| `elm_apply_code_action` | Apply a code action |
| `elm_format` | Format file |
| `elm_rename_variant` | Rename a variant |
| `elm_rename_type` | Rename a type |
| `elm_rename_function` | Rename a function |
| `elm_rename_field` | Rename a record field |
| `elm_move_function` | Move function to module |
| `elm_rename_file` | Rename an Elm file |
| `elm_move_file` | Move an Elm file |
| `elm_notify_file_changed` | Notify LSP of external file changes |
| `elm_prepare_add_variant` | Check what adding a variant would affect |
| `elm_add_variant` | Add variant with auto case branch updates |
| `elm_prepare_remove_variant` | Check what removing a variant would affect |
| `elm_remove_variant` | Remove variant with auto pattern removal |
| `elm_prepare_remove_field` | Check what removing a field would affect |
| `elm_remove_field` | Remove field from type alias |
| `elm_generate_erd` | Generate Mermaid ERD from type |

## Building from source

```bash
cd elm-lsp-rust
cargo build --release --locked

# Binary at: target/release/elm_lsp
```

## Shared MCP server (manual HTTP)

Run one MCP server yourself and point multiple sessions to it.

```bash
/path/to/elm-lsp-rust/scripts/setup.sh
node /path/to/elm-lsp-rust/mcp-wrapper/index.mjs --http --host 127.0.0.1 --port 3333
```

Claude Code config example (in `~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "elm-lsp-rust": {
      "type": "http",
      "url": "http://127.0.0.1:3333/mcp"
    }
  }
}
```

Notes:
- Sessions share one language server per Elm project.
- Disable the stdio server entry to avoid duplicates.
- On a loopback address, which is the default, the server refuses a request whose `Host` or `Origin` names another site. That is how a web page in a browser on the same machine would reach it. On any other address it answers every client that can connect, and the tools write files, so bind it only on a network you trust.

## Architecture

```
elm-lsp-rust/
├── .claude-plugin/
│   └── plugin.json       # Plugin metadata for marketplace
├── src/
│   ├── main.rs            # Entry point
│   ├── server.rs          # LSP protocol (tower-lsp)
│   ├── field_inference.rs # Whole-project type inference for field tools
│   ├── workspace/         # Indexing, name resolution, symbols, refactoring
│   ├── document.rs        # Single file representation
│   ├── parser.rs          # Tree-sitter parsing
│   └── diagnostics.rs     # Elm compiler integration
├── mcp-wrapper/           # Agent-facing layer (Node.js)
│   ├── tools.mjs          # The tools, defined once
│   ├── move-function.mjs  # elm_move_function, applying the server's move plan
│   ├── index.mjs          # MCP server over stdio or HTTP
│   ├── cli.mjs            # Command-line interface
│   ├── doctor.mjs         # The checks of cli.mjs doctor
│   ├── lsp-client.mjs     # Runs the Rust binary, one per Elm project
│   ├── workspace.mjs      # Finds a file's project, writes edits
│   ├── errors.mjs         # ToolError, a failure the agent can act on
│   └── harnesses.mjs      # Registration for each harness
├── docs/                 # Harness configuration, agent install guide
├── scripts/
│   └── setup.sh          # Builds the language server
├── skills/               # Agent skill
├── benchmarks/           # Agent refactorings with the server and without it
└── tests/                # Test suites
```

### Key design decisions

1. **Workspace Indexing**: Indexes all `.elm` files at startup for immediate cross-file operations
2. **Tree-sitter Parsing**: Fast, incremental, error-tolerant parsing
3. **Compiler Diagnostics**: Uses `elm make --report=json` for 100% accurate errors
4. **Evergreen Exclusion**: Skips `src/Evergreen/` migration files in refactoring

## Testing

```bash
# Once per clone: the suites' own dependencies
(cd tests && npm ci --ignore-scripts)

# Tools and language server, against the fixture and a real project
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs

# MCP server, command line, harness configuration and the benchmark
node --test tests/*.test.mjs
```

The suites need `elm` 0.19.1 and `elm-format` on `PATH`, and Node.js 20.4 or newer, two major versions past what the server itself needs. The meetdown suite also needs `lamdera`. The benchmark's tests, which the last command runs with the others, need `git` and a `ps` that lists the machine's processes. They take a few minutes, and longer on a slow network, since the real compiler asks package.elm-lang.org again in each fresh checkout that they build.

Tests cover: definition, references, symbols, rename (functions, types, variants, fields), diagnostics, code actions, move function, file rename/move, add/remove variant, add/remove field, and ERD generation.

## Benchmark

`benchmarks/` measures what the tools are worth to an agent and tests the tools directly on real codebases. It plans ten kinds of Elm refactoring across target sizes with `--levels`, widens check commands with `entries`, runs a tool-only pass with `probe` without starting an agent, and gives Claude Code the same tasks with the language server and without it to compare solve rate, cost and time. See [benchmarks/README.md](benchmarks/README.md).

## Related

- [elm-lsp-plugin](https://github.com/CharlonTank/elm-lsp-plugin) - Marketplace that distributes this plugin
- [elm-language-server](https://github.com/elm-tooling/elm-language-server) - Original TypeScript LSP
- [tree-sitter-elm](https://github.com/elm-tooling/tree-sitter-elm) - Elm grammar
- [tower-lsp](https://github.com/ebkalderon/tower-lsp) - Rust LSP framework

## Issues

Report bugs at: https://github.com/CharlonTank/elm-lsp-rust/issues
