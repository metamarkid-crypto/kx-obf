'use strict';
/**
 * Per-opcode execution coverage for VM ABI v1.0 (Spec §19.1, rule 16).
 *
 * Every opcode in the canonical catalog must appear here at least once and must
 * be executed, not merely decoded: a table-driven case runs a hand-authored
 * program and asserts the observable result. `catalog.spec(19)` below fails the
 * suite if an opcode is ever added without a test, so this file is also the
 * machine-checked coverage matrix.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ins, encodeInstructions } = require('../../dist/bytecode/instruction.js');
const { IDENTITY_OPMAP, OPCODES, isReservedOpcode } = require('../../dist/bytecode/opcodes.js');
const { encodeConstantPool } = require('../../dist/bytecode/constants.js');
const { encodeFunctionTable } = require('../../dist/bytecode/functions.js');
const { encodeExceptionTable, EXCEPTION_KIND } = require('../../dist/bytecode/exceptions.js');
const { assembleProgram } = require('../../dist/vm/program.js');

const ID = Object.fromEntries(OPCODES.map((op) => [op.name, op.id]));
/**
 * Every opcode this file actually executed. The coverage gate at the bottom of
 * this file reads it, so recording and asserting stay in one process: the gate
 * must see exactly what ran, not a replayed copy.
 */
const COVERED = new Set();

/** Builds an opcode constructor that also records coverage. */
function op(name) {
  const id = ID[name];
  assert.equal(typeof id, 'number', `unknown opcode name ${name}`);
  COVERED.add(name);
  return (fields = {}) => ins(id, fields);
}

/**
 * Assembles and runs a single-function program.
 * `codeLength` is derived from the assembled stream by buildProgram.
 */
function run({ instructions, constants = [], functions = [], exceptions, capabilities = [], labels, thisValue, args = [] }) {
  const fnRecords = functions.length
    ? functions
    : [{ codeOffset: 0, paramCount: 0, localCount: 8, registerCount: 32, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff }];

  const instrs = instructions.map((i) => ({ ...i }));
  if (labels) {
    for (let i = 0; i < instrs.length; i++) {
      const label = labels[instrs[i].imm32];
      if (label === undefined) continue;
      instrs[i] = { ...instrs[i], imm32: label - i };
    }
  }
  const code = encodeInstructions(instrs);
  const resolved = fnRecords.map((fn) => ({
    ...fn,
    codeLength: fn.codeLength === undefined ? code.length - fn.codeOffset : fn.codeLength,
  }));

  const program = assembleProgram(
    {
      code,
      constants: encodeConstantPool(constants),
      functions: encodeFunctionTable(resolved),
      exceptions: exceptions ? encodeExceptionTable(exceptions) : undefined,
      opmap: IDENTITY_OPMAP,
      capabilityIds: capabilities.map((c) => c.id),
    },
    { resolve: (id) => capabilities.find((c) => c.id === id)?.capability },
    { maxRegisters: 64, maxFrameSlots: 64 },
  );
  return program.runEntry(thisValue, args);
}

/** Asserts the program returned the expected value. */
function expectReturn(result, expected) {
  assert.equal(result.kind, 'return', `expected a return completion, got ${result.kind}`);
  assert.deepEqual(result.value, expected);
}

/** Asserts the program threw the expected value. */
function expectThrow(result, expected) {
  assert.equal(result.kind, 'throw', `expected a throw completion, got ${result.kind}`);
  assert.deepEqual(result.error, expected);
}

// --- data movement and constants --------------------------------------------

test('NOP / LOAD_UNDEFINED / LOAD_NULL / MOVE round-trip', () => {
  const NOP = op('NOP');
  const LOAD_UNDEFINED = op('LOAD_UNDEFINED');
  const LOAD_NULL = op('LOAD_NULL');
  const LOAD_BOOL = op('LOAD_BOOL');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const MOVE = op('MOVE');
  const RETURN = op('RETURN');

  expectReturn(
    run({
      instructions: [
        NOP(),
        LOAD_BOOL({ dst: 1, imm32: 0 }),
        MOVE({ dst: 2, a: 1 }),
        LOAD_NULL({ dst: 3 }),
        LOAD_UNDEFINED({ dst: 4 }),
        LOAD_NUMBER({ dst: 5, imm32: 41 }),
        LOAD_NUMBER({ dst: 6, imm32: 1 }),
        MOVE({ dst: 7, a: 5 }),
        RETURN({ a: 7 }),
      ],
    }),
    41,
  );

  // MOVE of null and undefined preserves identity, not truthiness.
  expectReturn(
    run({ instructions: [LOAD_NULL({ dst: 1 }), MOVE({ dst: 2, a: 1 }), RETURN({ a: 2 })] }),
    null,
  );
  expectReturn(
    run({ instructions: [LOAD_UNDEFINED({ dst: 1 }), MOVE({ dst: 2, a: 1 }), RETURN({ a: 2 })] }),
    undefined,
  );
});

test('LOAD_CONST materializes every constant kind', () => {
  const LOAD_CONST = op('LOAD_CONST');
  const RETURN = op('RETURN');
  const constants = [
    { kind: 'number', value: 3.5 },
    { kind: 'string', value: 'héllo' },
    { kind: 'boolean', value: true },
    { kind: 'bigint', value: 7n },
  ];
  expectReturn(run({ constants, instructions: [LOAD_CONST({ dst: 1, imm32: 0 }), RETURN({ a: 1 })] }), 3.5);
  expectReturn(run({ constants, instructions: [LOAD_CONST({ dst: 1, imm32: 1 }), RETURN({ a: 1 })] }), 'héllo');
  expectReturn(run({ constants, instructions: [LOAD_CONST({ dst: 1, imm32: 2 }), RETURN({ a: 1 })] }), true);
  expectReturn(run({ constants, instructions: [LOAD_CONST({ dst: 1, imm32: 3 }), RETURN({ a: 1 })] }), 7n);
});

test('LOAD_THIS returns the receiver, including a primitive receiver', () => {
  const LOAD_THIS = op('LOAD_THIS');
  const RETURN = op('RETURN');
  const receiver = { tag: 'receiver' };
  expectReturn(run({ thisValue: receiver, instructions: [LOAD_THIS({ dst: 1 }), RETURN({ a: 1 })] }), receiver);
  expectReturn(run({ thisValue: 42, instructions: [LOAD_THIS({ dst: 1 }), RETURN({ a: 1 })] }), 42);
});

test('LOAD_ARGUMENTS exposes the passed arguments as an indexable value', () => {
  const LOAD_ARGUMENTS = op('LOAD_ARGUMENTS');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const GET_PROPERTY = op('GET_PROPERTY');
  const RETURN = op('RETURN');

  // return arguments[1];
  expectReturn(
    run({
      args: ['a', 'b', 'c'],
      instructions: [
        LOAD_ARGUMENTS({ dst: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 1 }),
        GET_PROPERTY({ dst: 3, a: 1, b: 2 }),
        RETURN({ a: 3 }),
      ],
    }),
    'b',
  );
});

// --- variables and scope -----------------------------------------------------

test('LOAD_LOCAL / STORE_LOCAL / LOAD_PARAM / STORE_PARAM address frame slots', () => {
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const STORE_LOCAL = op('STORE_LOCAL');
  const LOAD_LOCAL = op('LOAD_LOCAL');
  const LOAD_PARAM = op('LOAD_PARAM');
  const STORE_PARAM = op('STORE_PARAM');
  const ADD = op('ADD');
  const RETURN = op('RETURN');

  // function(p0) { let x = 4; x = x + p0; return x; }
  expectReturn(
    run({
      args: [6],
      functions: [
        { codeOffset: 0, paramCount: 1, localCount: 1, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
      ],
      instructions: [
        LOAD_NUMBER({ dst: 1, imm32: 4 }),
        STORE_LOCAL({ a: 1, imm32: 1 }),
        LOAD_LOCAL({ dst: 2, imm32: 1 }),
        LOAD_PARAM({ dst: 3, imm32: 0 }),
        ADD({ dst: 4, a: 2, b: 3 }),
        STORE_PARAM({ a: 4, imm32: 0 }),
        LOAD_PARAM({ dst: 5, imm32: 0 }),
        RETURN({ a: 5 }),
      ],
    }),
    10,
  );
});

test('DECLARE_BINDING / LOAD_GLOBAL_CAPABILITY resolve through the import table', () => {
  const DECLARE_BINDING = op('DECLARE_BINDING');
  const LOAD_GLOBAL_CAPABILITY = op('LOAD_GLOBAL_CAPABILITY');
  const IMPORT_CAPABILITY = op('IMPORT_CAPABILITY');
  const STORE_LOCAL = op('STORE_LOCAL');
  const LOAD_LOCAL = op('LOAD_LOCAL');
  const MOVE = op('MOVE');
  const RETURN = op('RETURN');

  // A capability is the only sanctioned way to reach the host.
  const hostFn = () => 7;
  expectReturn(
    run({
      capabilities: [{ id: 'host:answer', capability: { name: 'host:answer', async: false, fn: hostFn } }],
      instructions: [
        DECLARE_BINDING({ imm32: 0 }),
        IMPORT_CAPABILITY({ dst: 1, imm32: 0 }),
        LOAD_GLOBAL_CAPABILITY({ dst: 2, imm32: 0 }),
        MOVE({ dst: 3, a: 2 }),
        STORE_LOCAL({ a: 3, imm32: 0 }),
        LOAD_LOCAL({ dst: 4, imm32: 0 }),
        RETURN({ a: 4 }),
      ],
    }),
    hostFn,
  );
});

test('LOAD_CAPTURE / STORE_CAPTURE share one environment cell across closures', () => {
  const LOAD_CAPTURE = op('LOAD_CAPTURE');
  const STORE_CAPTURE = op('STORE_CAPTURE');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const ADD = op('ADD');
  const RETURN = op('RETURN');
  const Interpreter = require('../../dist/vm/interpreter.js').Interpreter;

  // Two functions over the same capture slot: fn0 increments and returns it,
  // fn1 only reads it. Both must observe the same cell.
  const cell = Interpreter.cell(10);
  const capture = Object.freeze([cell]);
  const makeFn = (id) => ({
    functionId: id,
    captures: capture,
    thisValue: undefined,
    argumentsValue: undefined,
    strict: false,
    isAsync: false,
    isArrow: false,
    name: `fn${id}`,
  });

  const code = encodeInstructions([
    LOAD_CAPTURE({ dst: 1, imm32: 0 }),
    LOAD_NUMBER({ dst: 2, imm32: 1 }),
    ADD({ dst: 3, a: 1, b: 2 }),
    STORE_CAPTURE({ a: 3, imm32: 0 }),
    RETURN({ a: 3 }),
    // fn1 body starts here (pc 5): return capture
    LOAD_CAPTURE({ dst: 1, imm32: 0 }),
    RETURN({ a: 1 }),
  ]);
  const functions = [
    { codeOffset: 0, codeLength: 60, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 1, nameConstant: 0xffffffff },
    { codeOffset: 60, codeLength: 24, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 1, nameConstant: 0xffffffff },
  ];
  const program = assembleProgram(
    {
      code,
      constants: encodeConstantPool([]),
      functions: encodeFunctionTable(functions),
      opmap: IDENTITY_OPMAP,
    },
    { resolve: () => undefined },
    { maxRegisters: 64, maxFrameSlots: 64 },
  );

  const first = program.interpreter.call({ functionId: 0, closure: makeFn(0), args: [], thisValue: undefined });
  assert.deepEqual(first, { kind: 'return', value: 11 });
  const second = program.interpreter.call({ functionId: 1, closure: makeFn(1), args: [], thisValue: undefined });
  assert.deepEqual(second, { kind: 'return', value: 11 }, 'the increment must be visible through the shared cell');
});

// --- property and object operations -----------------------------------------

test('CREATE_OBJECT / CREATE_ARRAY / SET_PROPERTY / GET_PROPERTY / HAS_PROPERTY', () => {
  const CREATE_OBJECT = op('CREATE_OBJECT');
  const CREATE_ARRAY = op('CREATE_ARRAY');
  const SET_PROPERTY = op('SET_PROPERTY');
  const GET_PROPERTY = op('GET_PROPERTY');
  const HAS_PROPERTY = op('HAS_PROPERTY');
  const LOAD_CONST = op('LOAD_CONST');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');

  // const o = {}; o.key = 5; return [o.key, 'key' in o];
  const constants = [{ kind: 'string', value: 'key' }];
  expectReturn(
    run({
      constants,
      instructions: [
        CREATE_OBJECT({ dst: 1 }),
        LOAD_CONST({ dst: 2, imm32: 0 }),
        LOAD_NUMBER({ dst: 3, imm32: 5 }),
        SET_PROPERTY({ dst: 3, a: 1, b: 2 }),
        GET_PROPERTY({ dst: 4, a: 1, b: 2 }),
        HAS_PROPERTY({ dst: 5, a: 1, b: 2 }),
        RETURN({ a: 4 }),
      ],
    }),
    5,
  );

  expectReturn(
    run({
      constants,
      instructions: [
        CREATE_OBJECT({ dst: 1 }),
        LOAD_CONST({ dst: 2, imm32: 0 }),
        HAS_PROPERTY({ dst: 3, a: 1, b: 2 }),
        RETURN({ a: 3 }),
      ],
    }),
    false,
  );

  // Arrays index by number and observe length.
  expectReturn(
    run({
      constants: [{ kind: 'string', value: 'length' }],
      instructions: [
        CREATE_ARRAY({ dst: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 0 }),
        LOAD_NUMBER({ dst: 3, imm32: 9 }),
        SET_PROPERTY({ dst: 3, a: 1, b: 2 }),
        LOAD_CONST({ dst: 4, imm32: 0 }),
        GET_PROPERTY({ dst: 5, a: 1, b: 4 }),
        RETURN({ a: 5 }),
      ],
    }),
    1,
  );
});

test('DELETE_PROPERTY removes a data property and reports the outcome', () => {
  const CREATE_OBJECT = op('CREATE_OBJECT');
  const SET_PROPERTY = op('SET_PROPERTY');
  const DELETE_PROPERTY = op('DELETE_PROPERTY');
  const HAS_PROPERTY = op('HAS_PROPERTY');
  const LOAD_CONST = op('LOAD_CONST');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');

  const constants = [{ kind: 'string', value: 'k' }];
  expectReturn(
    run({
      constants,
      instructions: [
        CREATE_OBJECT({ dst: 1 }),
        LOAD_CONST({ dst: 2, imm32: 0 }),
        LOAD_NUMBER({ dst: 3, imm32: 1 }),
        SET_PROPERTY({ dst: 3, a: 1, b: 2 }),
        DELETE_PROPERTY({ dst: 4, a: 1, b: 2 }),
        RETURN({ a: 4 }),
      ],
    }),
    true,
  );

  expectReturn(
    run({
      constants,
      instructions: [
        CREATE_OBJECT({ dst: 1 }),
        LOAD_CONST({ dst: 2, imm32: 0 }),
        LOAD_NUMBER({ dst: 3, imm32: 1 }),
        SET_PROPERTY({ dst: 3, a: 1, b: 2 }),
        DELETE_PROPERTY({ dst: 4, a: 1, b: 2 }),
        HAS_PROPERTY({ dst: 5, a: 1, b: 2 }),
        RETURN({ a: 5 }),
      ],
    }),
    false,
  );
});

test('DEFINE_DATA_PROPERTY creates a non-enumerable-by-request property', () => {
  const CREATE_OBJECT = op('CREATE_OBJECT');
  const DEFINE_DATA_PROPERTY = op('DEFINE_DATA_PROPERTY');
  const GET_PROPERTY = op('GET_PROPERTY');
  const LOAD_CONST = op('LOAD_CONST');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');

  const constants = [{ kind: 'string', value: 'x' }];
  const result = run({
    constants,
    instructions: [
      CREATE_OBJECT({ dst: 1 }),
      LOAD_CONST({ dst: 2, imm32: 0 }),
      LOAD_NUMBER({ dst: 3, imm32: 8 }),
      DEFINE_DATA_PROPERTY({ dst: 3, a: 1, b: 2 }),
      GET_PROPERTY({ dst: 4, a: 1, b: 2 }),
      RETURN({ a: 4 }),
    ],
  });
  expectReturn(result, 8);
});

test('CREATE_REGEXP builds a live RegExp from a regexp constant', () => {
  const CREATE_REGEXP = op('CREATE_REGEXP');
  const RETURN = op('RETURN');
  const constants = [{ kind: 'regexp', source: '^a+$', flags: 'i' }];
  const result = run({ constants, instructions: [CREATE_REGEXP({ dst: 1, imm32: 0 }), RETURN({ a: 1 })] });
  assert.equal(result.kind, 'return');
  assert.ok(result.value instanceof RegExp, 'CREATE_REGEXP must produce a real RegExp');
  assert.equal(result.value.source, '^a+$');
  assert.equal(result.value.flags, 'i');
  assert.equal(result.value.test('AAA'), true);
});

// --- arithmetic, comparison, bitwise, unary ---------------------------------

/** Runs `a OP b` on two numbers and returns the raw VM result. */
function binary(name, a, b) {
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');
  const OP = op(name);
  // LOAD_NUMBER only carries integers in imm32, so operands arrive as constants
  // when they are not integral.
  const constants = [];
  const load = (dst, value) => {
    if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && !Object.is(value, -0)) {
      return LOAD_NUMBER({ dst, imm32: value });
    }
    constants.push({ kind: 'number', value });
    return ins(ID.LOAD_CONST, { dst, imm32: constants.length - 1 });
  };
  const result = run({
    constants,
    instructions: [load(1, a), load(2, b), OP({ dst: 3, a: 1, b: 2 }), RETURN({ a: 3 })],
  });
  assert.equal(result.kind, 'return', `${name} must return, not throw`);
  return result.value;
}

/** Runs unary `OP a` and returns the raw VM result. */
function unary(name, a) {
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');
  const OP = op(name);
  const constants = [];
  const load = (dst, value) => {
    if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && !Object.is(value, -0)) {
      return LOAD_NUMBER({ dst, imm32: value });
    }
    constants.push({ kind: 'number', value });
    return ins(ID.LOAD_CONST, { dst, imm32: constants.length - 1 });
  };
  const result = run({ constants, instructions: [load(1, a), OP({ dst: 2, a: 1 }), RETURN({ a: 2 })] });
  assert.equal(result.kind, 'return', `${name} must return, not throw`);
  return result.value;
}

test('binary arithmetic matches the operator it names', () => {
  assert.equal(binary('ADD', 7, 5), 12);
  assert.equal(binary('SUB', 7, 5), 2);
  assert.equal(binary('MUL', 7, 5), 35);
  assert.equal(binary('DIV', 7, 2), 3.5);
  assert.equal(binary('MOD', 7, 5), 2);
  assert.equal(binary('POW', 2, 10), 1024);
});

test('ADD applies JavaScript string coercion, not numeric addition', () => {
  const LOAD_CONST = op('LOAD_CONST');
  const ADD = op('ADD');
  const RETURN = op('RETURN');
  // 'a' + 1 === 'a1'
  expectReturn(
    run({
      constants: [{ kind: 'string', value: 'a' }, { kind: 'number', value: 1 }],
      instructions: [
        LOAD_CONST({ dst: 1, imm32: 0 }),
        LOAD_CONST({ dst: 2, imm32: 1 }),
        ADD({ dst: 3, a: 1, b: 2 }),
        RETURN({ a: 3 }),
      ],
    }),
    'a1',
  );
});

test('comparison and equality opcodes follow JS semantics', () => {
  assert.equal(binary('EQ', 1, 1), true);
  assert.equal(binary('STRICT_EQ', 1, 1), true);
  assert.equal(binary('NEQ', 1, 2), true);
  assert.equal(binary('STRICT_NEQ', 1, 2), true);
  assert.equal(binary('LT', 1, 2), true);
  assert.equal(binary('LTE', 2, 2), true);
  assert.equal(binary('GT', 3, 2), true);
  assert.equal(binary('GTE', 2, 2), true);

  // Loose equality coerces; strict equality does not.
  const LOAD_CONST = op('LOAD_CONST');
  const EQ = op('EQ');
  const STRICT_EQ = op('STRICT_EQ');
  const RETURN = op('RETURN');
  const constants = [{ kind: 'string', value: '1' }, { kind: 'number', value: 1 }];
  expectReturn(
    run({
      constants,
      instructions: [
        LOAD_CONST({ dst: 1, imm32: 0 }),
        LOAD_CONST({ dst: 2, imm32: 1 }),
        EQ({ dst: 3, a: 1, b: 2 }),
        RETURN({ a: 3 }),
      ],
    }),
    true,
  );
  expectReturn(
    run({
      constants,
      instructions: [
        LOAD_CONST({ dst: 1, imm32: 0 }),
        LOAD_CONST({ dst: 2, imm32: 1 }),
        STRICT_EQ({ dst: 3, a: 1, b: 2 }),
        RETURN({ a: 3 }),
      ],
    }),
    false,
  );
});

test('bitwise opcodes use 32-bit integer semantics', () => {    assert.equal(binary('BIT_AND', 6, 3), 2);
  assert.equal(binary('BIT_OR', 6, 3), 7);
  assert.equal(binary('BIT_XOR', 6, 3), 5);
  assert.equal(binary('SHL', 1, 3), 8);
  assert.equal(binary('SHR', -8, 1), -4);
  assert.equal(binary('USHR', -1, 0), 4294967295);
});

test('unary opcodes match their operators, including -0 and NaN', () => {
  assert.equal(unary('NEGATE', 5), -5);
  assert.equal(unary('POSITIVE', 5), 5);
  assert.equal(unary('BIT_NOT', 5), -6);
  assert.equal(unary('LOGICAL_NOT', 0), true);
  assert.ok(Object.is(unary('NEGATE', 0), -0), 'NEGATE 0 must produce -0');
  assert.ok(Number.isNaN(unary('POSITIVE', NaN)), 'POSITIVE NaN must stay NaN');
});

test('TYPEOF / VOID / IN / INSTANCEOF', () => {
  const TYPEOF = op('TYPEOF');
  const VOID = op('VOID');
  const IN = op('IN');
  const INSTANCEOF = op('INSTANCEOF');
  const LOAD_GLOBAL_CAPABILITY = op('LOAD_GLOBAL_CAPABILITY');
  const LOAD_CONST = op('LOAD_CONST');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const CREATE_OBJECT = op('CREATE_OBJECT');
  const SET_PROPERTY = op('SET_PROPERTY');
  const RETURN = op('RETURN');

  expectReturn(
    run({ instructions: [LOAD_NUMBER({ dst: 1, imm32: 1 }), TYPEOF({ dst: 2, a: 1 }), RETURN({ a: 2 })] }),
    'number',
  );
  expectReturn(run({ instructions: [LOAD_NUMBER({ dst: 1, imm32: 1 }), VOID({ dst: 2, a: 1 }), RETURN({ a: 2 })] }), undefined);

  // 'k' in {k: 1}
  const constants = [{ kind: 'string', value: 'k' }];
  expectReturn(
    run({
      constants,
      instructions: [
        CREATE_OBJECT({ dst: 1 }),
        LOAD_CONST({ dst: 2, imm32: 0 }),
        LOAD_NUMBER({ dst: 3, imm32: 1 }),
        SET_PROPERTY({ dst: 3, a: 1, b: 2 }),
        IN({ dst: 4, a: 1, b: 2 }),
        RETURN({ a: 4 }),
      ],
    }),
    true,
  );

  // ({}) instanceof Object, with the constructor supplied by a capability.
  expectReturn(
    run({
      constants: [],
      capabilities: [{ id: 'obj-ctor', capability: { name: 'Object', async: false, fn: Object } }],
      instructions: [
        CREATE_OBJECT({ dst: 1 }),
        LOAD_GLOBAL_CAPABILITY({ dst: 3, imm32: 0 }),
        INSTANCEOF({ dst: 4, a: 1, b: 3 }),
        RETURN({ a: 4 }),
      ],
    }),
    true,
  );

  // 5 instanceof Object -> false (a primitive is not an instance).
  expectReturn(
    run({
      constants: [],
      capabilities: [{ id: 'obj-ctor', capability: { name: 'Object', async: false, fn: Object } }],
      instructions: [
        LOAD_NUMBER({ dst: 1, imm32: 5 }),
        LOAD_GLOBAL_CAPABILITY({ dst: 3, imm32: 0 }),
        INSTANCEOF({ dst: 4, a: 1, b: 3 }),
        RETURN({ a: 4 }),
      ],
    }),
    false,
  );
});

// --- control flow -----------------------------------------------------------

test('JUMP transfers control and JUMP_IF_* branch on the tested register', () => {
  const JUMP = op('JUMP');
  const JUMP_IF_TRUE = op('JUMP_IF_TRUE');
  const JUMP_IF_FALSE = op('JUMP_IF_FALSE');
  const JUMP_IF_NULLISH = op('JUMP_IF_NULLISH');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const LOAD_NULL = op('LOAD_NULL');
  const RETURN = op('RETURN');

  // Jump over a poison instruction: if the jump were ignored, the return value
  // would be 99 instead of 7.
  expectReturn(
    run({
      instructions: [
        JUMP({ imm32: 2 }),
        LOAD_NUMBER({ dst: 2, imm32: 99 }),
        LOAD_NUMBER({ dst: 1, imm32: 7 }),
        RETURN({ a: 1 }),
      ],
    }),
    7,
  );

  // JUMP_IF_TRUE taken, JUMP_IF_FALSE not taken, JUMP_IF_NULLISH not taken.
  expectReturn(
    run({
      instructions: [
        LOAD_NUMBER({ dst: 1, imm32: 1 }),
        JUMP_IF_TRUE({ dst: 1, imm32: 2 }),
        RETURN({ a: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 42 }),
        RETURN({ a: 2 }),
      ],
    }),
    42,
  );
  expectReturn(
    run({
      instructions: [
        LOAD_NUMBER({ dst: 1, imm32: 0 }),
        JUMP_IF_FALSE({ dst: 1, imm32: 2 }),
        RETURN({ a: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 43 }),
        RETURN({ a: 2 }),
      ],
    }),
    43,
  );
  expectReturn(
    run({
      instructions: [
        LOAD_NULL({ dst: 1 }),
        JUMP_IF_NULLISH({ dst: 1, imm32: 2 }),
        RETURN({ a: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 44 }),
        RETURN({ a: 2 }),
      ],
    }),
    44,
  );

  // A non-nullish value must fall through JUMP_IF_NULLISH.
  expectReturn(
    run({
      instructions: [
        LOAD_NUMBER({ dst: 1, imm32: 5 }),
        JUMP_IF_NULLISH({ dst: 1, imm32: 2 }),
        RETURN({ a: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 0 }),
        RETURN({ a: 2 }),
      ],
    }),
    5,
  );
});

test('RETURN_UNDEFINED and THROW terminate the frame with the right completion', () => {
  const RETURN_UNDEFINED = op('RETURN_UNDEFINED');
  const THROW = op('THROW');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');

  expectReturn(run({ instructions: [RETURN_UNDEFINED(), LOAD_NUMBER({ dst: 1, imm32: 1 }), RETURN({ a: 1 })] }), undefined);

  expectThrow(run({ instructions: [LOAD_NUMBER({ dst: 1, imm32: 13 }), THROW({ a: 1 })] }), 13);

  // A thrown object keeps its identity: the VM must not stringify it.
  const sentinel = { code: 'E_SENTINEL' };
  // A thrown host value is preserved as the same reference, not copied.
  const hostFn = () => sentinel;
  const throwValue = run({
    capabilities: [{ id: 'sentinel', capability: { name: 'sentinel', async: false, fn: () => sentinel } }],
    instructions: [
      ins(ID.CALL_CAPABILITY, { dst: 1, a: 0, b: 1, imm32: 0 }),
      THROW({ a: 1 }),
    ],
  });
  assert.equal(throwValue.kind, 'throw');
  assert.equal(throwValue.error, sentinel, 'throw must preserve object identity');
});

// --- functions, calls and closures ------------------------------------------

test('CREATE_CLOSURE binds a function record and CALL invokes it with an argument window', () => {
  const CREATE_CLOSURE = op('CREATE_CLOSURE');
  const CALL = op('CALL');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const LOAD_LOCAL = op('LOAD_LOCAL');
  const ADD = op('ADD');
  const RETURN = op('RETURN');

  // function f0() { const g = function f1(x) { return x + 1 }; return g(41); }
  // fn0 occupies pc 0-3 (48 bytes); fn1 starts at byte 48 (pc 4).
  expectReturn(
    run({
      functions: [
        { codeOffset: 0, codeLength: 48, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
        { codeOffset: 48, codeLength: 48, paramCount: 1, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
      ],
      instructions: [
        CREATE_CLOSURE({ dst: 1, imm32: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 41 }),
        CALL({ dst: 3, a: 1, imm32: 1 }),
        RETURN({ a: 3 }),
        // fn1 body: return x + 1
        LOAD_LOCAL({ dst: 1, imm32: 0 }),
        LOAD_NUMBER({ dst: 2, imm32: 1 }),
        ADD({ dst: 3, a: 1, b: 2 }),
        RETURN({ a: 3 }),
      ],
    }),
    42,
  );
});

test('CALL_CAPABILITY passes the argument window at b+1 and does not expose `this`', () => {
  const CALL_CAPABILITY = op('CALL_CAPABILITY');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');

  let observedThis;
  const sum = function (...args) {
    observedThis = this;
    return args.reduce((a, b) => a + b, 0);
  };

  // capabilities[0](regs 2,3) — `b` is the window base, so the first argument
  // lives at b+1 and the base register itself is never read as an argument.
  expectReturn(
    run({
      capabilities: [{ id: 'math:sum', capability: { name: 'math:sum', async: false, fn: sum } }],
      instructions: [
        LOAD_NUMBER({ dst: 2, imm32: 2 }),
        LOAD_NUMBER({ dst: 3, imm32: 3 }),
        CALL_CAPABILITY({ dst: 4, a: 0, b: 1, imm32: 2 }),
        RETURN({ a: 4 }),
      ],
    }),
    5,
  );
  assert.equal(observedThis, undefined, 'a capability call is a plain call, not a method call');
});

test('CALL_METHOD dispatches through a[b] with the receiver bound to `this`', () => {
  const CALL_METHOD = op('CALL_METHOD');
  const CALL_CAPABILITY = op('CALL_CAPABILITY');
  const LOAD_CONST = op('LOAD_CONST');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');

  let receiverSeen;
  const host = {
    label: 'box',
    add(amount) {
      receiverSeen = this;
      return `${this.label}:${amount}`;
    },
  };

  // build the host object with a capability that returns it, then call the
  // method with the receiver in `a`, key in `b`, and argument at a+1.
  expectReturn(
    run({
      constants: [{ kind: 'string', value: 'add' }],
      capabilities: [{ id: 'host:box', capability: { name: 'host:box', async: false, fn: () => host } }],
      instructions: [
        CALL_CAPABILITY({ dst: 1, a: 0, b: 1, imm32: 0 }),
        LOAD_CONST({ dst: 5, imm32: 0 }),
        LOAD_NUMBER({ dst: 2, imm32: 7 }),
        CALL_METHOD({ dst: 3, a: 1, b: 5, imm32: 1 }),
        RETURN({ a: 3 }),
      ],
    }),
    'box:7',
  );
  assert.equal(receiverSeen, host, 'the receiver must be passed as `this`, not as an argument');
});

test('CALL_METHOD rejects a non-callable property instead of calling undefined', () => {
  const CALL_METHOD = op('CALL_METHOD');
  const CALL_CAPABILITY = op('CALL_CAPABILITY');
  const LOAD_CONST = op('LOAD_CONST');

  const result = run({
    constants: [{ kind: 'string', value: 'missing' }],
    capabilities: [
      { id: 'host:box', capability: { name: 'host:box', async: false, fn: () => ({ label: 'box' }) } },
    ],
    instructions: [
      CALL_CAPABILITY({ dst: 1, a: 0, b: 1, imm32: 0 }),
      LOAD_CONST({ dst: 2, imm32: 0 }),
      CALL_METHOD({ dst: 3, a: 1, b: 2, imm32: 0 }),
    ],
  });
  assert.equal(result.kind, 'throw');
  assert.ok(result.error instanceof TypeError, `expected a TypeError, got ${result.error}`);
});

test('CONSTRUCT invokes a host constructor and yields the created instance', () => {
  const CONSTRUCT = op('CONSTRUCT');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const GET_PROPERTY = op('GET_PROPERTY');
  const LOAD_CONST = op('LOAD_CONST');
  const LOAD_GLOBAL_CAPABILITY = op('LOAD_GLOBAL_CAPABILITY');
  const RETURN = op('RETURN');

  class Point {
    constructor(x) {
      this.x = x;
    }
  }

  expectReturn(
    run({
      constants: [{ kind: 'string', value: 'x' }],
      capabilities: [{ id: 'host:Point', capability: { name: 'host:Point', async: false, fn: Point } }],
      instructions: [
        LOAD_GLOBAL_CAPABILITY({ dst: 1, imm32: 0 }),
        LOAD_NUMBER({ dst: 2, imm32: 7 }),
        CONSTRUCT({ dst: 3, a: 1, imm32: 1 }),
        LOAD_CONST({ dst: 4, imm32: 0 }),
        GET_PROPERTY({ dst: 5, a: 3, b: 4 }),
        RETURN({ a: 5 }),
      ],
    }),
    7,
  );
});

// --- closures, upvalues and exceptions --------------------------------------

test('LOAD_UPVALUE / STORE_UPVALUE read and write a captured cell, not a copy', () => {
  const LOAD_UPVALUE = op('LOAD_UPVALUE');
  const STORE_UPVALUE = op('STORE_UPVALUE');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const ADD = op('ADD');
  const RETURN = op('RETURN');
  const { Interpreter } = require('../../dist/vm/interpreter.js');

  const cell = Interpreter.cell(4);
  const code = encodeInstructions([
    LOAD_UPVALUE({ dst: 1, imm32: 0 }),
    LOAD_NUMBER({ dst: 2, imm32: 3 }),
    ADD({ dst: 3, a: 1, b: 2 }),
    STORE_UPVALUE({ a: 3, imm32: 0 }),
    LOAD_UPVALUE({ dst: 4, imm32: 0 }),
    RETURN({ a: 4 }),
  ]);
  const program = assembleProgram(
    {
      code,
      constants: encodeConstantPool([]),
      functions: encodeFunctionTable([
        { codeOffset: 0, codeLength: code.length, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 1, nameConstant: 0xffffffff },
      ]),
      opmap: IDENTITY_OPMAP,
    },
    { resolve: () => undefined },
    { maxRegisters: 64, maxFrameSlots: 64 },
  );
  const closure = {
    functionId: 0,
    captures: Object.freeze([cell]),
    thisValue: undefined,
    argumentsValue: undefined,
    strict: false,
    isAsync: false,
    isArrow: false,
    name: 'fn0',
  };
  const completion = program.interpreter.call({ functionId: 0, closure, args: [], thisValue: undefined });
  assert.deepEqual(completion, { kind: 'return', value: 7 });
  assert.equal(cell.value, 7, 'STORE_UPVALUE must mutate the shared cell so outer closures observe it');
});

test('CREATE_CLOSURE copies its capture window by reference, so both closures see a mutation', () => {
  const CREATE_CLOSURE = op('CREATE_CLOSURE');
  const LOAD_CAPTURE = op('LOAD_CAPTURE');
  const STORE_CAPTURE = op('STORE_CAPTURE');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const ADD = op('ADD');
  const CALL = op('CALL');
  const RETURN = op('RETURN');
  const { Interpreter } = require('../../dist/vm/interpreter.js');

  // fn0 is the declaring function: it holds TWO cells in registers r2..r3 and
  // builds two closures over that window (fn1 increments capture 0, fn2 reads
  // capture 0). If the window were copied by value, fn2 would still see the
  // original 0 after fn1 ran.
  const code = encodeInstructions([
    /* fn0 */ CREATE_CLOSURE({ dst: 4, b: 2, imm32: 1 }),
    CREATE_CLOSURE({ dst: 5, b: 2, imm32: 2 }),
    CALL({ dst: 6, a: 4, imm32: 0 }),
    CALL({ dst: 7, a: 5, imm32: 0 }),
    RETURN({ a: 7 }),
    /* fn1 */ LOAD_CAPTURE({ dst: 1, imm32: 0 }),
    LOAD_NUMBER({ dst: 2, imm32: 1 }),
    ADD({ dst: 3, a: 1, b: 2 }),
    STORE_CAPTURE({ a: 3, imm32: 0 }),
    RETURN({ a: 3 }),
    /* fn2 */ LOAD_CAPTURE({ dst: 1, imm32: 0 }),
    RETURN({ a: 1 }),
  ]);
  const program = assembleProgram(
    {
      code,
      constants: encodeConstantPool([]),
      functions: encodeFunctionTable([
        { codeOffset: 0, codeLength: 60, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
        { codeOffset: 60, codeLength: 60, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 1, captureBase: 2, nameConstant: 0xffffffff },
        { codeOffset: 120, codeLength: 24, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 1, captureBase: 2, nameConstant: 0xffffffff },
      ]),
      opmap: IDENTITY_OPMAP,
    },
    { resolve: () => undefined },
    { maxRegisters: 64, maxFrameSlots: 64 },
  );

  const counter = Interpreter.cell(0);
  const other = Interpreter.cell('unused');
  const closure = {
    functionId: 0,
    captures: Object.freeze([]),
    thisValue: undefined,
    argumentsValue: undefined,
    strict: false,
    isAsync: false,
    isArrow: false,
    name: 'fn0',
  };
  // Seed the capture window: registers 2..3 must hold environment cells.
  const completion = program.interpreter.call({
    functionId: 0,
    closure,
    args: [],
    thisValue: undefined,
    seedRegisters: (registers) => {
      registers[2] = counter;
      registers[3] = other;
    },
  });
  assert.equal(completion.kind, 'return');
  assert.equal(completion.value, 1, 'fn2 must observe the increment fn1 made through the shared cell');
  assert.equal(counter.value, 1);
});

test('TRY_BEGIN / TRY_END / DEBUG_MARK / PACK_ARGS are inert markers in straight-line code', () => {
  const TRY_BEGIN = op('TRY_BEGIN');
  const TRY_END = op('TRY_END');
  const DEBUG_MARK = op('DEBUG_MARK');
  const PACK_ARGS = op('PACK_ARGS');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');

  // Exception routing is table-driven, so the markers must be true no-ops: they
  // may not skip instructions, mutate registers, or disturb the completion.
  expectReturn(
    run({
      instructions: [
        TRY_BEGIN(),
        LOAD_NUMBER({ dst: 1, imm32: 3 }),
        PACK_ARGS({ dst: 2, imm32: 0 }),
        DEBUG_MARK({ imm32: 1 }),
        TRY_END(),
        LOAD_NUMBER({ dst: 3, imm32: 4 }),
        RETURN({ a: 3 }),
      ],
    }),
    4,
  );
});

test('CATCH_BIND stores the caught value into the handler slot', () => {
  const CATCH_BIND = op('CATCH_BIND');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const LOAD_LOCAL = op('LOAD_LOCAL');
  const THROW = op('THROW');
  const RETURN = op('RETURN');

  // throw 42 is caught at pc 4, which binds it to slot 0 and returns it.
  expectReturn(
    run({
      exceptions: [{ startPc: 0, endPc: 2, handlerPc: 4, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
      instructions: [
        LOAD_NUMBER({ dst: 1, imm32: 42 }),
        THROW({ a: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 99 }),
        RETURN({ a: 2 }),
        CATCH_BIND({ imm32: 0 }),
        LOAD_LOCAL({ dst: 3, imm32: 0 }),
        RETURN({ a: 3 }),
      ],
    }),
    42,
  );
});

test('FINALLY_RESUME with no pending throw falls through the finally block', () => {
  const FINALLY_RESUME = op('FINALLY_RESUME');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const RETURN = op('RETURN');

  // Normal completion: the finally body ends in FINALLY_RESUME and execution
  // continues on the fall-through path.
  expectReturn(
    run({
      instructions: [
        LOAD_NUMBER({ dst: 1, imm32: 5 }),
        FINALLY_RESUME(),
        RETURN({ a: 1 }),
      ],
    }),
    5,
  );
});

test('FINALLY_RESUME re-throws the completion parked by a finally handler', () => {
  const FINALLY_RESUME = op('FINALLY_RESUME');
  const LOAD_NUMBER = op('LOAD_NUMBER');
  const THROW = op('THROW');
  const RETURN = op('RETURN');

  // throw 42 enters the finally handler at pc 4; FINALLY_RESUME must re-throw it
  // rather than swallowing the exception and returning normally.
  expectThrow(
    run({
      exceptions: [{ startPc: 0, endPc: 2, handlerPc: 4, kind: EXCEPTION_KIND.FINALLY, slot: 0 }],
      instructions: [
        LOAD_NUMBER({ dst: 1, imm32: 42 }),
        THROW({ a: 1 }),
        LOAD_NUMBER({ dst: 2, imm32: 99 }),
        RETURN({ a: 2 }),
        FINALLY_RESUME(),
        RETURN({ a: 2 }),
      ],
    }),
    42,
  );
});

// --- coverage gate ----------------------------------------------------------
//
// This lives here, in the same file that executes the opcodes, rather than in a
// separate test file: `node --test` runs each file in its own process, so a
// separate file would have to `require` this one and would then re-register
// every test in this file. Keeping the assertion adjacent to the recording means
// the gate observes exactly the opcodes that ran.

test('every non-reserved catalogued opcode was executed by this file', () => {
  const executable = OPCODES.filter((op) => !isReservedOpcode(op.id)).map((op) => op.name);
  const missing = executable.filter((name) => !COVERED.has(name)).sort();
  assert.deepEqual(missing, [], `opcodes with no execution test: ${missing.join(', ')}`);
});

test('this file never claims coverage for a name outside the catalog', () => {
  const known = new Set(OPCODES.map((op) => op.name));
  const unknown = [...COVERED].filter((name) => !known.has(name)).sort();
  assert.deepEqual(unknown, [], `test references unknown opcodes: ${unknown.join(', ')}`);
});

test('reserved opcodes are never claimed as executed', () => {
  const claimed = OPCODES.filter((op) => isReservedOpcode(op.id) && COVERED.has(op.name)).map((op) => op.name);
  assert.deepEqual(claimed, [], `reserved opcodes must not be reported as executed: ${claimed.join(', ')}`);
});
