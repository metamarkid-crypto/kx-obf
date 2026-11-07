/**
 * Function table format (Spec §9.1, §9.5, §12.4 — section FUNCTION_TABLE).
 *
 * Layout (little-endian):
 *   u16 version (2)
 *   u32 count
 *   count fixed 24-byte records:
 *     u32 codeOffset      absolute offset inside the VM_CODE section
 *     u32 codeLength      bytes; multiple of 12, non-zero
 *     u16 paramCount      number of declared parameters (frame slots)
 *     u16 localCount      additional local slots after the parameters
 *     u16 registerCount   registers the compiler may address (<= configured max)
 *     u16 maxStackHint    reserved for diagnostics; validated but not required
 *     u8  flags           bit0 async, bit1 strict, bit2 arrow, bit3 generator(reserved)
 *     u8  captureCount    number of captured environment slots
 *     u16 captureBase     first register holding a parent cell at CREATE_CLOSURE
 *     u32 nameConstant    constant-pool index of the display name, or 0xFFFFFFFF
 *
 * Version 2 replaced version 1's reserved zero field with `captureBase`. A closure
 * is created by the function that owns the captured variables, so those variables
 * are live in that frame as cells: `CREATE_CLOSURE` copies `captureCount` registers
 * starting at `captureBase` into the new closure's environment. Without that window
 * the instruction had nowhere to read a capture from and every closure started
 * with an empty environment.
 *
 * Fixed-size records keep the verifier simple: a malformed table either decodes
 * completely or fails on the exact record that is wrong.
 */
import { errors } from '../diagnostics/errors';

export const FUNCTION_TABLE_VERSION = 2;
export const FUNCTION_RECORD_SIZE = 24;
export const NO_NAME = 0xffffffff;

export const FUNCTION_FLAGS = {
  ASYNC: 0x01,
  STRICT: 0x02,
  ARROW: 0x04,
  /** Reserved for a future generator implementation; rejected in v1.0 (Spec §8.2). */
  GENERATOR: 0x08,
} as const;

/**
 * Flags a v1.0 decoder accepts. GENERATOR is deliberately excluded: generators are
 * unsupported syntax, so a package that sets the bit is malformed for this ABI rather
 * than something to execute on a best-effort basis.
 */
export const SUPPORTED_FUNCTION_FLAGS = 0x07;

export interface FunctionRecord {
  /** Absolute byte offset of the first instruction inside VM_CODE. */
  readonly codeOffset: number;
  /** Byte length of the instruction stream; always a multiple of 12. */
  readonly codeLength: number;
  readonly paramCount: number;
  readonly localCount: number;
  readonly registerCount: number;
  readonly maxStackHint: number;
  readonly flags: number;
  readonly captureCount: number;
  /**
   * First register the frame must place a parent cell in for `CREATE_CLOSURE`.
   * Only meaningful when `captureCount > 0`; ignored (and written as 0) otherwise.
   */
  readonly captureBase?: number;
  /** Constant-pool index for the display name, or NO_NAME. */
  readonly nameConstant: number;
}

export const FUNCTION_LIMITS = {
  maxFunctions: 65536,
  maxParams: 4096,
  maxLocals: 65535,
  maxRegisters: 65535,
  maxCaptures: 4096,
} as const;

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

/** Encodes a complete function table section body. */
export function encodeFunctionTable(functions: readonly FunctionRecord[]): Buffer {
  const out = Buffer.alloc(6 + functions.length * FUNCTION_RECORD_SIZE);
  out.writeUInt16LE(FUNCTION_TABLE_VERSION, 0);
  out.writeUInt32LE(functions.length, 2);

  let offset = 6;
  for (const fn of functions) {
    out.writeUInt32LE(fn.codeOffset, offset);
    out.writeUInt32LE(fn.codeLength, offset + 4);
    out.writeUInt16LE(fn.paramCount, offset + 8);
    out.writeUInt16LE(fn.localCount, offset + 10);
    out.writeUInt16LE(fn.registerCount, offset + 12);
    out.writeUInt16LE(fn.maxStackHint, offset + 14);
    out.writeUInt8(fn.flags, offset + 16);
    out.writeUInt8(fn.captureCount, offset + 17);
    out.writeUInt16LE(fn.captureCount === 0 ? 0 : fn.captureBase ?? 0, offset + 18);
    out.writeUInt32LE(fn.nameConstant >>> 0, offset + 20);
    offset += FUNCTION_RECORD_SIZE;
  }
  return out;
}

export interface DecodedFunctionTable {
  readonly version: number;
  readonly functions: readonly FunctionRecord[];
  readonly consumed: number;
}

/**
 * Decodes the function table. Structural checks only — cross-section checks
 * (code ranges inside VM_CODE, constant indexes valid) belong to the verifier,
 * which runs once with every section available.
 */
export function decodeFunctionTable(bytes: Buffer): DecodedFunctionTable {
  if (bytes.length < 6) {
    throw errors.bytecodeRead(`function table is ${bytes.length} bytes, minimum is 6`);
  }
  const version = bytes.readUInt16LE(0);
  if (version !== FUNCTION_TABLE_VERSION) {
    throw errors.abi(`function table version ${version} is not supported (expected ${FUNCTION_TABLE_VERSION})`);
  }
  const count = bytes.readUInt32LE(2);
  if (count > FUNCTION_LIMITS.maxFunctions) {
    throw errors.vmLimit(`function count ${count} exceeds limit ${FUNCTION_LIMITS.maxFunctions}`);
  }
  const expected = 6 + count * FUNCTION_RECORD_SIZE;
  if (bytes.length !== expected) {
    throw errors.bytecodeRead(
      `function table length ${bytes.length} does not match count ${count} (expected ${expected})`,
    );
  }

  const functions: FunctionRecord[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * FUNCTION_RECORD_SIZE;
    const flags = bytes.readUInt8(offset + 16);
    if ((flags & ~SUPPORTED_FUNCTION_FLAGS) !== 0) {
      throw errors.bytecodeRead(`function #${i}: unsupported flag bits 0x${flags.toString(16)}`);
    }
    const paramCount = bytes.readUInt16LE(offset + 8);
    const captureBase = bytes.readUInt16LE(offset + 18);
    const localCount = bytes.readUInt16LE(offset + 10);
    const captureCount = bytes.readUInt8(offset + 17);
    if (paramCount > FUNCTION_LIMITS.maxParams) {
      throw errors.vmLimit(`function #${i}: paramCount ${paramCount} exceeds limit`);
    }
    if (localCount > FUNCTION_LIMITS.maxLocals) {
      throw errors.vmLimit(`function #${i}: localCount ${localCount} exceeds limit`);
    }
    if (captureCount > FUNCTION_LIMITS.maxCaptures) {
      throw errors.vmLimit(`function #${i}: captureCount ${captureCount} exceeds limit`);
    }
    if (captureCount === 0 && captureBase !== 0) {
      throw errors.bytecodeRead(`function #${i}: captureBase must be zero when the function captures nothing`);
    }
    functions.push(
      Object.freeze({
        codeOffset: bytes.readUInt32LE(offset),
        codeLength: bytes.readUInt32LE(offset + 4),
        paramCount,
        localCount,
        registerCount: bytes.readUInt16LE(offset + 12),
        maxStackHint: bytes.readUInt16LE(offset + 14),
        flags,
        captureCount,
        captureBase,
        nameConstant: bytes.readUInt32LE(offset + 20),
      }),
    );
  }

  return Object.freeze({ version, functions: Object.freeze(functions), consumed: expected });
}

/** Validates index ranges that the verifier will also need. */
export function functionSlotCount(fn: FunctionRecord): number {
  return fn.paramCount + fn.localCount;
}
