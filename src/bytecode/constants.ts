/**
 * Constant pool format (Spec §9.1, §12.4 — section CONSTANT_POOL).
 *
 * Layout (little-endian):
 *   u16 version  (must be 1)
 *   u32 count
 *   count records:
 *     u8  type
 *     u8  flags        (must be zero in v1.0)
 *     u16 reserved     (must be zero)
 *     u32 byteLength
 *     byteLength payload
 *
 * The record is length-prefixed rather than fixed-size because string and regex
 * payloads are variable. The decoder proves the section was consumed exactly:
 * trailing bytes are a package defect, not padding.
 */
import { errors } from '../diagnostics/errors';

export const CONSTANT_POOL_VERSION = 1;

export const CONSTANT_TYPE = {
  NUMBER: 0x01,
  STRING: 0x02,
  BOOLEAN: 0x03,
  REGEXP: 0x04,
  BIGINT: 0x05,
} as const;

export type ConstantType = (typeof CONSTANT_TYPE)[keyof typeof CONSTANT_TYPE];

const RECORD_HEADER_SIZE = 8;

/** Discriminated union of every constant the VM can materialize. */
export type Constant =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'regexp'; readonly source: string; readonly flags: string }
  | { readonly kind: 'bigint'; readonly value: bigint };

export interface ConstantLimits {
  readonly maxConstants: number;
  readonly maxConstantBytes: number;
}

function encodePayload(constant: Constant): Buffer {
  switch (constant.kind) {
    case 'number': {
      const buf = Buffer.alloc(8);
      buf.writeDoubleLE(constant.value, 0);
      return buf;
    }
    case 'string':
      return Buffer.from(constant.value, 'utf8');
    case 'boolean':
      return Buffer.from([constant.value ? 1 : 0]);
    case 'regexp': {
      const source = Buffer.from(constant.source, 'utf8');
      const flags = Buffer.from(constant.flags, 'utf8');
      const buf = Buffer.alloc(4 + source.length + 4 + flags.length);
      buf.writeUInt32LE(source.length, 0);
      source.copy(buf, 4);
      buf.writeUInt32LE(flags.length, 4 + source.length);
      flags.copy(buf, 8 + source.length);
      return buf;
    }
    case 'bigint': {
      const text = constant.value.toString(10);
      return Buffer.from(text, 'utf8');
    }
  }
}

function typeOf(constant: Constant): ConstantType {
  switch (constant.kind) {
    case 'number': return CONSTANT_TYPE.NUMBER;
    case 'string': return CONSTANT_TYPE.STRING;
    case 'boolean': return CONSTANT_TYPE.BOOLEAN;
    case 'regexp': return CONSTANT_TYPE.REGEXP;
    case 'bigint': return CONSTANT_TYPE.BIGINT;
  }
}

/** Encodes a constant pool section body. */
export function encodeConstantPool(constants: readonly Constant[]): Buffer {
  const payloads = constants.map(encodePayload);
  let total = 6;
  for (const payload of payloads) total += RECORD_HEADER_SIZE + payload.length;

  const out = Buffer.alloc(total);
  let offset = 0;
  out.writeUInt16LE(CONSTANT_POOL_VERSION, offset);
  offset += 2;
  out.writeUInt32LE(constants.length, offset);
  offset += 4;

  for (let i = 0; i < constants.length; i++) {
    const constant = constants[i] as Constant;
    const payload = payloads[i] as Buffer;
    out.writeUInt8(typeOf(constant), offset);
    out.writeUInt8(0, offset + 1);
    out.writeUInt16LE(0, offset + 2);
    out.writeUInt32LE(payload.length, offset + 4);
    payload.copy(out, offset + RECORD_HEADER_SIZE);
    offset += RECORD_HEADER_SIZE + payload.length;
  }
  return out;
}

function decodePayload(type: number, payload: Buffer, index: number): Constant {
  switch (type) {
    case CONSTANT_TYPE.NUMBER: {
      if (payload.length !== 8) {
        throw errors.bytecodeRead(`constant #${index}: number payload must be 8 bytes, got ${payload.length}`);
      }
      return Object.freeze({ kind: 'number', value: payload.readDoubleLE(0) });
    }
    case CONSTANT_TYPE.STRING:
      return Object.freeze({ kind: 'string', value: payload.toString('utf8') });
    case CONSTANT_TYPE.BOOLEAN: {
      if (payload.length !== 1) {
        throw errors.bytecodeRead(`constant #${index}: boolean payload must be 1 byte, got ${payload.length}`);
      }
      return Object.freeze({ kind: 'boolean', value: payload.readUInt8(0) !== 0 });
    }
    case CONSTANT_TYPE.REGEXP: {
      if (payload.length < 8) {
        throw errors.bytecodeRead(`constant #${index}: regexp payload too short (${payload.length} bytes)`);
      }
      const sourceLength = payload.readUInt32LE(0);
      if (4 + sourceLength + 4 > payload.length) {
        throw errors.bytecodeRead(`constant #${index}: regexp source length ${sourceLength} exceeds payload`);
      }
      const flagLength = payload.readUInt32LE(4 + sourceLength);
      if (8 + sourceLength + flagLength !== payload.length) {
        throw errors.bytecodeRead(`constant #${index}: regexp flags length ${flagLength} does not match payload`);
      }
      return Object.freeze({
        kind: 'regexp',
        source: payload.subarray(4, 4 + sourceLength).toString('utf8'),
        flags: payload.subarray(8 + sourceLength).toString('utf8'),
      });
    }
    case CONSTANT_TYPE.BIGINT:
      // BigInt() on untrusted text throws SyntaxError; convert it to a typed error.
      try {
        return Object.freeze({ kind: 'bigint', value: BigInt(payload.toString('utf8')) });
      } catch {
        throw errors.bytecodeRead(`constant #${index}: bigint payload is not a valid integer literal`);
      }
    default:
      throw errors.bytecodeRead(`constant #${index}: unknown constant type 0x${type.toString(16)}`);
  }
}

export interface DecodedConstantPool {
  readonly version: number;
  readonly constants: readonly Constant[];
  /** Bytes consumed; must equal the section length. */
  readonly consumed: number;
}

/** Decodes a constant pool section body with strict bounds and limit checks. */
export function decodeConstantPool(bytes: Buffer, limits: ConstantLimits): DecodedConstantPool {
  if (bytes.length < 6) {
    throw errors.bytecodeRead(`constant pool section is ${bytes.length} bytes, minimum is 6`);
  }
  const version = bytes.readUInt16LE(0);
  if (version !== CONSTANT_POOL_VERSION) {
    throw errors.abi(`constant pool version ${version} is not supported (expected ${CONSTANT_POOL_VERSION})`);
  }
  const count = bytes.readUInt32LE(2);
  if (count > limits.maxConstants) {
    throw errors.vmLimit(`constant count ${count} exceeds limit ${limits.maxConstants}`);
  }

  const constants: Constant[] = [];
  let offset = 6;
  for (let i = 0; i < count; i++) {
    if (offset + RECORD_HEADER_SIZE > bytes.length) {
      throw errors.bytecodeRead(`constant #${i}: header runs past the end of the section`);
    }
    const type = bytes.readUInt8(offset);
    const flags = bytes.readUInt8(offset + 1);
    const reserved = bytes.readUInt16LE(offset + 2);
    const byteLength = bytes.readUInt32LE(offset + 4);
    if (flags !== 0 || reserved !== 0) {
      throw errors.bytecodeRead(`constant #${i}: flags/reserved must be zero`);
    }
    if (byteLength > limits.maxConstantBytes) {
      throw errors.vmLimit(`constant #${i} byte length ${byteLength} exceeds limit ${limits.maxConstantBytes}`);
    }
    const start = offset + RECORD_HEADER_SIZE;
    const end = start + byteLength;
    if (end > bytes.length) {
      throw errors.bytecodeRead(`constant #${i}: payload ends past the section end`);
    }
    constants.push(decodePayload(type, bytes.subarray(start, end), i));
    offset = end;
  }

  // Trailing bytes are unaccounted data in a section that must be consumed exactly
  // (Spec §12.6: reject trailing bytes not accounted for by the format).
  if (offset !== bytes.length) {
    throw errors.bytecodeRead(
      `constant pool has ${bytes.length - offset} trailing byte(s) after ${count} record(s)`,
    );
  }

  return Object.freeze({
    version,
    constants: Object.freeze(constants),
    consumed: offset,
  });
}

/** Human-readable single-line form for `inspect`. Never prints whole long strings. */
export function describeConstant(constant: Constant): string {
  switch (constant.kind) {
    case 'number': {
      // Object.is distinguishes -0 and NaN, both semantically distinct in JS.
      if (Object.is(constant.value, -0)) return 'number -0';
      return `number ${constant.value}`;
    }
    case 'string':
      return `string(${constant.value.length})`;
    case 'boolean':
      return `boolean ${constant.value}`;
    case 'regexp':
      return `regexp /${constant.source}/${constant.flags}`;
    case 'bigint':
      return `bigint ${constant.value.toString(10)}n`;
  }
}
