/**
 * Program assembly (Spec §9.1, §10.1, §13.4 step 7).
 *
 * Turns verified, decoded sections into the `VmProgram` the interpreter runs.
 * Verification happens here, exactly once, before any instruction executes and
 * after every section has been authenticated and decompressed.
 */
import { errors } from '../diagnostics/errors';
import { decodeInstructions, type Instruction } from '../bytecode/instruction';
import { type Constant, decodeConstantPool } from '../bytecode/constants';
import { decodeFunctionTable, type FunctionRecord, hasFlag, FUNCTION_FLAGS } from '../bytecode/functions';
import {
  decodeExceptionTable,
  groupRecordsByFunction,
  type ExceptionRecord,
  type FunctionExceptionTable,
} from '../bytecode/exceptions';
import { verifyBytecode } from '../bytecode/verifier';
import { IDENTITY_OPMAP } from '../bytecode/opcodes';
import { resolveLimits, enforceLimit, type VmLimits } from './limits';
import { Interpreter, materializeConstant, type Capability, type VmCompletion } from './interpreter';
// Side-effect import: registers the opcode dispatch with the interpreter. Any
// module that assembles a program must guarantee dispatch is installed before the
// first instruction runs, so it is wired here rather than left to the caller.
import './dispatch';

export interface SectionBundle {
  readonly code: Buffer;
  readonly constants: Buffer;
  readonly functions: Buffer;
  readonly exceptions?: Buffer;
  /** Per-build opcode mapping from VM_CONFIG, when diversification is enabled. */
  readonly opmap?: readonly number[];
  readonly capabilityIds?: readonly string[];
}

export interface RuntimeCapabilities {
  /** Resolves a capability id to an implementation, or undefined when denied. */
  readonly resolve: (id: string) => Capability | undefined;
}

export interface AssembledProgram {
  readonly interpreter: Interpreter;
  readonly functions: readonly FunctionRecord[];
  readonly constants: readonly Constant[];
  /** Records in table order (function-relative pcs), as stored in the package. */
  readonly exceptions: readonly ExceptionRecord[];
  /**
   * The same records grouped per function, keeping their function-relative pcs —
   * the coordinate space a frame's `pc` lives in. This is what the interpreter
   * consults during unwinding: a frame only ever sees the entries of its own
   * body, so no neighbouring function's protected range can capture its throw.
   */
  readonly functionExceptions: readonly FunctionExceptionTable[];
  readonly instructions: readonly Instruction[];
  readonly limits: VmLimits;
  /** Runs the CommonJS entry function (function 0) and forwards its completion. */
  readonly runEntry: (thisValue: unknown, args: readonly unknown[]) => VmCompletion;
}

export function assembleProgram(
  sections: SectionBundle,
  host: RuntimeCapabilities,
  limitOverrides: Partial<VmLimits> = {},
): AssembledProgram {
  const limits = resolveLimits(limitOverrides);

  enforceLimit('maxSectionBytes', sections.code.length, limits);
  enforceLimit('maxSectionBytes', sections.constants.length, limits);
  enforceLimit('maxSectionBytes', sections.functions.length, limits);

  const constantPool = decodeConstantPool(sections.constants, {
    maxConstants: limits.maxConstants,
    maxConstantBytes: limits.maxConstantBytes,
  });
  const functionTable = decodeFunctionTable(sections.functions);
  enforceLimit('maxFunctions', functionTable.functions.length, limits);
  if (functionTable.functions.length === 0) {
    throw errors.bytecodeVerify('function table is empty; a program needs an entry function');
  }

  const exceptionTable = sections.exceptions
    ? decodeExceptionTable(sections.exceptions)
    : { records: [] as readonly ExceptionRecord[], consumed: 0, version: 1 };
  enforceLimit('maxExceptionRecords', exceptionTable.records.length, limits);

  const opmap = sections.opmap ?? IDENTITY_OPMAP;
  if (opmap.length !== 256) {
    throw errors.abi(`opcode map must have 256 entries, got ${opmap.length}`);
  }

  const verified = verifyBytecode({
    functions: functionTable.functions,
    codeBytes: sections.code,
    constantCount: constantPool.constants.length,
    importCount: sections.capabilityIds?.length ?? 0,
    exceptionRecords: exceptionTable.records,
    opmap,
    maxRegisters: limits.maxRegisters,
    maxFrameSlots: limits.maxFrameSlots,
  });

  for (const fnInstructions of verified.functionInstructions) {
    enforceLimit('maxInstructionsPerFunction', fnInstructions.length, limits);
  }

  const capabilities: Capability[] = (sections.capabilityIds ?? []).map((id) => {
    const resolved = host.resolve(id);
    if (resolved === undefined) {
      // A missing capability is a build/deployment mismatch, not an application
      // error: fail before execution with a typed capability error.
      throw errors.capability(`capability "${id}" is declared by the package but not provided by the host`, undefined, {
        feature: id,
        action: 'add the capability to the runtime host configuration or rebuild without it',
      });
    }
    return resolved;
  });

  const constants = constantPool.constants.map(materializeConstant);

  // Exception records are function-local in v2: group them once, here, so the
  // interpreter's unwinding path is a lookup in an array rather than a scan of
  // every record with an origin check per candidate.
  const functionExceptions = groupRecordsByFunction(
    exceptionTable.records,
    functionTable.functions.length,
  );

  const interpreter = new Interpreter({
    functions: functionTable.functions,
    functionInstructions: verified.functionInstructions,
    constants,
    exceptions: functionExceptions,
    capabilities,
    globalThisValue: undefined,
    limits,
    opmap,
  });

  const entry = functionTable.functions[0] as FunctionRecord;
  const entryClosure = Object.freeze({
    functionId: 0,
    captures: Object.freeze([]),
    thisValue: undefined,
    argumentsValue: undefined,
    strict: hasFlag(entry.flags, FUNCTION_FLAGS.STRICT),
    isAsync: hasFlag(entry.flags, FUNCTION_FLAGS.ASYNC),
    isArrow: false,
    name: '<entry>',
  });

  return Object.freeze({
    interpreter,
    functions: functionTable.functions,
    constants: constantPool.constants,
    exceptions: exceptionTable.records,
    functionExceptions,
    instructions: verified.instructions,
    limits,
    runEntry: (thisValue: unknown, args: readonly unknown[]) =>
      interpreter.call({ functionId: 0, closure: entryClosure, args, thisValue }),
  });
}

/** Re-decodes the instruction stream for `inspect`, without executing anything. */
export function inspectCode(bytes: Buffer): readonly Instruction[] {
  return decodeInstructions(bytes);
}
