/**
 * 12-byte instruction codec (Spec §9.2 — VM ABI v1.0).
 *
 *   offset 0  size 1  opcode   stored (possibly remapped) opcode byte
 *   offset 1  size 1  flags    operation-specific; undefined bits must be zero
 *   offset 2  size 2  dst      destination register or ABSENT
 *   offset 4  size 2  a        first source register or operation-specific index
 *   offset 6  size 2  b        second source register or operation-specific index
 *   offset 8  size 4  imm32    immediate, signed branch offset, or constant index
 *
 * All multi-byte integers are little-endian.
 */
import { errors } from '../diagnostics/errors';

export const INSTRUCTION_SIZE = 12;
/** Sentinel for an absent register operand. */
export const ABSENT = 0xffff;
/** Sentinel for an absent immediate, disambiguated per opcode by the verifier. */
export const IMM_ABSENT = 0;

/** Flags any instruction may carry, regardless of opcode. */
export const INSTRUCTION_FLAGS_MASK = 0xff;

/**
 * Flags the given canonical opcode accepts, or 0 when it accepts none.
 *
 * ABI v1.0 assigns no meaning to `flags` for any opcode: the byte exists in the
 * 12-byte encoding and must be zero. Per-operation flags are therefore rejected
 * by the verifier (`allowedFlags` returns 0 for every opcode) and would require
 * a documented append-only ABI amendment plus a Technical Change Proposal first.
 */
export function allowedFlags(_canonical: number): number {
  return 0;
}

export interface Instruction {
  readonly opcode: number;
  readonly flags: number;
  readonly dst: number;
  readonly a: number;
  readonly b: number;
  readonly imm32: number;
}

export interface InstructionInput {
  readonly opcode: number;
  readonly flags?: number;
  readonly dst?: number;
  readonly a?: number;
  readonly b?: number;
  readonly imm32?: number;
}

/** Mnemonic shorthand used by tests and hand-authored programs. */
export function ins(
  opcode: number,
  fields: { flags?: number; dst?: number; a?: number; b?: number; imm32?: number } = {},
): Instruction {
  return Object.freeze({
    opcode,
    flags: fields.flags ?? 0,
    dst: fields.dst ?? ABSENT,
    a: fields.a ?? ABSENT,
    b: fields.b ?? ABSENT,
    imm32: fields.imm32 ?? 0,
  });
}

function requireUnsigned(value: number, max: number, what: string, offset: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw errors.internal(`instruction encode: ${what} must be an integer in [0, ${max}], got ${value}`);
  }
  void offset;
}

/** Encodes one instruction into exactly 12 bytes at `offset`. */
export function encodeInstruction(target: Buffer, offset: number, instruction: Instruction): void {
  if (offset < 0 || offset + INSTRUCTION_SIZE > target.length) {
    throw errors.internal(
      `instruction encode: offset ${offset} does not fit ${INSTRUCTION_SIZE} bytes in a ${target.length} byte buffer`,
    );
  }
  requireUnsigned(instruction.opcode, 0xff, 'opcode', offset);
  requireUnsigned(instruction.flags, 0xff, 'flags', offset);
  requireUnsigned(instruction.dst, 0xffff, 'dst', offset);
  requireUnsigned(instruction.a, 0xffff, 'a', offset);
  requireUnsigned(instruction.b, 0xffff, 'b', offset);
  if (!Number.isInteger(instruction.imm32) || instruction.imm32 < -0x80000000 || instruction.imm32 > 0x7fffffff) {
    throw errors.internal(
      `instruction encode: imm32 must fit signed 32-bit, got ${instruction.imm32}`,
    );
  }

  target.writeUInt8(instruction.opcode, offset);
  target.writeUInt8(instruction.flags, offset + 1);
  target.writeUInt16LE(instruction.dst, offset + 2);
  target.writeUInt16LE(instruction.a, offset + 4);
  target.writeUInt16LE(instruction.b, offset + 6);
  target.writeInt32LE(instruction.imm32, offset + 8);
}

/** Decodes one instruction from exactly 12 bytes at `offset`. */
export function decodeInstruction(source: Buffer, offset: number): Instruction {
  if (offset < 0 || offset + INSTRUCTION_SIZE > source.length) {
    throw errors.bytecodeRead(
      `instruction decode: offset ${offset} is outside a ${source.length} byte section`,
    );
  }
  return Object.freeze({
    opcode: source.readUInt8(offset),
    flags: source.readUInt8(offset + 1),
    dst: source.readUInt16LE(offset + 2),
    a: source.readUInt16LE(offset + 4),
    b: source.readUInt16LE(offset + 6),
    imm32: source.readInt32LE(offset + 8),
  });
}

/** Encodes a whole instruction stream. Length is always a multiple of 12. */
export function encodeInstructions(instructions: readonly Instruction[]): Buffer {
  const buffer = Buffer.alloc(instructions.length * INSTRUCTION_SIZE);
  for (let i = 0; i < instructions.length; i++) {
    encodeInstruction(buffer, i * INSTRUCTION_SIZE, instructions[i] as Instruction);
  }
  return buffer;
}

/**
 * Decodes a complete stream. A length that is not a multiple of 12 is a package
 * defect, not something to pad or ignore.
 */
export function decodeInstructions(bytes: Buffer): readonly Instruction[] {
  if (bytes.length % INSTRUCTION_SIZE !== 0) {
    throw errors.bytecodeRead(
      `instruction stream length ${bytes.length} is not a multiple of ${INSTRUCTION_SIZE}`,
    );
  }
  const count = bytes.length / INSTRUCTION_SIZE;
  const out: Instruction[] = [];
  for (let i = 0; i < count; i++) out.push(decodeInstruction(bytes, i * INSTRUCTION_SIZE));
  return Object.freeze(out);
}

/** Re-encodes an instruction with a different stored opcode, preserving operands. */
export function withOpcode(instruction: Instruction, opcode: number): Instruction {
  return Object.freeze({ ...instruction, opcode });
}

/** Human-readable single-line form used by `inspect` and test failure messages. */
export function formatInstruction(instruction: Instruction, mnemonic: string | null): string {
  const reg = (value: number, label: string): string =>
    value === ABSENT ? `${label}=-` : `${label}=r${value}`;
  const parts = [
    mnemonic ?? `opcode#${instruction.opcode}`,
    reg(instruction.dst, 'dst'),
    reg(instruction.a, 'a'),
    reg(instruction.b, 'b'),
    `imm=${instruction.imm32}`,
  ];
  if (instruction.flags !== 0) parts.push(`flags=0x${instruction.flags.toString(16)}`);
  return parts.join(' ');
}
