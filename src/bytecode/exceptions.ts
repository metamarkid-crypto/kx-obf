/**
 * Exception table format (Spec §9.3, §12.4 — section EXCEPTION_TABLE).
 *
 * Layout (little-endian):
 *   u16 version (2)
 *   u32 count
 *   count fixed 16-byte records:
 *     u32 startPc      first protected instruction (inclusive) — relative to the function body
 *     u32 endPc        one past the last protected instruction (exclusive)
 *     u32 handlerPc    catch/finally entry or NO_HANDLER — relative to the function body
 *     u8  kind         0 = catch, 1 = finally
 *     u8  reserved     must be zero
 *     u16 slot         frame slot that receives the caught value (catch only)
 *   count u32 function indexes, aligned with the records above
 *
 * Version 2 makes the table function-local. In version 1 the program counters were
 * absolute indexes into the concatenated VM_CODE section, which meant an exception
 * record accidentally spanned two neighbouring function bodies whenever a protected
 * range was shifted, and the runtime had to search every record of every function on
 * each throw to discover which frame it belonged to. The record now names its function
 * (`fnIndex`) and its program counters are relative to that function's first
 * instruction, so a record is by construction confined to one body and the runtime
 * only ever inspects the records of the frame that is unwinding.
 *
 * Program counters are expressed in instruction units, not bytes, so every handler
 * entry is by construction on an instruction boundary.
 */
import { errors } from '../diagnostics/errors';

export const EXCEPTION_TABLE_VERSION = 2;
export const EXCEPTION_RECORD_SIZE = 16;
export const NO_HANDLER = 0xffffffff;

export const EXCEPTION_KIND = {
  CATCH: 0,
  FINALLY: 1,
} as const;

export type ExceptionKind = (typeof EXCEPTION_KIND)[keyof typeof EXCEPTION_KIND];

export interface ExceptionRecord {
  /** Function whose body this record protects. */
  readonly fnIndex: number;
  /** First protected instruction, relative to the function body. */
  readonly startPc: number;
  /** One past the last protected instruction, relative to the function body. */
  readonly endPc: number;
  /** Handler entry, relative to the function body, or NO_HANDLER. */
  readonly handlerPc: number;
  readonly kind: ExceptionKind;
  /** Frame slot receiving the caught value; 0 for finally records. */
  readonly slot: number;
}

/** A record resolved against one function: program counters as section coordinates. */
export interface AbsoluteExceptionRecord {
  readonly fnIndex: number;
  readonly startPc: number;
  readonly endPc: number;
  readonly handlerPc: number;
  readonly kind: ExceptionKind;
  readonly slot: number;
}

/**
 * The records that belong to one function, already offset into section coordinates.
 *
 * The other functions' records describe frames that are not running here and must
 * never match: a range that merely overlaps this frame's pc span would otherwise let
 * a throw escape into an unrelated handler.
 */
export interface FunctionExceptionTable {
  readonly records: readonly AbsoluteExceptionRecord[];
}

export const EXCEPTION_LIMITS = {
  maxRecords: 65536,
} as const;

export function encodeExceptionTable(records: readonly ExceptionRecord[]): Buffer {
  const out = Buffer.alloc(6 + records.length * EXCEPTION_RECORD_SIZE + records.length * 4);
  out.writeUInt16LE(EXCEPTION_TABLE_VERSION, 0);
  out.writeUInt32LE(records.length, 2);

  let offset = 6;
  for (const record of records) {
    out.writeUInt32LE(record.startPc, offset);
    out.writeUInt32LE(record.endPc, offset + 4);
    out.writeUInt32LE(record.handlerPc >>> 0, offset + 8);
    out.writeUInt8(record.kind, offset + 12);
    out.writeUInt8(0, offset + 13);
    out.writeUInt16LE(record.slot, offset + 14);
    offset += EXCEPTION_RECORD_SIZE;
  }
  // Function indexes live after the fixed records: they are u32 because a program
  // may declare far more functions than a u16 can name (FUNCTION_LIMITS.maxFunctions).
  for (const record of records) {
    out.writeUInt32LE(record.fnIndex, offset);
    offset += 4;
  }
  return out;
}

export interface DecodedExceptionTable {
  readonly version: number;
  readonly records: readonly ExceptionRecord[];
  readonly consumed: number;
}

export function decodeExceptionTable(bytes: Buffer): DecodedExceptionTable {
  if (bytes.length < 6) {
    throw errors.bytecodeRead(`exception table is ${bytes.length} bytes, minimum is 6`);
  }
  const version = bytes.readUInt16LE(0);
  if (version === 1) {
    throw errors.abi(
      `exception table version 1 uses section-absolute program counters and is not supported (expected ${EXCEPTION_TABLE_VERSION})`,
      {
        feature: 'exception table v1',
        action: 'recompile the package with this compiler version; function-local records are required',
      },
    );
  }
  if (version !== EXCEPTION_TABLE_VERSION) {
    throw errors.abi(
      `exception table version ${version} is not supported (expected ${EXCEPTION_TABLE_VERSION})`,
    );
  }
  const count = bytes.readUInt32LE(2);
  if (count > EXCEPTION_LIMITS.maxRecords) {
    throw errors.vmLimit(`exception record count ${count} exceeds limit ${EXCEPTION_LIMITS.maxRecords}`);
  }
  const expected = 6 + count * EXCEPTION_RECORD_SIZE + count * 4;
  if (bytes.length !== expected) {
    throw errors.bytecodeRead(
      `exception table length ${bytes.length} does not match count ${count} (expected ${expected})`,
    );
  }

  const records: ExceptionRecord[] = [];
  const fnIndexBase = 6 + count * EXCEPTION_RECORD_SIZE;
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * EXCEPTION_RECORD_SIZE;
    const kind = bytes.readUInt8(offset + 12);
    const reserved = bytes.readUInt8(offset + 13);
    if (reserved !== 0) {
      throw errors.bytecodeRead(`exception #${i}: reserved byte must be zero`);
    }
    if (kind !== EXCEPTION_KIND.CATCH && kind !== EXCEPTION_KIND.FINALLY) {
      throw errors.bytecodeRead(`exception #${i}: unknown kind ${kind}`);
    }
    records.push(
      Object.freeze({
        fnIndex: bytes.readUInt32LE(fnIndexBase + i * 4),
        startPc: bytes.readUInt32LE(offset),
        endPc: bytes.readUInt32LE(offset + 4),
        handlerPc: bytes.readUInt32LE(offset + 8),
        kind: kind as ExceptionKind,
        slot: bytes.readUInt16LE(offset + 14),
      }),
    );
  }

  return Object.freeze({ version, records: Object.freeze(records), consumed: expected });
}

/** Converts a function-relative record to section-absolute program counters. */
export function absolutizeRecord(
  record: ExceptionRecord,
  functionPcBase: number,
): AbsoluteExceptionRecord {
  return Object.freeze({
    fnIndex: record.fnIndex,
    startPc: functionPcBase + record.startPc,
    endPc: functionPcBase + record.endPc,
    handlerPc: record.handlerPc === NO_HANDLER ? NO_HANDLER : functionPcBase + record.handlerPc,
    kind: record.kind,
    slot: record.slot,
  });
}

/**
 * Groups the table per function, keeping each record's program counters in that
 * function's own coordinate space (relative to the function body).
 *
 * `absolutizeRecord` is NOT applied here: v2 records are
 * already function-local and the interpreter compares them against a frame-relative
 * pc (`frame.enteredAt`). Adding a section base here would make every frame except
 * the first miss its own handlers, and would let ranges from different functions
 * collide.
 *
 * Records are kept in table order inside each group: a program with two records of
 * equal span is resolved deterministically by the interpreter's "first innermost"
 * rule instead of by whichever order the runtime happened to build.
 *
 * Every function gets a group, including the ones with no records, so
 * `groups[frame.functionId]` is total: a frame that must not catch anything gets
 * an empty group rather than `undefined` to special-case.
 */
export function groupRecordsByFunction(
  records: readonly ExceptionRecord[],
  functionCount: number,
): readonly FunctionExceptionTable[] {
  if (!Number.isInteger(functionCount) || functionCount < 0) {
    throw errors.bytecodeVerify(`function count ${functionCount} is not a valid length`);
  }
  const groups: ExceptionRecord[][] = Array.from({ length: functionCount }, () => []);
  for (const record of records) {
    const group = groups[record.fnIndex];
    if (group === undefined) {
      throw errors.bytecodeVerify(
        `exception record names function #${record.fnIndex}, which does not exist`,
      );
    }
    group.push(record);
  }
  return Object.freeze(
    groups.map((list) => Object.freeze({ records: Object.freeze(list.slice()) })),
  );
}
