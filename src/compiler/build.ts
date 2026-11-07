/**
 * Program builder (Spec §8.1, §12.4 — Phase 3).
 *
 * Turns emitted functions into the three sections `assembleProgram` expects:
 * VM_CODE, CONSTANT_POOL and FUNCTION_TABLE. It only *builds* bytes; it does not
 * assemble or run them, so a caller always decides when to pay for verification.
 *
 * The builder re-verifies nothing itself: `assembleProgram` runs the verifier on
 * the sections it is handed. That is the property the differential test relies on
 * — a program this compiler produced can only reach the VM by passing the same
 * verifier every other package faces.
 */
import { encodeInstructions, type Instruction } from '../bytecode/instruction';
import { OPCODE_BY_NAME } from '../bytecode/opcodes';
import { encodeConstantPool, type Constant } from '../bytecode/constants';
import { encodeFunctionTable, FUNCTION_FLAGS, NO_NAME, type FunctionRecord } from '../bytecode/functions';
import { errors } from '../diagnostics/errors';
import type { EmittedFunction } from './emitter';

export interface BuiltSections {
  readonly code: Buffer;
  readonly constants: Buffer;
  readonly functions: Buffer;
}

export interface FunctionFlags {
  readonly strict?: boolean;
  readonly arrow?: boolean;
}

/**
 * Concatenates emitted functions into sections, in the order given.
 *
 * Function 0 is the entry function (`assembleProgram` runs it), so the caller
 * controls ordering by position. Code offsets are section-absolute, matching the
 * function table's `codeOffset` contract, while each function's own pcs stay
 * function-relative — the coordinate space the verifier and the interpreter use.
 */
export function buildSections(
  functions: readonly EmittedFunction[],
  flags: FunctionFlags = {},
): BuiltSections {
  if (functions.length === 0) {
    throw errors.internal('buildSections: a program needs at least one function');
  }

  const chunks: Buffer[] = [];
  const records: FunctionRecord[] = [];
  const pool: Constant[] = [];
  let codeOffset = 0;

  for (const fn of functions) {
    if (fn.instructions.length === 0) {
      throw errors.internal('buildSections: an emitted function has no instructions');
    }
    // Pool indexes in a function's instructions are relative to that function's
    // own `constants` list. Rewriting them here is what keeps two functions that
    // both use constant #0 from reading each other's literals.
    const base = pool.length;
    const instructions: Instruction[] = fn.instructions.map((instruction) =>
      instruction.opcode === LOAD_CONST_ID
        ? Object.freeze({ ...instruction, imm32: base + instruction.imm32 })
        : instruction,
    );
    pool.push(...fn.constants);

    const code = encodeInstructions(instructions);
    chunks.push(code);
    records.push(
      Object.freeze({
        codeOffset,
        codeLength: code.length,
        paramCount: 0,
        localCount: fn.localCount,
        registerCount: fn.registerCount,
        maxStackHint: 0,
        flags: (flags.strict ? FUNCTION_FLAGS.STRICT : 0) | (flags.arrow ? FUNCTION_FLAGS.ARROW : 0),
        captureCount: 0,
        captureBase: 0,
        nameConstant: NO_NAME,
      }),
    );
    codeOffset += code.length;
  }

  return Object.freeze({
    code: Buffer.concat(chunks),
    constants: encodeConstantPool(pool),
    functions: encodeFunctionTable(records),
  });
}

/** `LOAD_CONST` id, resolved from the catalog rather than hard-coded. */
const LOAD_CONST_ID = (() => {
  // Resolved through the catalog so an ABI renumbering cannot silently leave the
  // rewrite above matching an unrelated opcode.
  const spec = OPCODE_BY_NAME.get('LOAD_CONST');
  if (spec === undefined) throw errors.internal('buildSections: LOAD_CONST is missing from the opcode catalog');
  return spec.id;
})();
