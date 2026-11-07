/**
 * Parser adapter (Spec §4.2, Phase 0).
 *
 * All parsing goes through acorn and surfaces an ESTree `Program`. Regex is never
 * used to parse JavaScript. Parser upgrades stay contained inside this module:
 * the rest of the toolchain consumes a normalized, documented AST shape.
 */
import * as acorn from 'acorn';
import type { Node, Program } from 'estree';
import { errors, type SourcePosition } from '../diagnostics/errors';

export const PARSER_NAME = 'acorn' as const;
export const PARSER_VERSION = acorn.version;

export interface ParseRequest {
  /** Source text. */
  readonly source: string;
  /** Logical filename used in diagnostics (never an absolute build path in output). */
  readonly filename: string;
  /** Accepted for future module support; v1.0 requires CommonJS source. */
  readonly allowModules?: boolean;
}

export interface ParseResult {
  readonly program: Program;
  readonly parser: { readonly name: typeof PARSER_NAME; readonly version: string };
  readonly comments: readonly string[];
}

/** Hard cap so a pathological input cannot exhaust memory during parsing. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * Maps an acorn position offset to a 1-based line / 0-based column.
 * Acorn reports `loc` already, but this keeps diagnostics independent of that.
 */
export function offsetToPosition(source: string, offset: number, filename: string): SourcePosition {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lastBreak = i;
    }
  }
  return { file: filename, line, column: clamped - lastBreak - 1 };
}

/**
 * Parses CommonJS JavaScript into an ESTree program.
 *
 * Deliberately permissive at the parser level: semantic support is decided by the
 * syntax validator in Phase 1, which produces precise unsupported-feature errors.
 * Parser acceptance never implies compiler support.
 */
export function parseSource(request: ParseRequest): ParseResult {
  const { source, filename } = request;
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw errors.parse(
      `Input source is ${bytes} bytes, exceeding the ${MAX_SOURCE_BYTES} byte limit`,
      { file: filename, line: 1, column: 0 },
      { action: 'split the application into smaller modules or raise the configured limit' },
    );
  }

  const comments: string[] = [];

  let program: Program;
  try {
    program = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: request.allowModules === true ? 'module' : 'script',
      locations: true,
      ranges: true,
      preserveParens: false,
      allowHashBang: true,
      // Permissive so the Phase 1 validator can classify ESM and top-level await
      // with a precise position instead of a bare syntax error. Parsing this way
      // never implies the compiler supports them.
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      onComment: (block: boolean, text: string) => {
        // Comments are captured only so the leakage test can assert they are absent
        // from artifacts. They are never carried into bytecode or metadata.
        comments.push(block ? `/*${text}*/` : `//${text}`);
      },
    }) as unknown as Program;
  } catch (cause) {
    const position = acornPosition(cause, source, filename);
    const message = cause instanceof Error ? cause.message : String(cause);
    throw errors.parse(message, position, {
      action: 'fix the syntax error reported by the parser',
    });
  }

  assertEstreeProgram(program, filename);
  return {
    program,
    parser: { name: PARSER_NAME, version: PARSER_VERSION },
    comments: Object.freeze(comments),
  };
}

/** Extracts acorn's error position when present. */
function acornPosition(cause: unknown, source: string, filename: string): SourcePosition {
  if (typeof cause === 'object' && cause !== null && 'pos' in cause) {
    const pos = (cause as { pos?: unknown }).pos;
    if (typeof pos === 'number') return offsetToPosition(source, pos, filename);
  }
  return { file: filename, line: 1, column: 0 };
}

/** Structural guard: the adapter contract is an ESTree Program. */
function assertEstreeProgram(program: Node, filename: string): void {
  if (program.type !== 'Program' || !Array.isArray(program.body)) {
    throw errors.parse('Parser did not return an ESTree Program node', {
      file: filename,
      line: 1,
      column: 0,
    });
  }
}
