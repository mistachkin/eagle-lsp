# Changelog

All notable changes to the Eagle Scripting Language extension will be documented
in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
