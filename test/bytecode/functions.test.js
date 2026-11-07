'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeConstantPool,
  decodeConstantPool,
  CONSTANT_TYPE,
  describeConstant,
} = require('../../dist/bytecode/constants.js');

const {
  encodeFunctionTable,
  decodeFunctionTable,
  FUNCTION_FLAGS,
  FUNCTION_RECORD_SIZE,
} = require('../../dist/bytecode/functions.js');

const {
  groupRecordsByFunction,
  encodeExceptionTable,
  decodeExceptionTable,
  EXCEPTION_KIND,
  EXCEPTION_RECORD_SIZE,
} = require('../../dist/bytecode/exceptions.js');

const LIMITS = { maxConstants: 64, maxConstantBytes: 1 << 16 };

test('constant pool round-trips every constant kind', () => {
  const constants = [
    { kind: 'number', value: 3.25 },
    { kind: 'number', value: -0 },
    { kind: 'string', value: 'hello' },
    { kind: 'boolean', value: true },
    { kind: 'regexp', source: '^a+$', flags: 'gi' },
    { kind: 'bigint', value: 12345678901234567890n },
  ];
  const bytes = encodeConstantPool(constants);
  const decoded = decodeConstantPool(bytes, LIMITS);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.consumed, bytes.length);
  assert.equal(decoded.constants.length, 6);
  assert.equal(decoded.constants[0].value, 3.25);
  assert.ok(Object.is(decoded.constants[1].value, -0));
  assert.equal(decoded.constants[2].value, 'hello');
  assert.equal(decoded.constants[3].value, true);
  assert.equal(decoded.constants[4].source, '^a+$');
  assert.equal(decoded.constants[4].flags, 'gi');
  assert.equal(decoded.constants[5].value, 12345678901234567890n);
});

test('constant pool rejects trailing garbage', () => {
  const bytes = encodeConstantPool([{ kind: 'number', value: 1 }]);
  const padded = Buffer.concat([bytes, Buffer.alloc(4)]);
  assert.throws(() => decodeConstantPool(padded, LIMITS), /trailing|past the end/);
});

test('constant pool rejects unknown type', () => {
  const bytes = encodeConstantPool([{ kind: 'number', value: 1 }]);
  bytes.writeUInt8(0x7f, 6); // corrupt the type byte of the first record
  assert.throws(() => decodeConstantPool(bytes, LIMITS), /unknown constant type/);
});

test('constant pool rejects non-zero flags/reserved', () => {
  const bytes = encodeConstantPool([{ kind: 'boolean', value: true }]);
  bytes.writeUInt8(0x01, 7); // flags byte of first record
  assert.throws(() => decodeConstantPool(bytes, LIMITS), /flags\/reserved/);
});

test('constant pool enforces limits', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ kind: 'number', value: i }));
  const bytes = encodeConstantPool(many);
  assert.throws(() => decodeConstantPool(bytes, LIMITS), /exceeds limit/);
});

test('describeConstant distinguishes -0 and NaN-like values', () => {
  const constants = [
    { kind: 'number', value: -0 },
    { kind: 'string', value: '' },
    { kind: 'boolean', value: false },
    { kind: 'regexp', source: 'x', flags: '' },
  ];
  const bytes = encodeConstantPool(constants);
  const decoded = decodeConstantPool(bytes, LIMITS);
  assert.equal(describeConstant(decoded.constants[0]), 'number -0');
  assert.equal(describeConstant(decoded.constants[1]), 'string(0)');
  assert.equal(describeConstant(decoded.constants[2]), 'boolean false');
  assert.equal(describeConstant(decoded.constants[3]), 'regexp /x/');
});

test('function table round-trips fixed records', () => {
  const functions = [
    {
      codeOffset: 0,
      codeLength: 24,
      paramCount: 2,
      localCount: 4,
      registerCount: 8,
      maxStackHint: 0,
      flags: FUNCTION_FLAGS.STRICT,
      captureCount: 1,
      nameConstant: 0xffffffff,
    },
    {
      codeOffset: 24,
      codeLength: 12,
      paramCount: 0,
      localCount: 1,
      registerCount: 4,
      maxStackHint: 0,
      flags: 0,
      captureCount: 2,
      nameConstant: 0,
    },
  ];
  const bytes = encodeFunctionTable(functions);
  assert.equal(bytes.length, 6 + 2 * FUNCTION_RECORD_SIZE);
  const decoded = decodeFunctionTable(bytes);
  assert.equal(decoded.functions.length, 2);
  assert.equal(decoded.functions[0].paramCount, 2);
  assert.equal(decoded.functions[0].captureCount, 1);
  assert.equal(decoded.functions[0].nameConstant, 0xffffffff);
  assert.equal(decoded.functions[1].codeOffset, 24);
  assert.equal(decoded.functions[1].codeLength, 12);
});

test('function table rejects length mismatch', () => {
  const functions = [{ codeOffset: 0, codeLength: 12, paramCount: 0, localCount: 0, registerCount: 4, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff }];
  const bytes = encodeFunctionTable(functions);
  assert.throws(() => decodeFunctionTable(bytes.subarray(0, bytes.length - 4)), /does not match|too short/);
});

test('function table rejects unsupported generation flags', () => {
  const functions = [{ codeOffset: 0, codeLength: 12, paramCount: 0, localCount: 0, registerCount: 4, maxStackHint: 0, flags: FUNCTION_FLAGS.GENERATOR, captureCount: 0, nameConstant: 0xffffffff }];
  const bytes = encodeFunctionTable(functions);
  assert.throws(() => decodeFunctionTable(bytes), /unsupported flag/);
});

test('exception table round-trips and rejects bad kind', () => {
  const records = [
    { fnIndex: 0, startPc: 0, endPc: 4, handlerPc: 7, kind: EXCEPTION_KIND.CATCH, slot: 3 },
    { fnIndex: 1, startPc: 8, endPc: 12, handlerPc: 0xffffffff, kind: EXCEPTION_KIND.FINALLY, slot: 0 },
  ];
  const bytes = encodeExceptionTable(records);
  // 6-byte header + one fixed record and one u32 function index per record.
  assert.equal(bytes.length, 6 + 2 * (EXCEPTION_RECORD_SIZE + 4));
  const decoded = decodeExceptionTable(bytes);
  assert.equal(decoded.records.length, 2);
  assert.equal(decoded.records[0].kind, EXCEPTION_KIND.CATCH);
  assert.equal(decoded.records[0].slot, 3);
  assert.equal(decoded.records[0].fnIndex, 0);
  assert.equal(decoded.records[1].fnIndex, 1);
  assert.equal(decoded.records[1].handlerPc, 0xffffffff);

  const bad = Buffer.from(bytes);
  bad.writeUInt8(0x05, 6 + 12); // corrupt kind of first record
  assert.throws(() => decodeExceptionTable(bad), /unknown kind/);
});

test('exception table v1 (section-absolute pcs) is rejected with a recompile hint', () => {
  const bytes = Buffer.alloc(6);
  bytes.writeUInt16LE(1, 0);
  bytes.writeUInt32LE(0, 2);
  assert.throws(() => decodeExceptionTable(bytes), /version 1 .* not supported/);
});

test('per-function records are grouped per function and stay in function-local coordinates', () => {
  // Both records use the same function-relative pcs. Grouping must keep them in
  // separate tables: the interpreter indexes the table by frame.functionId and
  // compares against pc already relative to that function's body, so two
  // identical spans in different functions never collide.
  const records = [
    { fnIndex: 0, startPc: 0, endPc: 2, handlerPc: 3, kind: EXCEPTION_KIND.CATCH, slot: 1 },
    { fnIndex: 1, startPc: 0, endPc: 2, handlerPc: 4, kind: EXCEPTION_KIND.CATCH, slot: 2 },
  ];
  const groups = groupRecordsByFunction(records, 2);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].records.map((r) => [r.fnIndex, r.startPc, r.endPc, r.handlerPc]), [[0, 0, 2, 3]]);
  assert.deepEqual(groups[1].records.map((r) => [r.fnIndex, r.startPc, r.endPc, r.handlerPc]), [[1, 0, 2, 4]]);
});

test('grouping gives every function a table, including functions without records', () => {
  // A frame whose function has no records must see an empty group rather than
  // `undefined`, so unwinding needs no special case for "nothing to catch here".
  const groups = groupRecordsByFunction(
    [{ fnIndex: 1, startPc: 0, endPc: 1, handlerPc: 1, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
    3,
  );
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.records.length), [0, 1, 0]);
});

test('grouping rejects a record naming a function that does not exist', () => {
  assert.throws(
    () => groupRecordsByFunction(
      [{ fnIndex: 3, startPc: 0, endPc: 1, handlerPc: 1, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
      1,
    ),
    /function #3, which does not exist/,
  );
});
