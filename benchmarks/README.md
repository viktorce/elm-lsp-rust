# Benchmark: Elm refactoring with and without the language server

Does a coding agent get Elm refactorings right more often, faster or cheaper when it can call this language server? This benchmark runs the same refactoring tasks in two arms, the two conditions compared on the same work: `baseline` without the language server and `lsp` with its MCP tools. It runs sessions in any of three harnesses, the command-line programs that drive a coding agent: Claude Code, the Codex CLI or the Antigravity CLI. Each task asks for a refactoring on one target, a symbol, module or file chosen in a codebase, at a level, a number of files that the target is asked to involve.

It runs on an Elm codebase whose check command, the command that succeeds when the project compiles, keeps to the [check command rules](#check-command-rules). A project whose check command generates Elm sources cannot be benchmarked. The `entries` command widens a check command so that it compiles modules nothing imports. The `probe` command runs a tool-only pass, calling the language server's tools directly on many targets with no agent. The `compare` command puts several runs side by side on one page. Nothing about a codebase is written into this repository. The plan, the transcripts, the run records and the probe records stay in the output directory, and the reports show counts and measurements only.

[The probe](#the-probe) has the results of the tool-only passes on three codebases. [A run on three codebases](#a-run-on-three-codebases) has the results of the first agent run, before levels and the four newer task types existed. [Runs with levels in three harnesses](#runs-with-levels-in-three-harnesses) has the results of six models in Claude Code, the Codex CLI and the Antigravity CLI on the plan with levels.

## Before your first run

- `run` needs Claude Code, the Codex CLI or the Antigravity CLI on `PATH`, signed in, a `ps` that lists the machine's processes and, for the `lsp` arm, the language server built with `scripts/setup.sh`. `probe` needs the built language server and starts no agent. `entries`, `plan`, `report` and `compare` start no agent either. [What a run looks like](#what-a-run-looks-like) has the details.
- Every session that `run` starts uses your API or subscription quota. In Claude Code, a session stops once it passes `--max-budget-usd`, which defaults to 5 dollars, though a session can go past that limit by the turn that crosses it. Codex reports no cost, so only `--timeout-min` holds its sessions. Antigravity reports no cost and counts tokens as a session goes, so `--max-tokens` and `--timeout-min` hold its sessions. Try one task in one arm first, with `--levels`, `--only` and `--arms`, as [What a run looks like](#what-a-run-looks-like) shows. `entries`, `plan`, `report`, `compare` and `probe` cost nothing.
- Each session, plan, `entries` pass and `probe` pass works in a `git worktree` of its own and not in your checkout, though the paths under `link` are your own directories. The benchmark's own git commands add nothing to your repository but those worktrees, which they remove again. They skip its hooks and stage nothing, and the benchmark never prunes your repository's list of worktrees. A session runs shell commands as your user without asking, so run the benchmark on code you trust. [What a session can touch](#what-a-session-can-touch) says what a session shares with your repository and machine.
- The plan, the transcripts, the records, `run.json`, the probe output and the report go into the output directory. The checkouts and the per-session home or settings directories of Codex and Antigravity lie among the system's temporary files. Claude Code can keep the output of a session's tools under `~/.claude/projects/`, as [What a session can touch](#what-a-session-can-touch) says.
- What a codebase and its check command have to be is in [The config](#the-config) and the [check command rules](#check-command-rules). What a run cannot measure is in [What it does not tell you](#what-it-does-not-tell-you).

## What a run looks like

```bash
mkdir -p benchmarks/out
cp benchmarks/config.example.json benchmarks/out/config.json    # then edit it
node benchmarks/bench.mjs entries --config benchmarks/out/config.json --out benchmarks/out
node benchmarks/bench.mjs plan    --config benchmarks/out/config.json --out benchmarks/out
node benchmarks/bench.mjs run     --config benchmarks/out/config.json --out benchmarks/out --repeat 3
node benchmarks/bench.mjs report  --out benchmarks/out
open benchmarks/out/report.html
```

To compare several runs of the same plan, each in its own output directory, run `compare`:

```bash
node benchmarks/bench.mjs compare --out benchmarks/out/compare benchmarks/out/run-a benchmarks/out/run-b
open benchmarks/out/compare/comparison.html
```

To test the language server's tools directly on many targets without starting an agent, run a tool-only pass with `probe`:

```bash
node benchmarks/bench.mjs probe   --config benchmarks/out/config.json --out benchmarks/out
```

git ignores `benchmarks/out/`, so a config kept there, which names your codebases and where they are, stays out of this repository like everything else about them.

`run` takes `--harness claude-code|codex|antigravity`, with `claude-code` as the default. `--agent <path>` names the harness's executable, defaulting to `claude`, `codex` or `agy`. Each harness needs its CLI on `PATH`, signed in, and a `ps` that lists the machine's processes. While sessions of the `lsp` arm are left to do, `run` also needs the language server built with `scripts/setup.sh`.

A run is one model in one harness inside one output directory. Two harnesses or two models belong in two output directories. `--model` defaults to `claude-opus-5-5` in Claude Code and has no default in Codex or Antigravity, so those two require `--model`. `--effort` accepts `low`, `medium`, `high`, `xhigh` or `max`, and defaults to the harness's own effort for the model. For Codex, `run` checks `--effort` against the levels that the model's catalog lists before starting any session. In Claude Code, passing `--effort` sets both `--effort` and `CLAUDE_CODE_EFFORT_LEVEL`, which takes precedence in a session, and omitting it passes neither. Claude Code sessions never inherit `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`, `CLAUDE_CODE_MAX_EFFORT_REMINDER`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_DISABLE_THINKING`, `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`, `DISABLE_INTERLEAVED_THINKING` or `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from your shell. Claude Code 2.1.311 reads those variables to control thinking and output length. A later version may add variables that reach sessions until someone adds them to that list. `node benchmarks/bench.mjs --help` lists every command and option.

`plan --levels <list>`, with `10,50,100` as the default, picks one target per task type, codebase and level, and writes `levels`, each task's requested `level` and its target's `files` into `<out>/plan.json`. Each task gets the id `<label>/<task type>/<level>`, and each session writes its record, transcript and patch under `<label>--<task type>--<level>--<arm>--<repetition>` with `.json`, `.jsonl` and `.patch` in `<out>/runs/`. Each run record holds both `level` and `files`.

Each `--repeat` repetition of a task in both arms is one round, and the two sessions of a round form a pair. `run` starts one session per task, arm and repetition, and before them the one short session of the isolation check in [Keeping your own setup out](#keeping-your-own-setup-out). `entries`, `plan`, `report`, `compare` and `probe` start no session. Every session stops at `--timeout-min`, 20 minutes unless set. Claude Code sessions also stop at `--max-budget-usd`, 5 dollars unless set. Passing `--max-budget-usd` with Codex or Antigravity is a usage error. Antigravity counts tokens over every finished step, including cache reads in input plus output, so `--max-tokens` holds its sessions. Passing `--max-tokens` with Claude Code or Codex is a usage error. To try a run small first, `--levels 10` runs the tasks of that level alone, `--only rename-function` runs every level of that task type, and `--arms baseline` runs one arm. `run --levels <list>` refuses any level that the plan lacks.

What `run` holds a run to, and how it resumes:

- `run` takes a plan only from the state of the benchmark's code that made it, and asks for a new plan after a change to that code.
- `run` can be stopped and started again. It keeps the record of every finished session and runs only the ones that are missing.
- Every session starts from the commit the plan was made on, even when `ref` has moved since.
- The first `run` writes its harness, model, effort, limits, agent version and benchmark code state to `<out>/run.json`, and refuses a later run that differs, because its sessions would be compared with the ones on record. A run without `--effort` is held to its harness's default, so a later run with `--effort` is refused as well. A run with sessions of the `lsp` arm left to do also writes the language server's version and source state, plus `serverSettings` where the harness configures extra MCP server options, as Codex does. A later run is held to that server and those settings from the first recorded `lsp` session on. A run before that is held to none, and so is a run after an `lsp` run that recorded nothing, as when its first session lost the API. A run with no `lsp` sessions left needs no server, skips the server check, and leaves the server in `run.json` intact for later `lsp` runs.
- A harness can update itself between two runs or while a run is under way. A session that reports another version of its harness than the run began with stops the run, so keep one version installed until a run finishes. The benchmark turns off automatic updates in every harness: `DISABLE_AUTOUPDATER=1` in Claude Code, `check_for_update_on_startup=false` in Codex, and `AGY_CLI_DISABLE_AUTO_UPDATE=true` in Antigravity.
- The state of the code is the last commit that changed `benchmarks/bench.mjs`, `benchmarks/lib/` or one of the modules of `mcp-wrapper/` that the benchmark imports, `doctor.mjs`, `errors.mjs`, `harnesses.mjs`, `lsp-client.mjs`, `move-function.mjs`, `tools.mjs` and `workspace.mjs`, with a digest of what is not committed there. The state of the language server's sources is read the same way.
- A run is not held to the time the server's binary was built, because `run` does not start the `lsp` arm with a binary that is older than the files that cargo lists beside it as its sources, so a build of the same sources is the same server. That check reads the Rust sources alone. A change to `Cargo.toml` or `Cargo.lock` that was not built is not seen, so run `scripts/setup.sh` after one. `run` also refuses the `lsp` arm where cargo's list is missing, or names no file that is still there, as after the checkout was moved, because then nobody knows what the binary was built from. `scripts/setup.sh` writes that list.
- Before the isolation check and the first session, a run with `lsp` sessions left starts the binary once and asks it what every tool call asks, as `node mcp-wrapper/cli.mjs doctor` does. It stops with the doctor's report when a check there fails. It then starts the MCP server the way a session of the arm gets it, the same command with the same environment, and asks it for its tools. A server that does not start, does not answer within ten seconds or lists no tool stops the run before the isolation check, since a `node` on `PATH` that is too old for the wrapper would otherwise cost every session of the arm. The wrapper starts the binary only at a session's first tool call, so a binary that cannot start would make each session of the arm a baseline whose tool calls fail. An `elm` or `elm-format` that is missing from `PATH` is a warning there and does not stop the run, since a codebase can pin its own.
- Each session of the `lsp` arm starts the server afresh from this checkout, so leave the checkout as it is while a run goes on. Build nothing there, and edit neither the server's sources nor `mcp-wrapper/`. `run` checks the server again before each of those sessions and once each has ended, since the wrapper starts the binary at a session's first tool call and again after ten idle minutes. A difference from the server it began with stops the run without a record for the session that was about to start or had just ended, and leaves no transcript or patch of it.
- A config whose `elmRoot`, `check`, `checkTimeoutMs` or `link` is no longer what the plan was made with is refused as well, since the prompts name the check command and its time limit decides whether a slow build passes.
- To plan again, use a new output directory: `plan` refuses one that holds records, because they are matched to tasks by name.

## The config

```json
{
  "codebases": [
    {
      "label": "My app",
      "repo": "/absolute/path/to/repository",
      "elmRoot": ".",
      "ref": "HEAD",
      "check": ["./node_modules/.bin/elm", "make", "src/Main.elm", "--output=/dev/null"],
      "link": ["node_modules"]
    }
  ]
}
```

| Key | Meaning |
|-----|---------|
| `label` | The name the plan and the report use for this codebase. It names files in the output directory too, so two labels have to differ in more than upper and lower case |
| `repo` | A git repository. A relative path is relative to the config file |
| `elmRoot` | The directory with `elm.json`, relative to `repo`. Default `.`, the repository's root. On a file system that ignores letter case, `Client` for a directory `client` is read as the disk spells it, and so is each source directory of `elm.json` |
| `ref` | The commit to benchmark. Default `HEAD`. Uncommitted changes are never part of a run |
| `check` | A command, run in `elmRoot`, that succeeds when the project compiles. The [check command rules](#check-command-rules) say what it has to name and what it must not name or write |
| `link` | Untracked paths under `elmRoot` that a fresh checkout needs, usually `node_modules`. Each one is linked, not copied, so a session that installs packages changes your directory. A path that holds Elm sources of the project is refused, because a session would edit your files through it. So is a path outside `elmRoot` or behind a link that leads out of it, because its place in a checkout would not be in the checkout. So is `elm-stuff`, or a path in it, because every session's builds would write your own compiler cache through the link and sessions that run at the same time would share one. Each checkout builds its own. On a file system that ignores letter case, each path is read as the disk spells it, so `Elm-Stuff` is refused like `elm-stuff` |
| `checkTimeoutMs` | How long one run of `check` may take, in milliseconds. Default 600000, which is ten minutes. A run that takes longer counts as a check that fails |

Every source directory of `elm.json` has to lie inside `elmRoot`. The benchmark reads a session's changes from git in the whole checkout, and a change to a tracked file beside `elmRoot`, a README or a script of the repository, counts against the session like any change it was not asked for.

## Check command rules

- It has to name the Elm files it compiles, as `src/Main.elm` above, because the benchmark works out from them which modules the compiler reads. Each of them has to be a word of its own. One that is named inside a longer word, as in the script of `["sh", "-c", "elm make src/Main.elm"]`, does not count.
- It must not pass `--optimize`, which rejects the `Debug.todo` three tasks ask for.
- It must name no path inside the repository by its whole path, also behind an option such as `--output=`, in the script of `sh -c` and through a link that leads into the repository, to a file that does not exist yet as well, because a session works in a checkout of its own and the command would run or write your copy. The benchmark tells a directory by what it is, so a path in another letter case on a file system that ignores case, one with an accented name in the other Unicode form, or one under `/System/Volumes/Data` on macOS is refused like the plain one. Name the compiler as `./node_modules/.bin/elm` and list `node_modules` under `link`.
- It must write no file that the repository holds, a committed bundle for instance. A changed file of that kind counts against a session, so a session that ran the command would be judged differently from one that did not, and `plan` stops when the command writes such a file, also when it writes the bytes that are there. A build that writes its output only once the sources have changed, as `make` does, is not caught that way, so make sure of it yourself.
- It must write no Elm source either, whatever the text, because such a file counts against a session in the same way. A generated module can hold a digest of another module or what `git describe --dirty` prints, and then a session's edits change it and an unchanged checkout does not. `plan` stops when the first build of a fresh checkout writes an Elm file, and when a second build of the unchanged checkout writes one that the first did not. So a project whose check command generates Elm sources cannot be benchmarked. Commit what the generator writes, and leave the generator out of `check`. `--output=/dev/null` writes none.
- The benchmark reads the words of the command and cannot see a path that a script builds as it runs, from `$HOME` or `~` for one, or a path in a script file that the command names, so make sure that none of those leads into the repository.
- It reads a path with a space in it, as under a directory called `My Projects`, also behind an option and in the script of `sh -c`, where the shell needs such a path in quotes. It does not see a space written as `\ `, a path whose quotes end in the middle of it, as in `--output="/x/My Stuff"/app/x.js`, or a path behind `@`, as in `@/x/app/args.txt`, so make sure of such a path yourself.

### Widening a check command

A check command that names a single entry file leaves every module nothing imports uncompiled. Because `plan` leaves out any target that involves an uncompiled file, a narrow check command holds back large targets. The `entries` command finds modules that can be added to `check`:

```bash
node benchmarks/bench.mjs entries --config benchmarks/out/config.json --out benchmarks/out
```

For each codebase, `entries` opens a checkout of its own as `plan` does, finds every module that the check command does not compile and that no non-test module imports, runs the check command once for each with that module in place of the entry files, and keeps the ones that compile. It then runs the check command once with all kept modules added and says whether that build passes. It prints how many modules the command compiles before and after, how many candidates failed to compile on their own, and the `check` array to paste into the config.

- Modules under `tests/` do not compile with `elm make`. `entries` leaves them out and prints how many they are, noting that `check` can build them with a test runner.
- A check command that names no Elm file as a word of its own cannot be widened this way. `entries` says so and moves on to the next codebase.
- Where modules each compile alone and fail together, `entries` says so and does not offer the array as fit for the config.
- `entries` takes `<out>/lock` and uses `<out>/work` like `plan`, and handles interrupts in the same way.

A check command that builds tests alongside `elm make` can be written as one command with the entry files as words of their own:

```json
["sh", "-c", "./node_modules/.bin/elm make \"$1\" --output=/dev/null && shift && ./node_modules/.bin/elm-test make --compiler ./node_modules/.bin/elm \"$@\"", "sh", "src/Main.elm", "tests/A.elm", "tests/B.elm"]
```

`plan` accepts this form, and every file named as a word counts as an entry.

Measured on the three real codebases A, B and C, a check command that named one entry file left 132, 25 and 94 modules uncompiled, and the largest usable module rename involved 45, 37 and 113 files. With the modules that compile on their own added, 83 in A and 59 in C, and with B's 25 test modules built by a test runner, the largest usable module rename involved 220, 90 and 159 files.

## The tasks

`plan --levels <list>`, with `10,50,100` as the default, picks one target per task type, codebase and level. A level is a number of files that a target involves. `--min-files`, 5 unless set, sets the fewest files any target may involve.

For each task type and codebase, over the targets that pass every filter, `plan` picks targets by these rules:

- The top level takes the smallest target at or above the highest number. Where none reaches it, the top level takes the largest target there is.
- The bottom level takes the target nearest to the lowest number, among targets smaller than the top level's target.
- A level between them aims at its own number where that is below the size of the top level's target. Where it is not, its aim is spaced by ratio between the sizes of the bottom target and the top one, by the level's place among the levels.
- A level between them takes no target that lies nearer, by ratio, to a neighbour's target than to its own aim. Sizes 10, 11, 12 and 300 give two levels, 10 and 300.
- Each level's target involves fewer files than the one above and more than the one below. A level that cannot get such a target is left out, so a task type whose targets are all small ends up with two levels or one.
- With one level alone, that level follows the top level's rule.

Four task types, `add-variant`, `move-function`, `remove-variant` and `remove-field`, require a trial build before `plan` takes a target. `plan` builds each candidate target once whichever level tries it, and each level gives up after five targets tried in vain. For a task type that gets some levels and not all, `plan` prints which levels it got with their file counts, which levels it missed, its largest target, any trial failures, and where uncompiled files hold larger candidates back, the uncompiled file that holds back the most and a pointer to `entries`.

Which files a target involves depends on the task:

- For `rename-module`, the files that import the module.
- For `rename-function` and `rename-shared-function`, the importers that name the function, through the module's name or alias, or bare where the import exposes it.
- For `rename-variant`, the importers that name the variant, qualified or bare where the import takes the type's variants along. A variant called like its own type, as in `type Email = Email String`, is no target, because the tokens of a use do not tell the type from the variant.
- For `rename-type`, the importers that name the type, qualified or bare where the import exposes it by name, with `(..)` or with everything.
- For `rename-field`, the importers of the record's module that name both the record alias and the field.
- For `add-variant`, the files with a branch on one of the type's variants, the declaring file among them, and that file alone where its module keeps the variants to itself. That count is an upper bound of the files the task changes, since a case that ends in a catch-all needs no new branch.
- For `move-function`, the modules other than the source module that call the function or list it in their import of the source module.
- For `remove-variant`, the files that the removal changes, the declaring file among them, plus each importer that names the variant through the module's qualifier or bare where its import takes the type's variants along.
- For `remove-field`, the files that read the field or build or update a record with it, the declaring file among them.

No other file can name a function, type or variant that its module does not expose, so such a one involves no file and is no target for rename. Functions are found by their type annotations, so a function without one is no target and no namesake.

A function, type, variant or field is a target only when its name has four letters or more. A shorter one is too often the name of something else in the same files, which the comparison of tokens cannot tell from it. For renames and removals, a target whose new name, the old one with `Renamed` behind it, stands anywhere in the project's code already is no target either, since the renamed target could clash with it. That holds for a function without a type annotation, a record alias and a local variable alike, and for a module where the last part of its new name stands there. A module is no target where anything lies at the path of its new file already, because the move would write over it. That holds for a file without a module line, which the benchmark does not read as a module, and for a link whose end is gone. On a file system that ignores letter case, it holds for a name that differs in case alone. In a Lamdera project, `plan` leaves out the four modules Lamdera looks for by name, `Env`, `Types`, `Frontend` and `Backend`, for `rename-module`, and the six types Lamdera looks for in `Types`, `FrontendModel`, `BackendModel`, `FrontendMsg`, `BackendMsg`, `ToBackend` and `ToFrontend`, for `rename-type`.

A target is only taken when the check command compiles its file and every file the change can break. The compiler says nothing about a module it never reads, so a reference left behind in one would pass. In practice that leaves out whatever your test modules import, unless `check` builds the tests too. `plan` prints how many of the project's modules the check command compiles. When a task type ends up without a target, it names the uncompiled file that held back the most candidates and says how many more such files there are. A Lamdera app has many: the snapshots and migrations under `src/Evergreen/` name the app's types and fields, and a check that builds `Frontend.elm` and `Backend.elm` compiles none of them. Most of its fields and many of its functions are no targets for that reason.

The benchmark reads the modules in the source directories of `elm.json` and in `tests/`. An Elm file anywhere else under `elmRoot`, such as an example with an `elm.json` of its own, can import the same modules, and no check compiles it. A target that such a file can use is left out, and `plan` prints how many those were. For `move-function`, an Elm file outside the project that imports the destination excludes the target too.

A source file can be a link to another file of the project, `src/Lib.elm` to `shared/Lib.elm`. git reports a change to it under the name of the file the link leads to. A target that involves such a file is left out as well, and `plan` prints how many those were.

For `rename-field`, `plan` also leaves out a field that an extensible record type names anywhere in the project, `{ a | name : String }`. A function with such a type takes every record that has the field, so the field cannot be renamed on one of them alone.

| Task | The agent is asked to | Solved when the project compiles and |
|------|----------------------|--------------------------------------|
| Rename function | rename a function whose name no other module declares | the module declares the new name and not the old one, and only files that import the module changed |
| Rename function, shared name | rename a function whose name at least three other modules also declare | as above, and the other modules still declare theirs |
| Rename variant | rename a variant of a custom type | the type has the new variant and not the old one, other types with a variant of that name still have theirs, and only files that import the module changed |
| Rename field, shared name | rename a record field whose name at least two other records also have | the alias has the new field and not the old one, and the other records still have theirs |
| Rename module | rename a module and move its file | the old file is gone, the new file declares the new module, nothing imports the old name, and only its importers changed. A type of the module's own name keeps that name |
| Add variant | add a variant as the last one of a custom type with three variants or more, and a `Debug.todo` branch for it wherever the compiler asks | the variant is the last of its type, no other type got the variant, every changed line is the variant, a branch that names it or the branch's body, which is `Debug.todo` with a string literal, and only files that import the module changed. A catch-all branch or a rewritten one fails. `plan` only accepts a type where adding the variant breaks the build |
| Rename type | rename a custom type or a type alias `T` to `TRenamed` and update every place that names it | the file declares `TRenamed` and not `T`, other modules' types called `T` still exist, every variant called `T` still exists with the type's own now on `TRenamed`, and only the module and its importers changed |
| Move function | move a function and its annotation from source module `S` to destination module `D`, with every import change spelled out | `D` declares the function and `S` does not, `S`, every user and `D` outside the function match the plan's move token by token, the function in `D` keeps its tokens once qualified names are read as whole module names, and only `S`, `D` and the users changed |
| Remove variant | remove a variant from a custom type, remove every `case` branch that matches on it, and replace every other use with `Debug.todo` | the type no longer has the variant, every changed file matches the plan's removal token by token with `Debug.todo` messages, brackets and `<|` free, and every other changed Elm file keeps its tokens |
| Remove field | remove a field from a record type alias, remove it from record literals and updates, and replace every read or accessor with `Debug.todo` | the alias no longer has the field, every changed file matches the plan's removal token by token with `Debug.todo` messages, brackets and accessor lambda argument names free, and every other changed Elm file keeps its tokens |

Every request ends with "Change nothing else", so the verdict holds a session to nothing that the request leaves unsaid.

For each of the six renames, every changed Elm file is also compared with what it was, token by token. Apart from layout and comments, only the name may differ. A text replace that reaches into a string literal changes what the program says, and it fails here while the compiler lets it through. The module line and each import are compared on their own, in any order, so an alias that moved from one import to another fails too.

Where the name may differ depends on what is renamed:

- A function's name changes in the code and in what a module line or an import exposes.
- A type's name changes in the code only where no dot follows it, and in a module line or an import only inside the exposing list. A module called `T` and an import alias `as T` keep their names, and so does a variant called `T`, the type's own included, which stays on `TRenamed`. Where a namesake variant or another module's type of the same name exists, the request says so.
- A variant's name and a field's change in the code only. An import alias of the variant's name, as in `import Page.Settings as Settings`, keeps its own. In a field rename, a variable that a record pattern binds takes the new name, which the request says.
- A module's name changes in front of a dot, and in a module line or an import outside of what that exposes. A type of the same name, as in `module User exposing (User)`, keeps its own.

A rename creates no Elm file and deletes none. The one exception is the file of the module that a module rename moves. Its new path must not be one that the starting commit holds. A move over such a file loses what the file held, and it is a wrong result even where the project compiles.

A declaration of another kind that shares the target's name has to keep it as well: a record alias with a field called like the function, a type called like the variant, a variant called like the type, a function called like the field. A text replace renames those along, and the project still compiles when it does so everywhere.

The comparison reads tokens and no types, so some things get past it. Each shares the target's name, was renamed along with it in a file the task may change, and left the project compiling: a local variable, a type variable, a field of a record that has no alias or of an extensible alias, a port, and a function without a type annotation. In a module rename, an import alias that equals the last part of the module's name gets past it the same way, be it the module's own alias or another import's.

The add-variant verdict reads an added variant and its branches by these rules:

- The message of the added `Debug.todo` is the session's choice. The language server's `elm_add_variant` writes a message of its own, and the task is about the branch and not about the wording of a placeholder.
- Brackets around the call are the session's choice, and so are the lines that a body is laid out on.
- The variant can stand behind its bar with a space or without one, as in `| Square` and `|Square`.
- A pattern can go on over several lines while one of its brackets is open, and its arrow stands on the line where the pattern ends, as elm-format puts it. The compiler also takes an arrow on a line of its own. The verdict does not read that as the end of a pattern, and such a branch fails the task.
- A branch ends with its body. The first line of code below the body must not be indented deeper than the branch's pattern, because by Elm's layout rule such a line goes on with the body. A branch put between a body and its last lines compiles, takes those lines over from the branch above, and fails the task.
- A comment in an added branch or beside it is one more thing that changed, and fails the task. That holds on a line of its own, behind the arrow, in the body and behind the new variant. The six renames leave comments out of the comparison altogether.
- The one exception is a comment in front of the arrow that begins and ends on one line of the pattern. It is passed over, because a pattern is read line by line without its comments. A block comment that goes on over two lines of a pattern fails like the rest.
- The variant goes onto the one type that the request names. A type of the same name in another module would take it as well, and the project would compile.
- A branch that a session adds to a case which already had a catch-all passes as well, though the compiler did not ask for it.
- In a file that does not end with a line break, a branch added at its very end fails when its body repeats the body above it, because git then shows the line above as the added one. elm-format ends every file with a line break.

The move-function task picks a destination and builds the move in `lib/move.mjs`, keeping the target only if the project compiles:

- The request spells out every import change so the task needs no judgment. `D` exposes `f` from then on and `S` does not. Qualified calls use `D`'s qualifier. Bare calls stay bare. Their module imports `f` by name from `D`, added to its import of `D` or as a new `import D exposing (f)`, and takes `f` out of its import of `S`, dropping the word `exposing` where the list would be empty. A module that calls `f` qualified and does not import `D` gets `import D`. `D` gets a plain `import M` for every module the function needs and `D` lacks, and those names are written with the module's whole name. Every other name of another module uses `D`'s import of that module, staying bare where `D`'s import exposes it and taking `D`'s qualifier otherwise. Every other import stays, also one the move leaves unused.
- `plan` leaves out a module that exposes only `f`, a function that uses unexposed names of its module or a type exposed without its variants, a bare name of its own module that some import also gives, a bare name that several imports expose, and a qualifier that stands for several modules.
- The destination must be compiled by the check command, must not mention `f`, and must not declare or import any bare name the function uses. No new import may close a cycle or clash with an alias. Among the destinations that remain, `plan` prefers the fewest modules gaining an import, then the fewest new imports in `D`, then the first path.
- The verdict checks that `D` declares `f` and `S` does not. It compares `S`, every user and `D` outside the function against the plan's move token by token, and checks that the function in `D` keeps its original tokens once qualified names are read as whole module names. Placement, layout and comments, the doc comment included, are free. Only `S`, `D` and the users may change, no file may be created or deleted, and only Elm files may change.
- A name written bare where `D`'s import lists it by name passes, though the request asks for the qualifier. A name that was qualified in `S` and is written bare through a `(..)` import of `D` fails, though it compiles.

The two removal tasks, `remove-variant` and `remove-field`, replace constructions or reads with `Debug.todo`. Both were first tried in a stricter form and left out. On the three real codebases, every variant that code matches in 5 files or more is also constructed somewhere, and a field that is set and never read involves at most 4 files. For both tasks, `plan` reads the source in `lib/remove.mjs` and runs two trial builds before taking a target. The removal itself must compile, and renaming the target wherever `plan` reads a use of it must compile too. The trial rename catches any use that `plan` missed or misread.

The remove-variant task and its verdict follow these rules:

- The request asks to remove the variant from its custom type and remove every `case` branch whose pattern names it, also inside a tuple or another variant's pattern as in `( V, _ )` or `Just V`. A `case` left with one branch stays a `case`. Every other use of the variant, qualified or bare, becomes `Debug.todo` with a string literal. Where arguments follow directly, as in `V a b`, the whole application goes. Elsewhere, as in `List.map V items` or `V <| a`, only the name goes. Every other function, variable and import stays as it is, also one the removal leaves unused.
- `plan` leaves out a custom type with only one variant, a variant whose name another type of the project also has, and a variant called like one every module has, `True`, `False`, `Just`, `Nothing`, `Ok`, `Err`, `LT`, `EQ` or `GT`. The trial build leaves out a variant whose removal leaves a redundant catch-all branch. `plan` also leaves out a construction followed by an unbracketed lambda as its last argument, a `case` with its first branch on the line of `of`, and a file whose brackets do not pair up. Elm rejects a partial pattern in a function argument, lambda or `let`, so a type with two variants or more has no such pattern.
- The verdict checks that the project compiles, the type no longer has the variant, every changed file matches the plan's own removal token by token, and every other changed Elm file keeps its tokens. Comments, `@docs` lines, layout, the order of imports and exposing lists, the message of each `Debug.todo`, brackets around the call and a `<|` handing it the message are free. Only Elm files of the project may change.

The remove-field task and its verdict follow these rules:

- The request asks to remove the field from its record type alias and take it out, with its value, from every record literal built with it and every update that sets it. An update that sets no other field, `{ r | f = x }`, becomes `r`. Every read becomes `Debug.todo` with a string literal. A read with a dot, `user.f` or `(get id).f`, goes together with the record in front of the dot, while reads behind it stay so `user.f.next` becomes `(Debug.todo "...").next`. An accessor `.f`, also in `user |> .f`, becomes a function that ignores its argument, `\_ -> Debug.todo "..."`. Every other function, variable and import stays as it is, also one the removal leaves unused. The request states that no other record type of the project has the field, no record pattern names it and no code calls the alias as a function.
- `plan` leaves out an alias with only one field, a field whose name appears as a label in any other record type of the project, an alias, annotation, extensible record or variant argument, and a field named by any record pattern `{ f }` or `{ a, f }`. It also leaves out an alias whose name appears in code as a value, such as a constructor in a decoder or a variant of the same name, and a field where a record literal built with it has other fields than the alias, such as a package record. The trial rename also rules out a read of the field on a package record. Because a field travels through values, every file that names it must be compiled by the check command.
- The verdict checks that the project compiles, the alias no longer has the field, every changed file matches the plan's own removal token by token, and every other changed Elm file keeps its tokens. Comments, layout, the message of each `Debug.todo`, brackets around it, the name of the accessor lambda's argument and brackets around the lambda are free. A plain `Debug.todo` or `always (Debug.todo ...)` in place of an accessor fails. A string with the field's name, such as a JSON key in a decoder or encoder, is no read and must stay. Only Elm files of the project may change.

A task changes Elm files of the project and nothing else, by these rules:

- Of the files that the starting commit holds, a data file, a script or the build's configuration that changed along makes the result wrong, whatever the compiler says.
- So does any file beside `elmRoot`, where the repository is more than the Elm project.
- The one exception is `elm.json` in a module rename, where a package lists the modules it exposes. Where that list holds the module, its name has to change there too, and the task says so. A check command that builds one file does not read the list, so the compiler would pass the old name. Nothing else in the file may change.
- A file that the commit does not hold counts only when it is an Elm source.
- Under a directory called `elm-stuff` or `node_modules` such a file does not count either. The compiler's cache and the packages that a session installs are no sources of the project, though a package can bring Elm files of its own.
- What the commit holds there counts like any other file, and so does a module in a source directory of the project that lies there, as where `elm.json` lists a package that came through npm.
- The page that `elm make` writes without `--output`, the output of your own check command or a note that a session left changes nothing about the project.

Both the choice of targets and the verdict come from `lib/elm-source.mjs`, `lib/move.mjs`, `lib/remove.mjs` and the project's own compiler. Those modules read declarations and tokens from the source text, whatever their layout, and leave comments and string literals out. The language server takes no part in either, so it cannot grade its own work.

### What plan gets with levels

With the default levels `10,50,100` and widened check commands on the three real codebases A, B and C, `plan` produces 81 tasks: 25 in A, 29 in B and 27 in C. Each cell below lists the file counts of the targets picked for each level. A task type with fewer than three numbers got fewer levels.

| Task type | A | B | C |
|-----------|---|---|---|
| rename-function | 10, 16, 27 | 10, 39, 63 | 10, 34, 110 |
| rename-shared-function | 10, 16 | 10, 13, 27 | 7 |
| rename-variant | 10, 15, 22 | 10, 14, 20 | 10, 16, 34 |
| rename-field | 7, 8 | 10, 12, 18 | 10, 18, 26 |
| rename-module | 10, 45, 209 | 10, 51, 90 | 10, 49, 113 |
| add-variant | 5, 7 | 12, 15 | 8, 14, 19 |
| rename-type | 10, 19, 37 | 10, 21, 43 | 10, 46, 103 |
| move-function | 9, 12 | 11, 40, 63 | 9, 20, 30 |
| remove-variant | 10, 15, 23 | 10, 14, 21 | 10, 13, 17 |
| remove-field | 7, 18 | 9, 11, 17 | 9, 10 |

[Runs with levels in three harnesses](#runs-with-levels-in-three-harnesses) reports the runs made on this plan with six models in Claude Code, the Codex CLI and the Antigravity CLI.

## The two arms

The two arms mean the same in every harness.

| Arm | The session has |
|-----|-----------------|
| `baseline` | the harness's own tools for reading, searching, editing and running shell commands |
| `lsp` | the same, plus the MCP tools of this checkout's `mcp-wrapper/index.mjs`, started with `--project-tools` so it uses the compiler each codebase pins |

In Claude Code, those built-in tools are `Bash`, `Read`, `Edit`, `Write`, `Grep` and `Glob`. In the Codex CLI, they are `command_execution` and `file_change`. In the Antigravity CLI, they are `read_file`, `edit_file`, `write_file`, `run_command` and `manage_task`, plus `list_resources` and `read_resource` in the `lsp` arm.

Everything else is identical within a run: the prompt, which never mentions the language server, the model, the effort, and the starting commit. The sessions of a task sit next to each other in the queue, so they run at about the same time, and the arms take turns at going first.

Every `lsp` session must prove that it received the language server's tools. Claude Code names the server and its tools in its init event. Codex names the server's tools in the session's rollout log. Antigravity writes one tool file per server tool into the session's settings directory. If a harness does not report what it gave a session, `run` stops without recording that session. If the server fails to start, `run` records the session as `Server did not start`.

In Codex 0.171.0, Codex defers every MCP server's tools for every model in its catalog. The prompt names the server with a shortened description, and the model has to search for its tools first. In a trial, three models with the server registered that way never called it. The `lsp` arm therefore registers the server with `omit_tools_from = ["code_mode", "deferred"]`, a Codex configuration setting that puts all 22 tool names and descriptions directly in the prompt like Claude Code and Antigravity. `run.json` records that setting under `serverSettings`, and a Codex session whose prompt defers the server's tools stops the run. A user who registers the server as `docs/harnesses.md` shows gets the tools deferred. Codex also passes only a short list of environment variables to an MCP server by default, so the benchmark passes the session's variable names to the server through `env_vars`.

### Keeping your own setup out

A session must not see your harness setup. An instruction file that recommends the language server, or a note in memory from an earlier session, would reach both arms and blur the difference between them. Each harness keeps your setup out with its own switches, and `run` checks those switches before the first task with a short session without tools in a directory seeded with instruction files.

**Claude Code.**

- `--setting-sources ""` leaves out user and project settings, and with them your plugins, skills, hooks and the `CLAUDE.md` and `AGENTS.md` files in the project and above it.
- `--strict-mcp-config` leaves out every MCP server but the one the `lsp` arm gets.
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns off auto memory. All worktrees of a repository share one memory directory, which is your own.

These are Claude Code's switches, and they may change between versions. I checked them with Claude Code 2.1.311. `run` checks them again each time:

- Before the first task, `run` runs one short session without tools in a directory seeded with instruction files and with a `SessionStart` hook in each of the project's two settings files, and asks it what it was told. The check plants files in the project and above it.
- `run` stops if that session saw any planted word, reports a memory directory, or comes up with a tool or an MCP server of any kind, the language server included.
- The question also asks the session to name the path of every file whose contents it was given as instructions. `run` stops when the answer names a path in your user settings, in `$CLAUDE_CONFIG_DIR` when set or `~/.claude` otherwise, including symlink targets inside that directory or its `rules/`. The check reads only directory entry names and link targets there, plants nothing, and reads no file contents.
- Every later session stops the run the same way if it reports a memory directory, a stray tool, a stray MCP server in any state, or a non-builtin plugin.
- An `lsp` session stops the run when its language server is absent, still starting when the session reports its setup, or connected without handing over any tool. `MCP_TIMEOUT` sets how long Claude Code waits for a server to start, 30 seconds by default.

Claude Code isolation limits:

- User-settings hooks stay out through `--setting-sources ""` alone, which no session can report on.
- Instructions loaded on demand, such as a `CLAUDE.md` in a subdirectory or a path-scoped rule, stay out of the check's reach because the check session has no tools and reads no files. In a manual check on Claude Code 2.1.311, a session that read a file in such a subdirectory loaded both under `--setting-sources project` and neither under the benchmark's flags.
- Organization-managed settings and a managed `CLAUDE.md` still apply.
- Leaving out user settings also leaves out their `env` entries and `apiKeyHelper`. If your sign-in depends on those, sessions cannot reach the API.
- The memory directory check reads an undocumented field of Claude Code's first event. If a later version drops that field, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` alone keeps memory off.

A session in a linked worktree gets nothing of the main checkout. With Claude Code 2.1.311, such a session named neither an untracked `CLAUDE.md` nor a `SessionStart` hook of the main checkout under `--setting-sources project,local` or under the benchmark's flags, so the check's plain directory matches a worktree here.

**Codex CLI.**

- Each session gets its own `CODEX_HOME` directory among the system's temporary files, remembered under `<out>/work/` and removed after the session or by the next run.
- That directory links to your `$CODEX_HOME/auth.json`, or `~/.codex/auth.json`, with a single symbolic link and copies nothing. When Codex refreshes the login, the refresh lands in your own file. After every session, the benchmark checks that the link still points to your file and stops the run if Codex replaced it.
- Switches keep out user configuration with `--ignore-user-config`, project and user instruction files with `project_doc_max_bytes=0`, skills with `skills.include_instructions=false`, web search with `web_search="disabled"`, login shell profiles with `allow_login_shell=false`, and subagents, apps, plugins, memories, hooks, browser use and computer use via `--disable`. The benchmark also strips `multi_agent_version` and `experimental_supported_tools` from the copy of the model catalog that the session reads.
- Before the isolation session, `run` reads Codex's offline prompt view with `codex debug prompt-input` and stops before any paid session if planted instructions, personal paths or stray tools appear. It then runs one short session without tools.

Codex CLI limits:

- Your `auth.json` login file is shared by symlink. A token refresh updates your file directly, and if a session replaces the link with a regular file, `run` stops and tells you to run `codex login status`.
- Codex prints `Reading additional input from stdin...` into the run's output. Standard input is empty, so the prompt is unchanged.

**Antigravity CLI.**

- Each session runs with its own settings directory via `--gemini_dir`, keeping your hooks, skills, settings and earlier conversations out and discarding what the session writes when the directory goes. Login comes from the system keychain and still works.
- The benchmark writes a custom agent file at `.agents/agents/session/agent.md` inside the checkout before recording the checkout's initial state, with `inheritCustomizations: false`, `subagent: false`, `mainAgent: true`, and only its arm's tools. It drops `AGY_CLI_*` and Antigravity directory override variables from the session's environment, sets `AGY_CLI_DISABLE_AUTO_UPDATE=true`, and passes `--disable-slash-commands`.
- Antigravity hands a workspace's skills, hooks, MCP servers and plugins to every session regardless of flags. Before the first check in both arms, the benchmark therefore removes `skills`, `skills.json`, `hooks.json`, `mcp_config.json`, `plugins` and `plugins.json` from every `.agents`, `.agent`, `_agents` and `_agent` directory from the Elm project root up to the checkout's repository root, and prints once per codebase what it removed. Your own repository keeps those files. The benchmark refuses a checkout where any such path lies behind a link or holds files not in the commit.

Antigravity CLI limits:

- Antigravity's first event lists every tool of the CLI, so a stray tool that an arm lacks shows up only when a session calls it.
- Antigravity runs a second, small model to review each tool call outside its safe list, including edits, commands and calls to the language server. In a probe, that review took 1.6 and 2.0 seconds per call, and its tokens appear in no event. Both arms pay that time.
- Whether Antigravity reads a `.gemini/config.json` inside a project that points to more customizations is not settled.
- Whatever your account keeps on the server side is not checked.

### What a session can touch

In every harness, a session's shell runs as your user without asking and can read and write any of your files, logins among them. Run the benchmark only on code you trust. Every session gets its own `git worktree` of the codebase and does not edit your checkout. The compiler runs once before the agent starts, so neither arm pays for a cold build.

The worktree is a directory named after the repository, alone in a new directory among the system's temporary files. Each harness tells the model where it works, and that path says nothing about the arm. The plan, with what each task expects, and the patches of other sessions stay in the output directory, nowhere near.

- A worktree shares its repository with your checkout: its branches, tags, stash, configuration and remotes are yours. The agent is told not to commit, and each harness denies git's writing subcommands, from `commit` and `branch` to `tag`, `config` and `push`, in their plain form. That guards against accidents and is not a sandbox, because the agent has a shell. `checkout`, `reset` and `stash` are among the denied subcommands, so a session takes an edit back with `git restore` or by hand. What a session stages, with `git add` or `git mv`, stays in the index of its own worktree and leaves unreferenced objects in your repository until git collects garbage.
- In Codex, git rules live in the session home's `rules/benchmark.rules` and match `git`, the whole path of each `git` on `PATH`, commands behind `env` and `command`, and a few global options: `--no-pager`, `-P`, `--no-optional-locks`, `--no-replace-objects` and `-C .`. Codex git-rule limits:
  - The rules do not catch `git -C <another directory>`, `git -c key=value`, `VAR=x git`, or `git` inside `bash -c "..."`.
  - Codex matches no rule against a command that holds a redirection, a substitution, a variable or a wildcard.
  - The check after a session catches a commit because `HEAD` moved, and does not catch a stash.
- In Antigravity, `--dangerously-skip-permissions` lets tool calls run without approval while `--settings` denies `command(git <subcommand>)`, `read_url(*)` and `execute_url(*)`.
- The benchmark's own git commands add nothing to your repository but the worktree, which they remove again. They skip its hooks and stage nothing. The links of `link` are made, and removed again, inside the worktree and nowhere else.
- The paths under `link` are your real directories. `plan` and `run` stop when a source file is reached through a link that leads out of the Elm project root. Outside the checkout a session would edit your own file there, and elsewhere in the checkout its edit would be one beside the project, which counts against it. A checkout whose Elm root itself lies behind a link that leads out of it is refused. So is a commit that holds a link out of the checkout at any path, because a session that edits such a path changes what the link points to. A committed link that leads out through a path under `link` is refused as well, so a repository that commits a link into `node_modules` cannot list `node_modules` there. Each link is followed the way the system follows it, also to a file that is not there yet, and one whose end cannot be made out is refused with the others. And so is one whose `elm.json` is a link, wherever it leads, because the benchmark reads from that file what a session did to it.
- A session is a process group of its own, and so is every run of the check command. A harness can start each shell command as one more group, which a signal to the session's group does not reach, so the benchmark also looks up once a second which processes a session has started. When a session or a build ends, the benchmark kills what it left running, and only then judges the result and removes the worktree. A process that a session detached and that left its parent in less than a second can escape, and one that keeps writing can recreate its checkout directory after removal.
- A session over its time limit, or over `--max-tokens` in Antigravity, gets the signal that Ctrl-C sends. The harness then ends its shell commands and reports what the session spent. Whatever is still running five seconds later gets killed.
- Ctrl-C, `kill` and a closed terminal end active builds and sessions the same way and remove their worktrees and temporary home directories. The benchmark's own git commands run outside the terminal's process group, so an interrupt lets each finish. No further session starts. An interrupted session leaves no record, transcript or patch, so the next `run` starts it again. A second Ctrl-C does not wait the five seconds.
- An error that nothing in the benchmark catches ends active runs the same way. Its message goes to stderr, and the benchmark exits with 130 as an interrupted run does, so finished records stay and nothing else remains. That happens when stdout closes, as with `run ... | head -n 2`. Where every session had ended by then, nothing is interrupted, and the benchmark exits with 1.
- A benchmark killed outright with `kill -9` ends nothing. Its sessions run on until they finish, and its worktrees and temporary home directories stay among the temporary files. `<out>/work` remembers each worktree and each `.home` directory, and the next `plan`, `run`, `entries` or `probe` on that output directory removes the leftover homes and the worktrees of codebases the config still names, including a session that wrote its record. A checkout of a codebase that the config no longer names stays where it is, and so does a checkout whose label now points to another repository. Its file in `<out>/work` gets renamed so a new session does not overwrite it, and stderr tells you where it is and that `git worktree remove --force` in that repository removes it. The benchmark only ever deletes a directory that git lists as a worktree of the codebase, and never prunes your repository's worktree list. A file that a session wrote beside its checkout stays with its parent directory.
- One benchmark at a time works in an output directory. `plan`, `run`, `entries` and `probe` keep a lock file at `<out>/lock`, and a second one fails while the first runs. `report` and `compare` take no lock. The lock of a killed benchmark is taken over by the next one, including when it holds the same process id inside a container. The lock relies on process ids, so two containers sharing one output directory can both enter. Because the lock uses a hard link, `plan`, `run`, `entries` and `probe` refuse an output directory on a file system without hard links.
- Claude Code can keep the output of a session's tools under `~/.claude/projects/`, in a directory named after the checkout's path, even with `--no-session-persistence`. After a run of 108 sessions with Claude Code 2.1.311 there were four such directories, and `ls ~/.claude/projects | grep checkout-` lists them. They hold names from the codebase and stay on your machine until you delete them. `~/.claude.json`, where Claude Code keeps an entry for each project directory, got no entry for a checkout in more than a hundred sessions with Claude Code 2.1.311.

## Reading the report

A solved task means that the project compiles and that the change passed the comparison of [The tasks](#the-tasks), which reads tokens and no types. Some changes get past that comparison, and that section lists them. A session can also solve a task and still break a build that the benchmark never runs, as [What it does not tell you](#what-it-does-not-tell-you) lists. One target per task type, codebase and level is a small sample, so raise `--repeat` and add codebases before you read much into a difference between the arms.

`report` summarizes one run from one output directory and refuses records of two harnesses or two models in the same directory. A session ends in one of these ways, and the page counts the endings that apply to its harness per arm.

| Outcome | Meaning |
|---------|---------|
| Solved | The project compiles and the change is the one that was asked for |
| Wrong result | It compiles, but something else was changed or the change is incomplete |
| Does not compile | The check command fails |
| Could not be judged | Shown when a run has a checkout that could not be read for judging, such as one missing `.git` |
| Out of time | The session hit `--timeout-min` |
| Out of budget | The session hit `--max-budget-usd`, in Claude Code |
| Out of tokens | The session hit `--max-tokens`, in Antigravity |
| Session error | The session ended on an error of its own, such as a request that grew too long for the model |
| Server did not start | The `lsp` arm's language server failed to start. It counts against that arm, whatever the agent then did without it. The session is not cut short, and its cost, tokens and time stay among the arm's |

A session that loses the API is no result of either arm, in any harness: on a rate limit, a quota, an expired login, an outage or a broken connection. That holds at the first request and in the middle of the work, and it holds for any session that fails before the model answered once, or whose time ran out while the harness was still retrying the API. `run` stops there and records nothing for it, repeating any reset time that the harness printed, so the same command resumes from that session once the cause is gone. A session's own error, such as a prompt that exceeds the model's context window, stays recorded as a session error.

A record also counts how often Claude Code or Codex asked the API again as `apiRetries`, and `Turns` for Claude Code. `Turns` is empty for Codex and Antigravity, and `API retries` is empty for Antigravity. To run any recorded session again, delete its `.json` in `<out>/runs`.

What a session changed is read against the commit it started from, file by file. That also shows a change the session committed, and one in an Elm file that git ignores. A session is told not to commit. One that does is judged by all of its changes, and the commit itself makes it a wrong result.

Claude Code reports a cost per session. Codex and Antigravity report tokens and no cost, so their records hold `null` for cost and the page shows tokens where it shows cost for Claude Code. Tokens mean the same across all three harnesses. `inputTokens` counts every input token including cache reads, and `cacheReadInputTokens` also reports cache reads separately. Antigravity's `outputTokens` includes thinking tokens, and Codex's includes reasoning tokens. A session that ended before its harness counted tokens has `null` for its tokens, including a killed Claude Code session, which older runs recorded as zeros. Token and cost medians leave those sessions out, and the page counts them.

Time is wall-clock time, so run with `--concurrency 1` on a quiet machine if the timing matters to you. Each record holds `--concurrency` as `concurrency`, since a resumed run may change it. `summary.json` holds the same figures as the page. Both name the model, the effort, the harness and version, and the language server with the last commit that changed its sources, a digest of uncommitted changes, and the binary's build time. The sources are `src/` without `src/bin/`, `mcp-wrapper/`, `Cargo.toml` and `Cargo.lock`.

The arms are compared on the same work. A round of a task enters the report once every arm that `run` started sessions for has a record for it, and the page says how many sessions are waiting for their counterpart. A report of one arm alone says that it compares nothing.

Near the top of the report page, beside tasks solved, a row of tiles shows what the server saved across the whole run: time saved, cost saved where reported, input tokens saved, and output tokens saved. Each saving is how much less the `lsp` arm took, summed over the pairs of sessions that both arms completed, shown with its 95% interval and the number of tasks it rests on. An interval is a bootstrap range that draws the run's tasks again with replacement 4,000 times using a fixed seed, keeping all repetitions of a task together, and takes the middle 95% of those draws so the same records always produce the same page. A saving resting on fewer than 10 tasks gets no interval, and neither does one where a draw's baseline sums to zero.

Beside those tiles, another tile counts the tasks that one arm solved more often than the other, with the p-value of the exact sign test. A task counts for the arm that solved more of its rounds, and for neither arm on a tie. The exact two-sided sign test asks how often tossing a fair coin for each non-tied task would split tasks between the arms at least that unevenly. A small p-value says chance alone would rarely produce that split on these tasks. It does not say how large the difference is, and it holds for the planned tasks only. The tile also prints counts of sessions solved by one arm alone, pairing each repetition number with the same repetition number in the other arm, with no test resting on those counts.

Below the task chart, the page adds three sections before the per-level cards and session table:

- **What the server saved.** The same savings and sign-test counts broken down by kind of task and by level, without intervals.
- **What the sessions did.** Mean and median tool calls, replies and output tokens per session and arm, tool calls by tool with all language server tools combined into one row, how many `lsp` sessions called the server, counted by calls the server answered, overall and by kind of task, with solve counts and median times for sessions that called the server versus those that did not, the server's tools by calls tried, and failures by kind, also split by whether an `lsp` session called the server.
- **Per-level cards.** One card per task type with a chart of median cost or median input tokens and one of median time against level, one line per arm, and a table per level and arm with solved, median cost or tokens, median time, median tool calls and the files of each codebase's target. The table of every session includes `Level` and `Target files`.

A failure's kind comes from what stopped the session or else from the first problem the check found. New records keep one id per entry of `problems` in `problemKinds`, and `report` reads older records back from their problem sentences. Across the six runs with levels, eight kinds appeared: "Changed a string literal", "Changed the imports or the module line beyond the task", "Left the code otherwise than the removal makes it", "Changed a file that is no Elm source", "The change that was asked for is missing", "Does not compile", "Changed more than the variant and its branches" and "Wrote a branch that is not a Debug.todo".

In `summary.json`, nothing it held before changed. It adds `harness`, `tools`, `costReported`, `turnsReported`, `retriesReported`, `savings`, `draws`, `levels`, `activity`, `serverUse` and `failures`, adds `savings` to each entry of `taskTypes[]` and `taskTypes[].levels[]`, and adds `task` and `failureKind` to each entry of `runs[]`, along with token fields when cost is not reported.

### Comparing runs

`compare` puts several runs of the same plan side by side from their records, starts no agent, takes no lock on the input directories, and writes `<dir>/comparison.html` and `<dir>/comparison.json`:

```bash
node benchmarks/bench.mjs compare --out <dir> <run directory>... [--notes <file>]
```

The page shows four parts, with no problem text and no names from any codebase:

- The runs side by side, with the rounds each run covers, sessions solved in each arm, time, cost and token savings with their 95% intervals, sessions that called the server, mean tool calls per session, and each run's sign test between arms.
- How each run was set up, naming any setting that differs between runs.
- Pairwise comparisons between every two runs in each arm on the rounds both runs completed, using the exact sign test on tasks.
- One section per run with its tool calls by tool, its use of the server and its failures by kind.

`--notes <file>` takes a JSON file mapping a run's full section name, such as `claude-opus-5-5 in Claude Code`, or a model id that matches one run alone, to a list of paragraph strings. The page shows those paragraphs under that run, marked as a hand-written reading of the figures and not output of the benchmark.

`compare` refuses:

- Plans that differ in codebases, commits, `elmRoot`, check commands, check timeouts, linked paths, tasks, levels, target file counts, prompts or expected results.
- Two runs of the same model, effort and harness.
- Any run with no round that both arms completed.
- A `--notes` entry that names no run, names a model shared by several runs, or names the same run twice.

## The probe

A tool-only pass calls the language server's refactoring tools directly on many targets of each task type, with no agent, and judges each result with `unmetExpectations` and the codebase's check command. A session that repairs a tool's mistake by hand still solves its task, so an agent run shows a tool fault only as extra cost and time. `probe` finds those faults directly and costs nothing:

```bash
node benchmarks/bench.mjs probe --config benchmarks/out/config.json --out benchmarks/out
```

Optional flags:

- `--min-files <n>` sets the fewest files a target must involve, default 5 as in `plan`.
- `--per-type <n>` sets how many targets to probe per task type and codebase, default 30, or `all` for every target.
- `--only <text>` keeps the task types whose `<label>/<type>` contains the text. A text that matches none is refused.

`probe` draws from the targets that pass every filter of `plan`: size, check command coverage, Elm files outside the project, links, an occupied new path, Lamdera's four modules and six types in `Types`, and the trial builds for `add-variant`, `move-function`, `remove-variant` and `remove-field`. Where a target fails its trial, `probe` drops it and takes the next candidate. Where more targets remain than `--per-type`, `probe` takes that many at equal steps of size from `--min-files` to the largest target's size, stepping from the largest down and picking the nearest target not taken yet, the smaller and then the first by key on a tie. The largest target is always included, and the choice does not depend on the machine.

For each task type, `probe` calls the handlers of `mcp-wrapper/tools.mjs` in its own process, with the project's own compiler and `elm-format` allowed as `--project-tools` allows them. That follows the path of the `lsp` arm without the MCP transport and argument schema check. `probe` points each tool at the declaration, counting columns in bytes of UTF-8 as the server counts them: a function at column 0 of its first line, which is its type annotation where it has one, and a type, variant or field at its name in the declaration.

- `rename-function` and `rename-shared-function` call `elm_rename_function`.
- `rename-variant` calls `elm_rename_variant`.
- `rename-field` calls `elm_rename_field`.
- `rename-module` calls `elm_rename_file`, with the new file beside the old one.
- `rename-type` calls `elm_rename_type`.
- `move-function` calls `elm_move_function`, passing the function's line and `target_module`.
- `add-variant` calls `elm_prepare_add_variant` and then `elm_add_variant` without `branches`, so the server writes a `Debug.todo` branch for each case that needs one.
- `remove-variant` calls `elm_prepare_remove_variant` and then `elm_remove_variant`.
- `remove-field` calls `elm_prepare_remove_field` and then `elm_remove_field`.

After every call that did not fail, `probe` runs the check command and judges the result against the state the checkout had before the call. Each target ends in one of five outcomes:

| Outcome | Meaning |
|---------|---------|
| `solved` | The project compiles and every expectation holds |
| `wrong-result` | The project compiles, but an expectation fails |
| `does-not-compile` | The check command fails |
| `tool-error` | A tool call failed, or failed after changing files |
| `tool-refused` | A tool call failed without changing any file and said `"required by Lamdera"`, `"already exists"`, `"import cycle"`, `"not possible"` or `"No file was changed"` |

How `probe` manages checkouts, servers and records:

- `probe` takes `<out>/lock`, removes leftover checkouts first, works in a checkout of its own at `<out>/work/<label>.probe`, and writes nothing into the codebase's repository beyond that worktree, which it removes again.
- `probe` refuses a language server whose binary is missing or older than its sources, runs `cli.mjs doctor` first, and checks before each target that the server's version and build match what it began with.
- One language server stays up per codebase across targets, bringing its index in step with the disk before each call. After a `tool-error`, `probe` stops the server so the next call starts a fresh one. On 18 targets of A, starting a fresh server for every target gave the same outcomes, unmet expectation kinds and diff stats as keeping one server up, while the tool calls took 165 s against 36 s, about 7 s more per target.
- After each target, `probe` restores every committed file and every Elm file from its text before the call or from the commit. Where that does not restore the checkout, `probe` removes the checkout and opens a fresh one.
- The compiler's cache stays warm across targets. After a check that fails, `probe` builds the restored checkout. Where that fails too, `probe` deletes `elm-stuff` and builds again. When that passes, `probe` probes the target again with the fresh cache. When it fails, `probe` stops.
- stderr prints a line when a codebase is checked out, one line per task type with the counts and time, and one line with the codebase's total time.
- `<out>/probe/<label>.json` holds the codebase's label and commit, the language server's version, the benchmark's version, `--min-files`, `elmRoot`, `check`, `checkTimeoutMs`, `link`, and one record per target: `type`, `key`, `size`, `outcome`, `unmet`, `problems`, `text`, `diff` with file and line counts, `toolSeconds` and `checkSeconds`. Those records name files and symbols of the codebase.
- `<out>/probe/<label>/<16 hex digits>.patch` holds the diff of each non-failing target and of any failing target that changed files, named by a digest of its type and key.
- `<out>/probe.json` and the table printed to stdout hold counts only. They give, per codebase and task type, targets tried, counts of each outcome, counts of each unmet expectation kind, and the same outcome counts for each size band: `1-4`, `5-9`, `10-19`, `20-49`, `50-99`, `100-199` and `200+` files. They count every record in `<out>/probe/` for every codebase in the config, also one that `--only` skipped or a record from an earlier pass with a larger `--per-type`.
- `probe` writes records every 5 seconds and when it ends, also on an error or an interrupt. Stopping it with Ctrl-C leaves no record for the target under way, and the same command resumes from the saved records.
- `<out>/probe/<label>.json` is held to the language server, the benchmark's own code, `--min-files`, `elmRoot`, `check`, `checkTimeoutMs` and `link`. A run that differs in any of those is refused. `--per-type` and `--only` may change, and `probe` stays on the recorded commit even if `ref` moved.

### What the probe found on three codebases

I ran two tool-only passes on the three private codebases A, B and C with widened check commands, `--per-type 30` and `--min-files 5`. No agent session ran for either pass, and neither cost money.

- **First pass.** Recorded in [`results/probe-before.json`](results/probe-before.json), on version 0.3.39 at commit `8678f91` across the six task types that existed then. It ran 392 targets in 16 minutes 50 seconds, with 224 solved, 165 that did not compile, 3 that compiled with a wrong change, and 0 failed or refused.
- **Tip pass.** Recorded in [`results/probe.json`](results/probe.json), on all ten task types across 683 targets, 201 in A, 255 in B and 227 in C. It solved 682 and refused 1, taking 5 minutes 46 seconds on A, 10 minutes 16 seconds on B and 9 minutes 30 seconds on C.

Solved of tried across all three codebases:

| Task type | First pass | Tip |
|-----------|------------|-----|
| rename-function | 70 of 76 | 76 of 76 |
| rename-shared-function | 18 of 34 | 34 of 34 |
| rename-variant | 49 of 90 | 90 of 90 |
| rename-field | 12 of 78 | 77 of 78 |
| rename-module | 69 of 90 | 90 of 90 |
| add-variant | 6 of 24 | 24 of 24 |
| rename-type | | 90 of 90 |
| move-function | | 52 of 52 |
| remove-variant | | 90 of 90 |
| remove-field | | 59 of 59 |
| All | 224 of 392 | 682 of 683 |

The four task types without a first-pass figure did not exist at `8678f91`. Each was first probed at a different point while the server was being fixed, so those first numbers do not belong in one column with the others. For the record, their first passes solved 39 of 90 for `rename-type`, 1 of 52 for `move-function`, 63 of 90 for `remove-variant` and 13 of 59 for `remove-field`.

The one target on the tip that did not solve is a field rename that `elm_rename_field` refused, and the refusal is right. A list of records of the alias is passed where a list of another record type with the same fields is expected, so renaming the field on one of the two alone cannot compile. [What it does not tell you](#what-it-does-not-tell-you) already notes that case for a session.

The first pass led to reproductions of 14 distinct faults in the six tools, each reduced to short modules with invented names. The passes on the four newer task types and reading the diffs that still failed led to more. Every one has a regression test now:

- **`elm_rename_field`.** Reached a field only where the record's type was written down. Skipped uses in other modules when another module declared an alias of the same name, in about half of the server's starts. Renamed a field of another record in a record update inside a `case` branch. Renamed a record pattern on a record type without an alias.
- **`elm_rename_function`.** Renamed qualified calls to another module's function of the same name, `List.isEmpty` for one. Renamed the uses of a parameter called like the function.
- **`elm_rename_variant`.** Renamed other types' variants of the same name. Renamed another module's type of the variant's name.
- **`elm_rename_type`.** Renamed the type's own variant of the same name.
- **`elm_rename_file`.** Rewrote the module's name inside string literals. Rewrote names qualified with another import's alias that equals the module's name. Left `exposed-modules` of a package's `elm.json` as it was.
- **`elm_add_variant`.** Put the variant under a comment behind the equals sign, where the file does not parse. Put it above a comment between variants. Wrote the new branch without the qualifier of the other branches. Added a branch to a `case` on another type that shares a variant's name.
- **`elm_move_function`.** Imported the function into the old module where that module never calls it, which closed an import cycle. Left the function without the imports and names it uses. Left calls written with a qualifier as they were.
- **`elm_remove_variant`.** Took out another type's branch. Removed only the first line of a variant whose arguments run onto the lines below. Cut a removed branch inside a removed branch as two overlapping edits. Removed the catch-all of a `case` on another type.
- **`elm_remove_field`.** Left a read through another field, `model.settings.theme`. Left a comma behind when it removed the first field of a record written over several lines. Mangled an update that reads the field it sets.
- **All rename tools.** Left the modules under `tests/` untouched.

## A run on three codebases

This run was made before levels and the four newer task types existed, so it covers six task types with one target per codebase each. For the later runs with levels across six models and three harnesses, see [Runs with levels in three harnesses](#runs-with-levels-in-three-harnesses).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="results/report-dark.png">
  <img alt="The upper part of the report page of the run. Tasks solved, 54 of 54 without the language server and 54 of 54 with it. Median cost per session, $0.10 and $0.09. Median time per session, 27 s and 25 s. Median tool calls per session, 5 and 4. Above the four figures, a paragraph that names the model, the three codebases with their sizes and the language server. Below them, bars of the tasks solved, the median cost and the median time for each of the six kinds of task, and a table of how the sessions ended." src="results/report-light.png">
</picture>

I ran the benchmark on 21 November 2026 with `claude-opus-5-5` at Claude Code's default effort, Claude Code 2.1.311 and the language server elm-lsp-rust 0.3.39. It ran on three Elm codebases. They are private, so they are named A, B and C here.

| Codebase | Modules | Lines |
|----------|---------|-------|
| A | 687 | 78,858 |
| B | 288 | 94,924 |
| C | 644 | 113,930 |

`plan` found all six kinds of task in each codebase, so the run had 18 tasks. I ran them with `run --repeat 3 --concurrency 2` in both arms and the defaults otherwise, which made 108 sessions. They cost $12.49 together. The last record was written 28 minutes after the first. That span comes from the times at which the two records were written, since the summary holds no times.

I made the run at 8678f91, "Plan, run and report a benchmark from one command", the fourth commit of this branch. The pictures name it as the state of the language server, and the benchmark's own code was at that commit too. The commits after it change what `plan` leaves out, how it counts lines, what the verdict of a module rename refuses, which variables a session is started with and what the isolation check asks. The isolation check of the tip passed on the machine of the run, with Claude Code 2.1.311. Those commits also change how the benchmark takes output that is no event and a reader that throws, what it does with a leftover checkout whose label went to another repository, how it ends on an error that nothing catches, and the report's note on the Turns column, and none of these touches a result of a run that finished. With them, `plan` picks the same 18 tasks at the same commits of the three codebases, with the same requests and the same expectations. The shell that I started the run from set none of the variables that those commits keep from a session, and no session of the run moved a module onto a file that was there. So the run stands as it is. The sizes above are counted as the first of those commits counts lines, one line per module fewer than 8678f91 counted.

Each cell below holds the tasks solved, the median cost, the median time and the median number of tool calls of the 9 sessions of one arm, three per codebase.

| Kind of task | Without the server | With the server |
|--------------|--------------------|-----------------|
| Rename a function | 9 of 9, $0.07, 22 s, 3 tool calls | 9 of 9, $0.07, 20 s, 3 tool calls |
| Rename a function whose name other modules use | 9 of 9, $0.13, 31 s, 5 tool calls | 9 of 9, $0.09, 28 s, 5 tool calls |
| Rename a variant | 9 of 9, $0.11, 26 s, 4 tool calls | 9 of 9, $0.10, 23 s, 4 tool calls |
| Rename a record field whose name other records use | 9 of 9, $0.17, 30 s, 6 tool calls | 9 of 9, $0.22, 56 s, 14 tool calls |
| Rename a module | 9 of 9, $0.07, 21 s, 4 tool calls | 9 of 9, $0.09, 22 s, 4 tool calls |
| Add a variant | 9 of 9, $0.14, 49 s, 15 tool calls | 9 of 9, $0.07, 24 s, 4 tool calls |

Over all kinds, each arm solved 54 of 54. The median session cost $0.10, took 27 s and made 5 tool calls without the server. With it, the median session cost $0.09, took 25 s and made 4 tool calls. The other overall figures lean the other way. Without the server and with it, the sessions cost $6.15 and $6.34 in total and $0.114 and $0.117 on average, took 29.3 s and 29.8 s on average, and made 5.8 and 6.0 tool calls on average. A round pairs the two sessions of the same codebase, kind of task and repetition. The session with the server was the cheaper one in 26 of the 54 rounds and the faster one in 30. It made fewer tool calls in 22 and the same number in 14. Over all kinds of task, neither arm was cheaper or faster in this run. Every session of the `lsp` arm but one called a tool of the server, 53 of 54.

[`results/summary.json`](results/summary.json) is the run's summary. `report` wrote it and the report page before levels were added, from the records of the run and a plan made at that point, which is why they hold the sizes above. `report` at the tip of this branch adds the level fields, and the figures in `results/summary.json` still hold. The two pictures show the upper part of that page. The summary holds the figures of the report page for every one of the 108 sessions, so the two tables, the total costs and the count of sessions that called the server can be checked against it. Like the pictures, it holds counts and measurements only.

Both arms solved every task. With this model at this effort, the solve rate does not tell the arms apart. The difference lies in single kinds of task and single codebases.

The arms differ most in two kinds of task. Adding a variant took $0.14, 49 s and 15 tool calls in the median without the server, and $0.07, 24 s and 4 tool calls with it. Renaming a field took $0.17, 30 s and 6 tool calls without the server, and $0.22, 56 s and 14 tool calls with it. In the other four kinds, the medians over all three codebases differ by at most 3.7 cents and 3.3 seconds. Together those four kinds cost $3.33 without the server and $3.66 with it. In renaming a function, a function whose name other modules use and a variant, nine sessions on three targets per kind do not tell a difference of a few cents or seconds from chance. Renaming a module is another matter. On each of the three codebases, every session with the server cost more than every session without it, by 0.9 to 3.6 cents in the median. By chance alone, the three sessions of one arm all cost more than the three of the other once in 20 on one codebase, and once in 8,000 on all three. The table by codebase below shows what the medians over all codebases hide.

Each cell below holds the median cost, the median time and the median number of tool calls of the 3 sessions of one arm on one codebase. Every one of those sessions solved its task. The last column holds the number of files a session changed. In every row, all six sessions changed that number of files, the three of one arm and the three of the other. A module that moved counts twice there, for the file that went and the one that came.

| Kind of task | Codebase | Without the server | With the server | Files changed |
|--------------|----------|--------------------|-----------------|---------------|
| Rename a function | A | $0.08, 21 s, 3 tool calls | $0.10, 23 s, 4 tool calls | 18 |
| Rename a function | B | $0.06, 19 s, 3 tool calls | $0.07, 18 s, 3 tool calls | 11 |
| Rename a function | C | $0.07, 22 s, 4 tool calls | $0.07, 20 s, 4 tool calls | 12 |
| Rename a function whose name other modules use | A | $0.13, 32 s, 5 tool calls | $0.09, 23 s, 4 tool calls | 11 |
| Rename a function whose name other modules use | B | $0.16, 33 s, 6 tool calls | $0.12, 33 s, 6 tool calls | 11 |
| Rename a function whose name other modules use | C | $0.08, 26 s, 5 tool calls | $0.09, 30 s, 5 tool calls | 8 |
| Rename a variant | A | $0.15, 32 s, 5 tool calls | $0.21, 50 s, 11 tool calls | 11 |
| Rename a variant | B | $0.07, 23 s, 4 tool calls | $0.06, 19 s, 3 tool calls | 11 |
| Rename a variant | C | $0.11, 30 s, 5 tool calls | $0.10, 23 s, 4 tool calls | 11 |
| Rename a record field whose name other records use | A | $0.17, 29 s, 5 tool calls | $0.12, 26 s, 4 tool calls | 6 |
| Rename a record field whose name other records use | B | $0.15, 29 s, 5 tool calls | $0.24, 57 s, 18 tool calls | 5 |
| Rename a record field whose name other records use | C | $0.23, 40 s, 6 tool calls | $0.28, 1 min 7 s, 14 tool calls | 8 |
| Rename a module | A | $0.07, 18 s, 2 tool calls | $0.08, 22 s, 4 tool calls | 12 |
| Rename a module | B | $0.07, 24 s, 5 tool calls | $0.10, 21 s, 4 tool calls | 12 |
| Rename a module | C | $0.08, 24 s, 4 tool calls | $0.09, 27 s, 4 tool calls | 12 |
| Add a variant | A | $0.08, 27 s, 7 tool calls | $0.07, 23 s, 5 tool calls | 1 |
| Add a variant | B | $0.15, 49 s, 15 tool calls | $0.08, 24 s, 4 tool calls | 3 |
| Add a variant | C | $0.15, 52 s, 15 tool calls | $0.07, 25 s, 4 tool calls | 3 |

`plan` ran with its defaults, so with `--min-files 5`. Adding a variant on A changed one file, fewer than the 5 that `plan` asks for. `plan` counts the files with a branch on a variant of the type, and a case that ends in a catch-all needs no new branch, so the compiler asked for a branch in one file there.

In some rows one arm lies wholly above the other. Every one of its three sessions cost more, or took longer, than every one of the other arm's. With three sessions in each arm, chance alone gives that once in ten for one row and one measure, so between 3 and 4 times in the 18 rows with their two measures. The run shows it 18 times, 9 with the server above and 9 with the server below. These are the rows where that holds:

- Renaming a function. The server cost more on A.
- Renaming a function whose name other modules use. The server took less time on A and cost less on B.
- Renaming a variant. On A, the three sessions with the server cost $0.24, $0.20 and $0.21 and took 56, 41 and 50 s. The three without it cost $0.15, $0.16 and $0.10 and took 32, 36 and 26 s. The three with the server were the three most expensive and the three slowest of all 18 sessions that renamed a variant. On C, the server cost less. On B, neither arm lies wholly above the other.
- Renaming a field. On B, the server cost more and took longer. On A, it cost less.
- Renaming a module. The server cost more on all three codebases, by 0.9 to 3.6 cents in the median, and took longer on C.
- Adding a variant. The server cost less and took less time on B and C, and took less time on A.

The counts in the next three paragraphs come from the transcripts of the sessions, which are not in this repository.

The 9 sessions that added a variant with the server called `elm_prepare_add_variant` and `elm_add_variant` once each and made 3 edits by hand between them. The 9 sessions without the server made 39 edits.

Each of the 9 sessions that renamed a field with the server called `elm_rename_field` once. In the 3 sessions on A, the project built right after that call, and the session changed nothing more. In the 6 sessions on B and C, the session corrected the result by hand, with 19 edits by the Edit tool between them and `sed` commands besides. By what those sessions wrote, the tool had renamed a field of the same name on another record and had left uses of the field out. Those were faults in version 0.3.39 at `8678f91`, and both have been reproduced and fixed since, as [The probe](#the-probe) reports. The 9 sessions without the server made the change with shell commands and no edit.

Each of the 9 sessions that renamed a variant with the server called `elm_rename_variant` once. On A, all 3 sessions then changed the result of the tool by hand, with 5 edits in one session and `sed` commands in the other two. By what those sessions wrote, the tool had also renamed the variants of the same name on two other types. That fault in version 0.3.39 at `8678f91` has also been reproduced and fixed since, as [The probe](#the-probe) reports. On B and C, the 6 sessions built the project after the call and changed nothing more.

This is a small run. It has one target per kind of task and codebase, nine sessions per kind of task and arm, and one model at one effort. A cell of the table by codebase rests on three sessions on one target. Its times come from two sessions side by side on one machine. [What it does not tell you](#what-it-does-not-tell-you) lists what the benchmark cannot measure at all.

## Runs with levels in three harnesses

On 24 and 25 November 2026, I ran the same levelled plan with six models in three harnesses: `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` in Claude Code 2.1.323, `gpt-6.2-sol` and `gpt-6.1-terra` in Codex CLI 0.171.0, and `gemini-4-neon` in Antigravity CLI 1.5.13. Every run used its harness's default effort, `--concurrency 2`, `--timeout-min 20`, and elm-lsp-rust 0.3.39 at commit `1b4c832`. The Claude Code runs used `--max-budget-usd 5`, and Codex and Antigravity ran with no cost or token limit.

The plan used `--levels 10,50,100`, all ten task types, and the three private codebases A, B and C with check commands widened by `entries`. That plan holds 81 tasks: 25 in A, 29 in B and 27 in C. Three full rounds make 243 pairs of sessions per model.

Opus, Sonnet, Haiku and Sol finished all three rounds, 243 pairs each. I stopped Terra and Neon after two rounds and a few sessions of the third. Terra rests on 166 pairs, 2 rounds of 77 tasks and 3 rounds of 4, and Neon rests on 170 pairs, 2 rounds of 73 tasks and 3 rounds of 8. I planned a seventh model, `gpt-6-luna`, and did not run it.

The three Claude Code runs used benchmark commit `6fc3ead`, before the harness refactor, and the three Codex and Antigravity runs used commit `5b607b0`, after it. The comparison page's set-up table notes that difference, and the records hold the same fields. I set four records aside and ran their sessions again because the machine slept while they ran: two of Sonnet's `lsp` sessions that had passed after 994 and 388 seconds, and two of Neon's `baseline` sessions that had run out of time. Those four records are not in the figures.

[`results/levels/comparison.html`](results/levels/comparison.html) holds the full comparison page, [`results/levels/comparison.json`](results/levels/comparison.json) holds every figure below, and [`results/levels/notes.json`](results/levels/notes.json) holds the per-model notes passed to `compare --notes`.

Each saving below gives the percentage saved by the `lsp` arm over the completed pairs, followed by its 95% interval from 4,000 task draws.

| Run | Solved without server | Solved with server | Time saved, 95% interval | Cost saved, 95% interval | Called server |
|-----|-----------------------|--------------------|--------------------------|--------------------------|---------------|
| `claude-opus-5-5` in Claude Code | 237 of 243 | 243 of 243 | 29%, 23% to 35% | 32%, 26% to 37% | 240 of 243 |
| `claude-sonnet-5-5` in Claude Code | 227 of 243 | 242 of 243 | 36%, 30% to 42% | 44%, 37% to 50% | 227 of 243 |
| `claude-haiku-5-5` in Claude Code | 228 of 243 | 241 of 243 | 47%, 36% to 55% | 52%, 46% to 57% | 239 of 243 |
| `gpt-6.2-sol` in Codex CLI | 233 of 243 | 238 of 243 | 0%, -7% to 5% | not reported | 115 of 243 |
| `gpt-6.1-terra` in Codex CLI | 160 of 166 | 165 of 166 | 5%, 2% to 9% | not reported | 152 of 166 |
| `gemini-4-neon` in Antigravity CLI | 170 of 170 | 170 of 170 | 58%, 55% to 61% | not reported | 170 of 170 |

Across the three Claude models, sessions failed 37 of 729 times without the server and 3 of 729 times with it. Time and cost savings grew as the Claude model got smaller: 29% time and 32% cost for Opus, 36% and 44% for Sonnet, and 47% and 52% for Haiku. Outside Claude Code, the outcomes diverged. Sol called the server in 115 of 243 sessions and its time did not change at 0%, interval -7% to 5%. Terra called the server in 152 of 166 sessions and saved 5% of time, interval 2% to 9%. Neon called the server in all 170 sessions, solved every task in both arms, and saved 58% of time, interval 55% to 61%. Without the server, every model except Neon failed the two renames of a type whose name also stands in string literals.

Why each model landed where it did:

- **`claude-opus-5-5` in Claude Code.** Without the server, Opus refactors with shell scripts, averaging 5.4 Bash calls out of 7.8 tool calls per session. Text replacement cannot separate a type name from a string literal, which caused three of its six failures. The other three moved a function as asked and also rewrote the source module's `exposing (..)` into a list of the same names. I kept the check as written so those three count as failures and stand apart here, because the task forbids changing anything else and an explicit list no longer exposes later additions to the module. With the server, Opus drops from a median of 12 replies to 8 and solves all 243 sessions, sign test p = 0.125 on 4 tasks to 0. It cuts output tokens by 38%, interval 32% to 43%, input tokens by 16%, interval 4% to 26%, time by 29% and cost by 32%. Opus saves the least of the three Claude models because its baseline sessions already take few steps.
- **`claude-sonnet-5-5` in Claude Code.** Without the server, Sonnet also works with shell scripts, averaging 5.3 Bash calls out of 7.3 tool calls per session. It fails 16 of 243 sessions. Seven failures changed a string literal, four left the code otherwise than the removal makes it, four changed more than the task named, and one left the requested change missing. With the server, Sonnet solves 242 of 243 sessions, sign test p < 0.001 on 12 tasks to 0, and drops from a median of 11 replies to 7. It cuts output tokens by 58%, interval 51% to 63%, and input tokens by 23%, interval 9% to 35%. Its single failure with the server happened on a type rename where it called the rename tool and then replaced the type's name inside string literals itself. Sonnet skipped the server in 11 of 21 field removal sessions and solved all 16 sessions where it skipped the server.
- **`claude-haiku-5-5` in Claude Code.** Without the server, Haiku edits file by file, averaging 6.9 edits, 4.2 reads and 18.0 tool calls per session, with a median of 25 replies. With the server, one tool call performs the edit, dropping Haiku to 7.4 tool calls per session and a median of 13 replies. That cuts output tokens by 60%, interval 55% to 65%, input tokens by 42%, interval 30% to 51%, time by 47% and cost by 52%, the largest savings among the Claude models. Haiku solved 241 of 243 sessions with the server against 228 without it, sign test p = 0.008 on 8 tasks to 0. Both of its failures with the server happened on a type rename where it called the tool and then edited string literals itself.
- **`gpt-6.2-sol` in Codex CLI.** Sol finishes a task in a median of 2 replies, averaging 4.9 shell commands per session without the server and 4.2 with it, 5.1 and 4.8 total tool calls. A session that short leaves little time to save, so total time did not move at 0%, interval -7% to 5%. Input tokens grew by 11%, interval 3% to 19% more, because the prompt carries the descriptions of all 22 server tools, while output tokens fell by 14%, interval 7% to 20%. Sol called the server in 115 of 243 sessions. It called the server often for field renames, 21 of 24, variant removals, 21 of 27, and type renames, 19 of 27, and rarely for module renames, 2 of 27, added variants, 3 of 21, and field removals, 3 of 21. Sessions that called the server solved 114 of 115 tasks, while 4 of Sol's 5 failures in the `lsp` arm came from sessions that skipped the server. Without the server, 3 of Sol's 10 failures changed a non-Elm file outside the Elm project. Across tasks, Sol solved 5 more with the server and 2 more without it, sign test p = 0.453.
- **`gpt-6.1-terra` in Codex CLI.** Terra called the server in 152 of 166 sessions, cut output tokens by 26%, interval 18% to 33%, and cut input tokens by 13%, interval 0% to 24%, yet saved only 5% of time, interval 2% to 9%. Its median session time in the `lsp` arm was 65 seconds when it called the server and 66 seconds when it did not, so most of the time went to the model itself rather than to tool work. Five of its six failures without the server changed a string literal, and its single failure with the server also changed a string literal. Terra solved 4 tasks more often with the server and 0 without it, sign test p = 0.125.
- **`gemini-4-neon` in Antigravity CLI.** Without the server, Neon worked in many small steps, averaging 39.4 tool calls per session, with 14.8 edits, 12.7 reads and 11.8 shell commands. Antigravity's second-model review added delay to every edit and command. With the server, Neon called the server in all 170 sessions, dropped to 12.7 tool calls per session with only 2 file edits across all 170 sessions, and finished in a median of 80 seconds. It saved 58% of time, interval 55% to 61%, 75% of input tokens, interval 73% to 77%, and 64% of output tokens, interval 62% to 66%. Neon solved all 170 pairs in both arms, sign test p = 1.000, so for Neon the server changed time and tokens rather than the solve rate.

What these runs do not show:

- The comparisons between models rest on 81 tasks from three codebases of one owner.
- Failures pile up on a few tasks, especially the two type renames whose names appear inside string literals.
- I measured wall-clock time while other work ran on the machine.
- Codex and Antigravity report no cost, so I cannot compare cost across harnesses.

## What it does not tell you

- The tasks are refactorings the server has a dedicated tool for. Work that mostly needs reading and understanding code is not covered.
- One target per task type, codebase and level is a small sample. Raise `--repeat` to see how much sessions vary, and add codebases to see how much targets vary. Failures pile up on a few tasks, so solve rates on 81 tasks from three codebases of one owner do not predict every codebase.
- Each run measures one model in one harness at a time. Only Claude Code reports cost, so runs in Codex and Antigravity compare time and tokens rather than cost.
- `lsp` means the MCP tools and the instructions that the server sends when a session connects, which the harness shows to the model. They are notes on paths, lines and columns, and they give no advice to prefer the tools. The skill in `skills/elm-refactoring` is not loaded. In Codex, the benchmark registers the server with `omit_tools_from = ["code_mode", "deferred"]`, whereas a plain registration from `docs/harnesses.md` leaves the tools deferred behind a search.
- The sessions of both arms are started with six of Claude Code's tools named, the ones it reads, searches and edits files with: Bash, Read, Edit, Write, Grep and Glob. Neither arm has the rest of Claude Code's tools, subagents and web access among them. Codex and Antigravity sessions likewise get only their file and shell tools, without subagents, web search or other built-in tools.
- Wall-clock time reflects whatever else runs on the machine at the same time. In Antigravity, both arms also pay for a second model reviewing edits, shell commands and server calls.
- The cost of a session depends on what it finds in the API's prompt cache. The two arms have different tools, so each has a cached prompt of its own. Whether a session starts with that cache warm depends on how long ago a session of the same arm ran, and that depends on how long the other arm's sessions take. The cost of the faster arm can come out a few cents higher for that. A record holds the two counts beside `inputTokens`, which includes them: `cacheCreationInputTokens` for the tokens written to the cache and `cacheReadInputTokens` for the ones read from it.
- A session that runs `elm-format` over a file which was not formatted before can change more tokens than the rename asked for, and is then judged wrong. In the add-variant task every changed line counts, so there a change of layout alone is enough. The `lsp` arm has `elm_format` among its tools.
- Another Elm project in the same repository that shares the source directories, outside `elmRoot`, is not looked at.
- A project whose check command generates Elm sources cannot be benchmarked. A session that ran the command would be judged by what the generator wrote, and one that did not would not, so `plan` stops on such a project.
- Most environment variables of the shell that starts the benchmark reach the sessions. The ones that set the effort, the thinking and the length of an answer do not in Claude Code, as [What a run looks like](#what-a-run-looks-like) says, and `AGY_CLI_*` and Antigravity directory override variables do not in Antigravity. Some of Claude Code's act on MCP tools alone, and so on the `lsp` arm alone. Among those that Claude Code 2.1.311 reads are `MCP_TIMEOUT`, the time a server has to start, `MCP_TOOL_TIMEOUT`, the time a tool call may take, `MAX_MCP_OUTPUT_TOKENS`, the most of a tool's output that a session is shown, and `ENABLE_TOOL_SEARCH`. Its binary names more of the kind, such as `MCP_CONNECT_TIMEOUT_MS`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, `MCP_CONNECTION_NONBLOCKING` and `MCP_SERVER_CONNECTION_BATCH_SIZE`. Leave such variables unset, or set them as you mean the `lsp` arm to run. Claude Code also reads variables for its Bash tool, `BASH_MAX_OUTPUT_LENGTH` and `BASH_DEFAULT_TIMEOUT_MS` among them. Both arms have Bash, so such a variable favours neither arm by itself, but a session that works by shell commands meets it more often. The variables that a parent agent session sets for the commands it runs, such as `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` and `ANTIGRAVITY_CONVERSATION_ID`, reach no session and not the pre-flight of the MCP server, so a benchmark that an agent started runs its sessions as one started from a plain shell does. The ones that say how a harness signs in or which provider it uses stay, such as `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_USE_BEDROCK`.
- A `CLAUDE.md`, `AGENTS.md` or `GEMINI.md` that a codebase has committed is not loaded into a session, and it still lies in the checkout, where a session of either arm can open it like any file. One that recommends the language server, or names its command line, then reaches both arms.
- A rename or removal of a field on a record alias that a port carries, or that the program's flags are decoded into, changes the key that JavaScript sees. The compiler and the verdict take it for solved, in both arms alike, and the JavaScript side breaks when the program runs.
- A field rename can be impossible to solve as judged: where a value of the record is also passed for another record type with the same fields, renaming the field on one of the two needs more than a rename. Both arms then fail that task.
- With `--concurrency` above 1, the sessions that run side by side are worktrees of one repository. `git worktree list` in one of them shows where the others are, the other arm's checkout of the same task among them.
- A session that runs `ps` can see the benchmark's command line and its `--out`. With `--concurrency` above 1, it can also see another session's command line and MCP server flags. From the output directory, it can read the plan and the patch of an earlier session.
- In a package, the documentation of a module names what it documents in `@docs` lines. A renamed function, type or variant, or a removed variant, can keep its old name there and pass. Comments are no part of what the verdict compares, and only `elm make --docs` reads those lines, which a check command that builds single files does not run.
- In `move-function`, comments and the doc comment can stay behind or move, and a name written bare where the destination's import lists it by name passes though the request asks for the qualifier. A name that was qualified in the source module and is written bare through a `(..)` import of the destination fails though it compiles.
- In `remove-field`, a string with the field's name, such as a JSON key in a decoder or encoder, is no read and stays, so a session that takes it out fails.
- A module that other tooling finds by its name or its path is renamed like any other: a route of elm-pages or elm-land, or the entry of a build script that `check` does not run. Only the four modules that Lamdera looks for keep their names. A session can do such a rename right and still break a build that the benchmark never runs.
- A file outside the Elm sources can name the renamed module or its path: a page of documentation, the configuration of a linter. It is not the task's to change. A session that corrects the name there is judged wrong, and one that leaves it stale passes. A session that looks for uses by searching text meets such a mention more often than one that calls the language server.
- A target that test modules use is left out unless `check` compiles the tests. The language server now indexes `tests/`, so when `check` compiles the tests those targets are in play. When `check` does not compile the tests, how either arm handles edits that reach into `tests/` is not measured.
