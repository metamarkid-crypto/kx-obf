/**
 * Compiler entry point (Spec §4.2, §8.1 — Phase 3, first slice).
 *
 * The one supported shape today is a source file containing exactly one
 * parameterless function whose body is optional `const`/`let`/`var` declarations
 * followed by a `return` of an arithmetic expression. The whole pipeline lives
 * here so the differential test exercises the same path a build will: parse →
 * emit → build sections → assemble (which verifies).
 */
import type { Program } from 'estree';
import { parseSource } from '../parser/adapter';
import { errors } from '../diagnostics/errors';
import { assembleProgram, type AssembledProgram } from '../vm/program';
import { DEFAULT_EMIT_LIMITS, emitFunction, resolveEmitLimits, type EmitLimits } from './emitter';
import { buildSections, type FunctionFlags } from './build';
import type { RawNode } from './support';
import { DEFAULT_VM_LIMITS, resolveLimits, type VmLimits } from '../vm/limits';

export { emitFunction, DEFAULT_EMIT_LIMITS, resolveEmitLimits } from './emitter';
export type { EmitLimits, EmittedFunction, EmittedBinding } from './emitter';
export { DEFAULT_VM_LIMITS };
export { buildSections } from './build';
export type { BuiltSections } from './build';

export interface CompileRequest {
  readonly source: string;
  readonly filename?: string;
  readonly emitLimits?: EmitLimits;
  readonly flags?: FunctionFlags;
  /**
   * VM limits the assembled program will run under. The compiler reads
   * `maxRegisters` from them so it never emits a function the verifier must
   * reject; assembly then runs with exactly these limits.
   */
  readonly vmLimits?: Partial<VmLimits>;
}

export interface CompiledModule {
  readonly program: AssembledProgram;
  /** Runs the compiled entry function and returns its completion. */
  readonly call: () => { readonly kind: 'return'; readonly value: unknown } | { readonly kind: 'throw'; readonly error: unknown };
}

/**
 * Compiles a source file into an assembled, verified VM program.
 *
 * Verification happens inside `assembleProgram`, so a program that reaches the
 * caller is one the verifier accepted — the compiler cannot smuggle an unchecked
 * instruction stream into the VM.
 */
export function compileSource(request: CompileRequest): CompiledModule {
  const filename = request.filename ?? '<input>';
  const parsed = parseSource({ source: request.source, filename });

  const statement = singleFunctionOf(parsed.program, filename);

  // The register budget is bound to the VM's, so a caller asking for more registers
  // than a frame can hold gets the smaller budget (and a positioned compile error
  // if the expression needs the difference) instead of a bytecode verification
  // failure that reads like a compiler bug.
  const vmLimits = resolveLimits(request.vmLimits ?? {});
  const emitLimits = resolveEmitLimits(request.emitLimits ?? DEFAULT_EMIT_LIMITS, vmLimits.maxRegisters);

  const emitted = emitFunction(statement, filename, emitLimits);
  const sections = buildSections([emitted], request.flags ?? {});

  const program = assembleProgram(
    sections,
    { resolve: () => undefined },
    request.vmLimits ?? {},
  );

  return Object.freeze({ program, call: () => program.runEntry(undefined, []) });
}

/**
 * The supported program shape: one top-level function declaration or expression.
 *
 * Function 0 is the entry function by convention (`assembleProgram` runs it), so
 * a source file with two functions would leave the entry point ambiguous — that
 * is rejected here rather than resolved by a silent "first one wins".
 */
function singleFunctionOf(program: Program, filename: string): RawNode {
  const body = program.body as unknown as readonly RawNode[];
  if (body.length !== 1) {
    throw errors.unsupported(
      `the Phase 3 emitter compiles exactly one function declaration per file (found ${body.length} top-level statement(s))`,
      { file: filename, line: 1, column: 0 },
      { feature: 'top-level statements', action: 'keep only `function f() { return <expression>; }` in the file' },
    );
  }
  const declaration = body[0] as RawNode;
  if (declaration.type !== 'FunctionDeclaration' && declaration.type !== 'FunctionExpression') {
    throw errors.unsupported(
      `${declaration.type} is not supported at the top level by the Phase 3 emitter yet`,
      { file: filename, line: 1, column: 0 },
      { feature: declaration.type, action: 'wrap the code in a function declaration with no parameters' },
    );
  }
  return declaration;
}
