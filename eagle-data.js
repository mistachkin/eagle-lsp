/**
 * Eagle language data loader - loads command/procedure docs for the LSP.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function load() {
  const cmdsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'eagle_commands.json'), 'utf8'));
  const procsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'eagle_procedures.json'), 'utf8'));

  // Build lookup maps
  const commands = new Map();
  for (const cmd of cmdsRaw) {
    commands.set(cmd.name, cmd);
  }

  const procedures = new Map();
  for (const proc of procsRaw) {
    procedures.set(proc.name, proc);
  }

  // Build subcommand lookup: "string" -> ["bytelength", "cat", ...]
  const subcommandMap = new Map();
  for (const cmd of cmdsRaw) {
    if (cmd.subcommands && cmd.subcommands.length > 0) {
      subcommandMap.set(cmd.name, cmd.subcommands);
    }
  }

  // All command names for fast completion
  const allCommandNames = cmdsRaw.map(c => c.name);
  const allProcNames = procsRaw.map(p => p.name);

  // Known Eagle keywords / control flow
  const keywords = [
    'if', 'else', 'elseif', 'then', 'for', 'foreach', 'while', 'do',
    'switch', 'break', 'continue', 'return', 'proc', 'set', 'unset',
    'catch', 'try', 'throw', 'finally', 'error', 'downlevel',
    'namespace', 'eval', 'uplevel', 'upvar', 'global', 'variable',
    'expr', 'incr', 'append', 'lappend', 'source', 'package',
  ];

  // Math functions available in expr
  const mathFunctions = [
    'acos', 'asin', 'atan', 'atan2', 'cos', 'cosh', 'sin', 'sinh',
    'tan', 'tanh', 'exp', 'log', 'log10', 'log2', 'logx', 'pow',
    'sqrt', 'ceil', 'floor', 'round', 'round2', 'round3', 'truncate',
    'abs', 'fmod', 'hypot', 'sign', 'max', 'min',
    'isfinite', 'isinf', 'isnan', 'isnormal', 'issubnormal', 'isunordered',
    'rand', 'random', 'randstr', 'srand',
    'bool', 'double', 'int', 'entier', 'wide', 'decimal',
    'e', 'pi', 'epsilon', 'typeof', 'datetime', 'timespan', 'flags', 'list',
  ];

  // Classes for "string is" command
  const stringIsClasses = [
    'alnum', 'alpha', 'ascii', 'control', 'digit', 'graph', 'lower',
    'print', 'punct', 'space', 'upper', 'wordchar', 'xdigit',
    'boolean', 'integer', 'wideinteger', 'entier', 'double', 'decimal',
    'asciialnum', 'asciialpha', 'asciidigit', 'base64', 'byte', 'cidr',
    'command', 'datetime', 'dict', 'directory', 'element', 'encoding',
    'false', 'file', 'guid', 'hexadecimal', 'identifier', 'inetaddr',
    'interpreter', 'list', 'none', 'number', 'numeric', 'object',
    'path', 'real', 'single', 'timespan', 'true', 'type', 'uri',
    'version', 'versionrange',
  ];

  // String/list operators used in expr
  const exprOperators = [
    'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'in', 'ni',
  ];

  return {
    commands, procedures, subcommandMap, allCommandNames, allProcNames,
    keywords, mathFunctions, stringIsClasses, exprOperators,
  };
}

module.exports = { load };
