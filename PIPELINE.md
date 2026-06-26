# Data Pipeline & How the Command/Procedure Data Stays in Sync

This document explains where the LSP's static data (`data/eagle_commands.json`
and `data/eagle_procedures.json`) comes from, how the build-time extraction
works, and — most importantly — **how to add or update a command so that every
layer stays in sync**. It complements the high-level diagram in
[`README.md`](README.md#architecture); read this when you are changing the data,
not just consuming it.

## TL;DR

- `data/eagle_commands.json` is a **generated artifact**. The ultimate source of
  truth for *which commands exist* (and their group, flags, sub-commands, and
  options) is the **Eagle C# source tree**, not this repo.
- Human-readable text (description, synopsis, examples) comes from the **Eagle
  documentation repository** (the `docs` repo — `core_language.md` et al.).
- A hand-edit to `data/eagle_commands.json` will be **silently lost** the next
  time the extractor runs unless the same change is reflected in the upstream
  sources (the C# source and the docs markdown). Keep them in lock-step.

## The chain of sources

```text
        SOURCE OF TRUTH                         GENERATED / BUILD                     CONSUMED AT RUNTIME
        ===============                         ================                      ===================

  Eagle C# source tree
    BuiltIns.cs       (command list,
                       group, flags)
    Commands/*.cs     (sub-commands)  ──┐
    CommandOptions.cs (options)         │   docs/tools/scan_commands.eagle
                                        ├─► (verifies coverage; --json emits the
  Eagle docs repo ("docs")             │    registered command/sub-command/option
    core_language.md  (per-command     │    inventory) ───────────────┐
                       reference:      │                              │
                       synopsis,       │                              ▼
                       description,    │                        commands.json
                       examples) ──────┤                        (structured command
    core_script_library.md (library   │                         inventory: name,
                            procedures)│                         group, usages,
                                        │                        subcommands,
    (generated docs tree)              │                        options, flags)
    EAGLE_COMMAND_REFERENCE.md         │                              │
    per-command *.html ────────────────┘                              ▼
                                                          extract_docs.py ─► data/eagle_commands.json ─┐
                                                          data/extract.py ─► data/eagle_procedures.json ┤
                                                                                                        ▼
                                                                                                  eagle-data.js
                                                                                                        │ load()
                                                                                                        ▼
                                                                                            server.js (LSP handlers)
```

### Per-field provenance (`data/eagle_commands.json`)

| Field | Comes from |
|-------|-----------|
| `name` | `commands.json` (ultimately `BuiltIns.cs` — `typeof(_Commands.X)`) |
| `group` | `commands.json` (ultimately the group column in `BuiltIns.cs`) |
| `subcommands` | `commands.json` (ultimately each `Commands/*.cs` `EnsembleDictionary`) |
| `options` | `commands.json` (ultimately `CommandOptions.cs`) |
| `synopsis` | `EAGLE_COMMAND_REFERENCE.md` if present, else cleaned `usages` from `core_language.md` |
| `description` | `EAGLE_COMMAND_REFERENCE.md` brief → `core_language.md` brief → HTML brief (first available) |
| `examples` | `EAGLE_COMMAND_REFERENCE.md` (the markdown command reference) |

`core_language.md` entries are recognized by their anchor + bold-name shape, which
the extractor parses literally:

```markdown
<a id="cmd-NAME"></a>
- **NAME** - one-line brief
  - `NAME usage ?args?`
  - longer description...
```

### `scan_commands.eagle` vs. `commands.json`

`docs/tools/scan_commands.eagle` reads the Eagle C# source directly and is the
authoritative *coverage checker*:

```sh
eagle tools/scan_commands.eagle            # human-readable coverage report
eagle tools/scan_commands.eagle --check    # exit 1 if any documented count is stale
eagle tools/scan_commands.eagle --write    # (re)write tools/command_inventory.md
eagle tools/scan_commands.eagle --json     # {commands, doc_checks, undocumented_ensembles}
```

Its `--json` output is keyed by command name (`{"scan": {"registered": 1,
"files": ["Scan.cs"], "subcommands": []}, ...}`) and is the canonical answer to
"is this command registered, and what are its sub-commands?". Note this shape
differs from the richer `commands.json` the Python extractor consumes (a list of
`{command_name, group, usages, subcommands, options, flags}`); treat
`scan_commands.eagle --json` as the inventory/verification feed and `commands.json`
as the structured build input derived from the same C# source.

`tools/command_inventory.md` is a **generated snapshot** (do not hand-edit;
re-run with `--write`). It only tracks ensemble commands and commands with a
dedicated doc file, so simple commands such as `scan` legitimately do not appear
there.

## Adding or updating a command — the checklist

Worked against the real example of adding **`scan`** (the inverse of `format`):

1. **Register it in the Eagle C# source** (source of truth). `scan` is
   `typeof(_Commands.Scan)` in `BuiltIns.cs`, group `"string"`, flags
   `Core | Safe | Standard`, implemented in `Commands/Scan.cs`. Until this is
   present, nothing downstream can see the command.

2. **Verify the scanner sees it:**
   ```sh
   eagle tools/scan_commands.eagle --json | grep '"scan"'
   #  "scan": {"registered": 1, "files": ["Scan.cs"], "subcommands": []}
   ```

3. **Document it in the docs repo reference** — add a `<a id="cmd-scan"></a>`
   section to `core_language.md` (alongside `format`) with the synopsis,
   description, conversion specifiers, and an example block. This is what
   populates the `description`/`synopsis`/`examples` for the LSP. Verify every
   example against a real interpreter (and, for behavior that must match Tcl,
   against the Tcl 8.4 oracle) before committing it.

4. **Regenerate the structured inventory** (`commands.json`) and any
   `command_inventory.md` snapshot if the command is an ensemble.

5. **Re-run the extractor** to regenerate the LSP data:
   ```sh
   python3 extract_docs.py        # rebuilds data/eagle_commands.json
   python3 data/extract.py        # rebuilds data/eagle_procedures.json
   ```
   `scan` then appears as group `string`, with the description/synopsis/examples
   pulled from `core_language.md`.

6. **Add it to the editor grammar** for syntax highlighting:
   `editors/vscode/syntaxes/eagle.tmLanguage.json`, the `builtin-command` match
   (alphabetically — `scan` sits between `rename` and `scope`). Simple commands
   are *not* keywords, so they do **not** go in `eagle-data.js`'s static
   `keywords` list.

7. **Bump the version and changelog** (`package.json`,
   `editors/vscode/package.json`, the lockfiles, `server.js`'s `serverInfo`, and
   `CHANGELOG.md`).

8. **Sanity-check the runtime load:**
   ```sh
   node -e "const {load}=require('./eagle-data'); const d=load(); \
     console.log(d.commands.get('scan'));"
   ```

## Keeping things in sync — gotchas

- **`data/eagle_commands.json` / `data/eagle_procedures.json` are generated.**
  If you hand-edit them (a quick fix), mirror the change in the upstream sources
  (C# for structure, `core_language.md` for prose) or it disappears on the next
  extraction.
- **`tools/command_inventory.md` is generated** — never hand-edit; re-run
  `scan_commands.eagle --write`.
- **A command missing from the LSP data usually means a stale `commands.json`,**
  not a code bug — the command exists in `BuiltIns.cs` but the inventory used to
  build the JSON predates it. Regenerate.
- **Line endings:** any tooling that rewrites `.eagle` / `.tcl` source must
  preserve the file's original line endings (CRLF is the Eagle script-source
  default) — rewriting CRLF as LF invalidates detached Harpy signatures. See the
  docs repo's `tools/README.md` for the binary read/write pattern.
