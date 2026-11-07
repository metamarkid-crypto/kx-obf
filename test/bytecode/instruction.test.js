'use strict';
/**
 * 12-byte instruction codec (Spec §9.2).
 *
 * The layout is a durable on-disk contract: a byte laid down today must decode
 * the same way in every later build. These tests pin the byte offsets, the
 * little-endian encoding, the signed immediate, and the two sentinels, then
 * prove that unrepresentable values are refused rather than silently truncated.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  INSTRUCTION_SIZE,
  ABSENT,
  ins,
  encodeInstruction,
  decodeInstruction,
  encodeInstructions,
  decodeInstructions,
  withOpcode,
  formatInstruction,
} = require('../../dist/bytecode/instruction.js');

test('an instruction is exactly 12 bytes', () => {
  assert.equal(INSTRUCTION_SIZE, 12);
  assert.equal(encodeInstructions([ins(1, {})]).length, 12);
  assert.equal(encodeInstructions([ins(1, {}), ins(2, {}), ins(3, {})]).length, 36);
});

test('field offsets and little-endian order are fixed', () => {
  const bytes = encodeInstructions([ins(0x2a, { flags: 0x01, dst: 0x0203, a: 0x0405, b: 0x0607, imm32: 0x08090a0b })]);
  assert.equal(bytes.readUInt8(0), 0x2a, 'opcode at offset 0');
  assert.equal(bytes.readUInt8(1), 0x01, 'flags at offset 1');
  assert.equal(bytes.readUInt16LE(2), 0x0203, 'dst at offset 2');
  assert.equal(bytes.readUInt16LE(4), 0x0405, 'a at offset 4');
  assert.equal(bytes.readUInt16LE(6), 0x0607, 'b at offset 6');
  assert.equal(bytes.readInt32LE(8), 0x08090a0b, 'imm32 at offset 8');
});

test('a negative immediate round-trips as a signed 32-bit value', () => {
  for (const imm32 of [-1, -2, -17, -0x80000000, 0x7fffffff]) {
    const [decoded] = decodeInstructions(encodeInstructions([ins(7, { dst: 3, imm32 })]));
    assert.equal(decoded.imm32, imm32);
  }
});

test('encoding then decoding is the identity for every operand', () => {
  const original = ins(9, { flags: 0xff, dst: 0, a: 1, b: 65534, imm32: -5 });
  const [decoded] = decodeInstructions(encodeInstructions([original]));
  assert.deepEqual({ ...decoded }, { ...original });
});

test('omitted operands default to the ABSENT sentinel and a zero immediate', () => {
  const instruction = ins(4, {});
  assert.equal(instruction.dst, ABSENT);
  assert.equal(instruction.a, ABSENT);
  assert.equal(instruction.b, ABSENT);
  assert.equal(instruction.imm32, 0);
  assert.equal(instruction.flags, 0);
  assert.ok(Object.isFrozen(instruction), 'instructions are immutable once built');
});

test('decoded instructions are frozen so a caller cannot mutate the program', () => {
  const [decoded] = decodeInstructions(encodeInstructions([ins(1, { dst: 2 })]));
  assert.ok(Object.isFrozen(decoded));
});

test('imm32 must fit signed 32-bit and is not silently truncated', () => {
  for (const imm32 of [0x80000000, -0x80000001, 2 ** 40]) {
    assert.throws(
      () => encodeInstructions([ins(1, { imm32 })]),
      (error) => error.code === 'KXOBH-E-INTERNAL',
      `imm32 ${imm32} must be refused`,
    );
  }
});

test('operands that do not fit their field are refused, not wrapped', () => {
  for (const fields of [{ opcode: 0x100 }, { flags: 0x100 }, { dst: 0x10000 }, { a: -1 }, { b: 1.5 }]) {
    const instruction = { ...ins(1, {}), ...fields };
    assert.throws(
      () => encodeInstructions([instruction]),
      (error) => error.code === 'KXOBH-E-INTERNAL',
      `${JSON.stringify(fields)} must be refused`,
    );
  }
});

test('encoding outside the target buffer is refused', () => {
  const tooSmall = Buffer.alloc(INSTRUCTION_SIZE - 1);
  assert.throws(() => encodeInstruction(tooSmall, 0, ins(1, {})), /does not fit/);
  assert.throws(() => encodeInstruction(Buffer.alloc(24), -1, ins(1, {})), /does not fit/);
  assert.throws(() => encodeInstruction(Buffer.alloc(24), 13, ins(1, {})), /does not fit/);
});

test('decoding outside the source buffer is refused', () => {
  const bytes = Buffer.alloc(INSTRUCTION_SIZE);
  assert.throws(
    () => decodeInstruction(bytes, 1),
    (error) => error.code === 'KXOBH-E-BYTECODE',
  );
  assert.throws(() => decodeInstruction(bytes, -1), /is outside/);
});

test('a stream whose length is not a multiple of 12 is rejected', () => {
  for (const length of [1, 11, 13, 23]) {
    assert.throws(
      () => decodeInstructions(Buffer.alloc(length)),
      (error) => error.code === 'KXOBH-E-BYTECODE' && /not a multiple of 12/.test(error.message),
      `length ${length} must be rejected`,
    );
  }
});

test('an empty stream decodes to an empty list', () => {
  assert.deepEqual(decodeInstructions(Buffer.alloc(0)), []);
});

test('withOpcode rewrites only the stored opcode and preserves every operand', () => {
  const original = ins(5, { flags: 2, dst: 7, a: 8, b: 9, imm32: -3 });
  const remapped = withOpcode(original, 200);
  assert.equal(remapped.opcode, 200);
  assert.deepEqual(
    { ...remapped, opcode: 5 },
    { ...original },
    'every field other than the opcode is untouched',
  );
  assert.ok(Object.isFrozen(remapped));
  assert.ok(Object.isFrozen(original), 'the original is not mutated or unfrozen');
});

test('formatInstruction renders absent registers distinctly from register 0', () => {
  assert.equal(formatInstruction(ins(1, {}), 'NOP'), 'NOP dst=- a=- b=- imm=0');
  assert.equal(formatInstruction(ins(1, { dst: 0, a: 0 }), 'LOAD'), 'LOAD dst=r0 a=r0 b=- imm=0');
  assert.equal(
    formatInstruction(ins(1, { dst: 1, imm32: 4, flags: 0x10 }), null),
    'opcode#1 dst=r1 a=- b=- imm=4 flags=0x10',
  );
});
