# clice-e2e

[![test](https://github.com/lightovernight/clice-e2e/actions/workflows/test.yml/badge.svg)](https://github.com/lightovernight/clice-e2e/actions/workflows/test.yml)

A crash finder for [clice](https://github.com/clice-io/clice), the C++ language server.

It takes a finished C++ file, pretends to type it into an editor one character at a time, and sends every keystroke to a real clice over LSP. After each keystroke it asks clice for completions and folding ranges, the way an editor would. If clice crashes, hangs, or answers with garbage at any point, the run fails and keeps everything needed to reproduce it.

You do not need to build clice. Any installed clice works, including the one bundled with the VS Code extension.

## Quick start

You need Node.js 20 or newer and an installed clice.

```powershell
npm ci                               # install dependencies (once)
npm run setup                        # find clice and write local config (once)
npm test                             # unit tests; no real clice needed
npm run e2e -- examples/lambda.cpp   # type examples/lambda.cpp into clice
```

The last command prints a summary like this:

```json
{
  "status": "PASS",
  "completedSteps": 73,
  "totalSteps": 73,
  "firstFailure": null,
  "outputDirectory": "C:\\src\\clice-e2e\\output\\runs\\20260930-223632-lambda"
}
```

- **PASS**: every request got a valid answer and clice never crashed.
- **FAIL**: clice did something wrong. `firstFailure` says what and at which keystroke. The output directory has the full story.
- **ERROR**: the problem is on our side (bad input, missing file, a bug in this tool), not in clice.

The exit code is 0, 1 or 2 for these three cases.

## Testing your own file

Point it at the file, its project root, and the project's `compile_commands.json`:

```powershell
npm run e2e -- C:/work/app/src/parser.cpp --project C:/work/app --compile-commands C:/work/app/build/compile_commands.json
```

If you test the same project often, add it to `clice-e2e.json` (see [Local config](#local-config)) and drop the two options.

Big files take a while. Use `--max-steps 1000` to type only the first 1000 characters.

## Typing modes

**`--typing serial`** (default) types one character, waits until every request is answered, then types the next. Slow, but a failure points at one exact keystroke.

**`--typing burst`** types like a person who does not pause. All characters of one word or one run of spaces are sent back to back, without waiting for answers, and some of those requests are cancelled. Only at the end of each word must every request succeed. This exercises the parts of clice that deal with "the text changed while I was still working on the old version", which serial mode never reaches. It is also 2–3 times faster.

## Running in WSL

clice is noticeably faster on Linux. If you have WSL with Node.js 20+ and a Linux clice, run the same commands through `npm run wsl`:

```powershell
npm run wsl -- e2e examples/lambda.cpp --typing burst
```

This copies the tool into `~/clice-e2e` inside WSL, builds it there and runs it. A Windows path to a single file (`C:/.../file.cpp`) is copied in automatically. Results land in `~/clice-e2e/output/runs`.

The first run writes `~/clice-e2e/clice-e2e.json` with a clice found on the Linux `PATH`. If yours is elsewhere, edit the `clice` field in that file once.

If you kill the Windows side of a WSL run, the Linux side keeps going. `npm run wsl:stop` shuts it down cleanly.

## What a run leaves behind

By default a passing run keeps only a few small files: `result.json`, `run.json`, the generated keystroke sequence and the source. A failing run also keeps the last few hundred LSP messages before the failure, everything after it, clice's logs, and the document text at the moment it broke.

Pass `--record full` to keep everything for every run. That can be hundreds of MB for a large file.

To replay a saved run exactly:

```powershell
npm run replay -- <outputDirectory>/sequence.jsonl
```

## Options

| Option | What it does |
| --- | --- |
| `--max-steps N` | Type only the first N characters. |
| `--typing burst` | Burst typing, see above. `--seed N` picks a different set of cancelled requests. |
| `--probes a,b` | Which requests to send after each keystroke. Default `completion,foldingRange`; `all` sends nine kinds. |
| `--include-checks character` | Also send requests while typing `#include` lines. By default those characters are typed but not checked, because every one of them rebuilds clice's precompiled header. |
| `--record full` | Keep all files for every run. |
| `--project`, `--compile-commands`, `--clice`, `-o` | Override the values in `clice-e2e.json`. `-o` must be a directory that does not exist yet. |

Run any command with `--help` for the full list. `npm run generate -- file.cpp -o seq.jsonl` writes the keystroke sequence without starting clice.

## Local config

`npm run setup` writes `clice-e2e.json` in the project root. It holds the paths that differ between machines, so you do not have to type them every time. Command-line options always win.

```json
{
  "clice": "C:/Users/me/.vscode/extensions/clice-io.clice-<version>-win32-x64/clice/bin/clice.exe",
  "outputRoot": "output/runs",
  "projects": [
    { "root": "examples", "compileCommands": "examples/compile_commands.json" },
    { "root": "C:/work/app", "compileCommands": "C:/work/app/build/compile_commands.json" }
  ]
}
```

- `clice`: the executable to test. The VS Code extension moves to a new folder on every update; when that happens, delete this file and run `npm run setup` again.
- `outputRoot`: where runs go when you do not pass `-o`. Each run gets a folder named after the time and the source file.
- `projects`: when you test a file under one of these roots, its compile database is used automatically.

Relative paths are relative to the config file. The file is machine-specific and not meant to be committed; [clice-e2e.example.json](clice-e2e.example.json) is a template.

## Project layout

```
src/
  cli.ts            command-line entry: generate | replay | e2e
  sequence/         C++ source → keystroke sequence (offline, knows nothing about LSP)
  lsp/              LSP connection and the request types we send
  clice/            starting clice, spotting crashes, deciding PASS / FAIL / ERROR
  replay/           one run: config, session, recording, typing modes
test/               mirrors src/; fixtures/ has fake servers that stand in for clice
scripts/            setup.js, wsl.sh, run-tests.js
examples/           small sample files, including the reproducer for clice issue #701
```

Runs go to `output/` unless `outputRoot` says otherwise; it is ignored by git.

## License

[Apache License 2.0](LICENSE), the same as clice.
