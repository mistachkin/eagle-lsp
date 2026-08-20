# Changelog

All notable changes to the Eagle Scripting Language extension will be documented
in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The brace scanner now tracks word *ends* as well as word starts:
  characters directly after a closed braced or quoted word are reported
  as "Extra characters after close-brace/close-quote" (e.g. `set x {a}}`,
  `set x {a}{b`, `set x "a"}`), exactly as real Tcl rejects them — while
  legal mid-word braces (`puts a}b`, `set x prefix{suffix`) stay
  unflagged.
- `${` now begins a braced variable name even mid-word (no nesting, no
  escapes), so an unterminated `set x ${y` is reported as "Missing
  close-brace for variable name" and `pre${y}post` is accepted.
- A line continuation inside a double-quoted string no longer leaks
  word-start state through the closing quote.
- The scanner's word-position flags were consolidated into a single
  four-state variable (command start / word start / in word / after
  close), making the state invariants explicit.
- False "Unmatched closing brace" diagnostics: `#` now starts a comment only
  in command position — `uplevel #0 { ... }`, `set c #ff0000`, and similar
  words are no longer swallowed as comments (#1).
- The brace scanner now matches Tcl's lexical rules inside braced words
  (`#`, `;`, `"`, `[`, and `]` are literal there), honours line
  continuations on both LF and CRLF documents with backslash escape
  parity, and continues comments across a trailing backslash.
- Unclosed `{` / `[` are now reported at the opener when the document
  ends, matching Tcl's "missing close-brace" behaviour.
- Diagnostics from the brace scanner are capped so a pathological
  document cannot crash validation or flood the client.
- The parser and the brace scanner now share one line-continuation and
  comment-position rule (`eagle-brace.js`), so the two diagnostic passes
  can no longer disagree.

### Added

- Unit tests for the brace scanner (`npm test`, Node's built-in runner);
  every expectation is cross-checked against real `tclsh` behaviour.

## [1.0.3] - 2026-06-25

### Added

- `scan` command (the inverse of `format`) — full documentation, completion,
  hover, signature help, and syntax highlighting.

## [1.0.2] - 2026-03-06

### Added

- `dict` command with all 20 sub-commands (append, create, exists, filter,
  foreach, get, incr, info, keys, lappend, map, merge, remove, replace, set,
  size, unset, update, values, with) — full documentation, completion,
  hover, and signature help.

## [1.0.1] - 2026-02-14

### Added

- Terminal window using configured / default Eagle binary directory.
- Simplified packaging process via use of the bundling feature.

## [1.0.0] - 2026-02-12

### Added

- Initial release of Eagle Scripting Language for VS Code.
- Syntax highlighting for `.eagle`, `.eeagle`, `.ruleSet`, `.tcl`, `.tk`,
  `.itcl`, and `.itk` files.
- Autocompletion for 120+ built-in commands, subcommands, options, and 135+
  library procedures.
- Hover documentation with synopsis, description, options, and examples.
- Signature help showing usage patterns as you type command arguments.
- Diagnostics for unmatched braces/brackets and unknown command hints.
- Document symbols for procedures, namespaces, packages, and variables.
- Go-to-definition for user-defined procedures and variables.
- Find-all-references for symbols within a file.
- Folding ranges for brace blocks and comment blocks.
