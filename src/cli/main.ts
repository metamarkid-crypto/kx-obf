#!/usr/bin/env node
/**
 * KX-OBH CLI entry point (Spec §3.3, §16).
 *
 * Exit codes are stable (Spec §16.3) and every failure path prints a safe
 * diagnostic. No command modifies process.env, and none sabotages debugging.
 */
import { loadNodeTargets, currentNodeMajor, untestedDeclaredMajors } from '../config/node-targets';
import { errors, toKxobhError, EXIT_CODES, type ExitCode } from '../diagnostics/errors';
import { PARSER_NAME, PARSER_VERSION } from '../parser/adapter';

export const TOOL_VERSION = '1.0.0';
/** Format versions this build emits and accepts (Spec §22). */
export const FORMAT_VERSION = '1.0.0';
export const VM_ABI_VERSION = '1.0.0';

const HELP_TEXT = `kxobh ${TOOL_VERSION} — KX-OBH JavaScript protection toolchain

USAGE
  kxobh <command> [options]

COMMANDS
  build <input.js> --out <output.js> [options]   Compile and package an application
  verify <output.js>                             Validate a protected artifact without executing it
  inspect <output.js>                            Print safe package metadata only
  doctor [--node-target <major>]                 Report environment and target compatibility
  keygen --out <directory>                       Generate an optional Ed25519 release keypair
  version                                        Print version information
  help                                           Print this help

BUILD OPTIONS
  --profile balanced|advanced|maximum            Diversification profile (default: balanced)
  --module commonjs                              Module model (v1.0: commonjs only)
  --target-node <majors>                         Comma-separated Node major versions
  --allow-builtin <module>                       Allow a Node built-in (repeatable)
  --allow-package <package>                      Allow an external package (repeatable)
  --signing-key <path>                           Local Ed25519 private key (build-time only)
  --require-signature                            Fail the build when no valid signer is configured
  --compression brotli|none                      Section compression (default: brotli)
  --report <path>                                Write a JSON build report
  --diagnostic                                   Emit extra local compiler diagnostics
  --no-color                                     Disable ANSI colour

AUTHORIZED USE
  Use this tool only on software you own or are explicitly authorized to package.
  KX-OBH raises the cost of static source recovery. It does not make client-side
  logic unrecoverable, and embedded decryption material is not a secret.
`;

export interface CliResult {
  readonly exitCode: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

/** Structural result used by tests; the entry point maps it to process exit. */
function ok(stdout: string): CliResult {
  return { exitCode: EXIT_CODES.SUCCESS, stdout, stderr: '' };
}

function fail(error: ReturnType<typeof toKxobhError>): CliResult {
  return { exitCode: error.exitCode, stdout: '', stderr: `${error.format()}\n` };
}

interface ParsedArgv {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

/** Minimal, dependency-free argv parser. Boolean flags store an empty array. */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const booleanFlags = new Set(['--diagnostic', '--no-color', '--require-signature', '--bundle-dependencies']);
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const name = token.slice(0, eq);
        const value = token.slice(eq + 1);
        pushFlag(flags, name, value);
        continue;
      }
      if (booleanFlags.has(token)) {
        pushFlag(flags, token, '');
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        pushFlag(flags, token, '');
        continue;
      }
      pushFlag(flags, token, next);
      i += 1;
      continue;
    }
    if (command === '') {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

function pushFlag(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name);
  if (existing) {
    existing.push(value);
  } else {
    flags.set(name, [value]);
  }
}

function single(flags: ParsedArgv['flags'], name: string): string | undefined {
  const values = flags.get(name);
  return values && values.length > 0 ? values[values.length - 1] : undefined;
}

/** `kxobh doctor` — reports real environment facts, never guessed ones. */
export function runDoctor(flags: ParsedArgv['flags']): CliResult {
  const config = loadNodeTargets();
  const current = currentNodeMajor();
  const requested = single(flags, '--node-target');
  const lines: string[] = [];

  lines.push(`kxobh        ${TOOL_VERSION}`);
  lines.push(`format       ${FORMAT_VERSION}`);
  lines.push(`vm abi       ${VM_ABI_VERSION}`);
  lines.push(`parser       ${PARSER_NAME} ${PARSER_VERSION}`);
  lines.push(`node (host)  ${process.versions.node}`);
  lines.push('');

  if (current === null) {
    lines.push('node major   unknown');
  } else {
    const declared = config.declared.includes(current);
    const tested = config.testedOnHost.includes(current);
    lines.push(`node major   ${current} (declared: ${declared ? 'yes' : 'no'}, tested: ${tested ? 'yes' : 'no'})`);
    if (!declared) {
      return {
        exitCode: EXIT_CODES.NODE_COMPAT,
        stdout: `${lines.join('\n')}\n`,
        stderr: `${errors.nodeVersion(
          `Node ${current} is outside the declared target range (${config.declared.join(', ')})`,
        ).format()}\n`,
      };
    }
  }

  lines.push(`declared     ${config.declared.join(', ')}`);
  lines.push(`tested       ${config.testedOnHost.length > 0 ? config.testedOnHost.join(', ') : '(none)'}`);

  const untested = untestedDeclaredMajors(config);
  if (untested.length > 0) {
    lines.push(`untested     ${untested.join(', ')} (declared only — do not advertise as verified)`);
  }

  if (requested !== undefined) {
    const major = Number.parseInt(requested, 10);
    if (!Number.isInteger(major)) {
      return { exitCode: EXIT_CODES.USAGE, stdout: `${lines.join('\n')}\n`, stderr: `${errors.config(
        `--node-target expects an integer major version, received "${requested}"`,
      ).format()}\n` };
    }
    const supported = config.declared.includes(major);
    lines.push('');
    lines.push(`requested    ${major} -> ${supported ? 'declared' : 'NOT declared'}`);
    if (!supported) {
      return {
        exitCode: EXIT_CODES.NODE_COMPAT,
        stdout: `${lines.join('\n')}\n`,
        stderr: `${errors.nodeVersion(`Node ${major} is not a declared target`).format()}\n`,
      };
    }
  }

  return ok(`${lines.join('\n')}\n`);
}

function notImplemented(command: string, phase: string): CliResult {
  const error = errors.internal(`${command} is not available in this build: ${phase} has not passed its gate`);
  return { exitCode: error.exitCode, stdout: '', stderr: `${error.format()}\n` };
}

/**
 * Pure dispatcher. Returns a result instead of calling process.exit so the whole
 * surface is testable in-process.
 */
export function run(argv: readonly string[]): CliResult {
  try {
    const parsed = parseArgv(argv);
    switch (parsed.command) {
      case '':
      case 'help':
      case '--help':
      case '-h':
        return ok(HELP_TEXT);

      case 'version':
      case '--version':
      case '-v':
        return ok(
          `${[
            `kxobh ${TOOL_VERSION}`,
            `format ${FORMAT_VERSION}`,
            `vm-abi ${VM_ABI_VERSION}`,
            `parser ${PARSER_NAME}@${PARSER_VERSION}`,
            `node ${process.versions.node}`,
          ].join('\n')}\n`,
        );

      case 'doctor':
        return runDoctor(parsed.flags);

      case 'build':
        return notImplemented('build', 'Phase 3+ (compiler, VM, package format)');
      case 'verify':
        return notImplemented('verify', 'Phase 5+ (package verifier)');
      case 'inspect':
        return notImplemented('inspect', 'Phase 5+ (package parser)');
      case 'keygen':
        return notImplemented('keygen', 'Phase 5 (Ed25519 signing)');

      default: {
        const error = errors.config(`Unknown command "${parsed.command}"`);
        return { exitCode: error.exitCode, stdout: '', stderr: `${error.format()}\nRun "kxobh help" for usage.\n` };
      }
    }
  } catch (cause) {
    return fail(toKxobhError(cause));
  }
}

/** Executes the CLI against the real process and returns the exit code. */
function main(argv: readonly string[]): number {
  const result = run(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
