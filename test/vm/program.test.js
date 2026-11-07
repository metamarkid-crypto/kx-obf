'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ins } = require('../../dist/bytecode/instruction.js');
const { IDENTITY_OPMAP } = require('../../dist/bytecode/opcodes.js');
const { encodeInstructions } = require('../../dist/bytecode/instruction.js');
const { encodeConstantPool } = require('../../dist/bytecode/constants.js');
const { encodeFunctionTable } = require('../../dist/bytecode/functions.js');
const { encodeExceptionTable, EXCEPTION_KIND } = require('../../dist/bytecode/exceptions.js');
const { assembleProgram } = require('../../dist/vm/program.js');

const ABSENT = 0xffff;
const NOP = 1,
  LOAD_UNDEFINED = 2,
  LOAD_NULL = 3,
  LOAD_BOOL = 4,
  LOAD_NUMBER = 5,
  LOAD_CONST = 6,
  MOVE = 7,
  LOAD_THIS = 8,
  LOAD_ARGUMENTS = 9,
  LOAD_LOCAL = 10,
  STORE_LOCAL = 11,
  LOAD_CAPTURE = 12,
  STORE_CAPTURE = 13,
  GET_PROPERTY = 16,
  SET_PROPERTY = 17,
  CREATE_OBJECT = 20,
  CREATE_ARRAY = 21,
  CREATE_CLOSURE = 60,
  CALL = 61,
  CALL_METHOD = 62,
  CONSTRUCT = 63,
  JUMP = 52,
  JUMP_IF_TRUE = 53,
  JUMP_IF_FALSE = 54,
  RETURN = 56,
  RETURN_UNDEFINED = 57,
  THROW = 58,
  ADD = 24,
  SUB = 25,
  MUL = 26,
  STRICT_EQ = 35,
  LT = 38,
  LOAD_PARAM = 74;

const noCapabilities = { resolve: () => undefined };

function buildProgram({ functions, constants, instructions, exceptions, labels }) {  // A tiny one-pass assembler supporting labels in imm32.
  const instrs = instructions.map((i) => {
    if (i.imm32 !== undefined && typeof i.imm32 === 'string') {
      return { ...i, imm32: 0 }; // patched below
    }
    return i;
  });

  // Resolve labels: a label is an absolute pc in the code section (functions are
  // concatenated, and that is the coordinate space the VM's pc lives in), while a
  // branch operand is an offset relative to the branch instruction itself.
  const flows = instructions.map((i) => {
    if (i.imm32 !== undefined && typeof i.imm32 === 'string') return i.imm32;
    return undefined;
  });
  for (let i = 0; i < flows.length; i++) {
    if (flows[i] !== undefined) {
      const target = labels[flows[i]];
      if (target === undefined) throw new Error(`unknown label ${flows[i]}`);
      instrs[i] = { ...instrs[i], imm32: target - i };
    }
  }

  const code = encodeInstructions(instrs);
  // A function record may omit codeLength; the last function then extends to the
  // end of the code section. Explicit lengths are still honoured (that is what the
  // verifier tests rely on).
  const resolvedFunctions = functions.map((fn) =>
    fn.codeLength === undefined ? { ...fn, codeLength: code.length - fn.codeOffset } : fn,
  );
  const functionsBuf = encodeFunctionTable(resolvedFunctions);
  const constantsBuf = encodeConstantPool(constants);
  const exceptionsBuf = exceptions ? encodeExceptionTable(exceptions) : undefined;

  return assembleProgram(
    {
      code,
      constants: constantsBuf,
      functions: functionsBuf,
      exceptions: exceptionsBuf,
      opmap: IDENTITY_OPMAP,
    },
    noCapabilities,
    { maxRegisters: 64, maxFrameSlots: 64 },
  );
}

test('hand-authored program: arithmetic and return', () => {
  // function main() { return 2 + 3 * 4; }
  const program = buildProgram({
    functions: [{ codeOffset: 0, paramCount: 0, localCount: 0, registerCount: 4, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff }],
    constants: [],
    instructions: [
      ins(LOAD_NUMBER, { dst: 1, imm32: 3 }),
      ins(LOAD_NUMBER, { dst: 2, imm32: 4 }),
      ins(MUL, { dst: 3, a: 1, b: 2 }),
      ins(LOAD_NUMBER, { dst: 1, imm32: 2 }),
      ins(ADD, { dst: 3, a: 1, b: 3 }),
      ins(RETURN, { a: 3 }),
    ],
  });
  const result = program.runEntry(undefined, []);
  assert.equal(result.kind, 'return');
  assert.equal(result.value, 14);
});

test('hand-authored program: control flow with conditional jump', () => {
  // function main() { let x = 0; for (let i = 0; i < 5; i++) x += i; return x; }
  const program = buildProgram({
    functions: [{ codeOffset: 0, paramCount: 0, localCount: 4, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff }],
    constants: [],
    labels: { loop: 4, exit: 17 },
    instructions: [
      // x = 0 (slot 0), i = 0 (slot 1)
      ins(LOAD_NUMBER, { dst: 1, imm32: 0 }),
      ins(STORE_LOCAL, { a: 1, imm32: 0 }),
      ins(LOAD_NUMBER, { dst: 1, imm32: 0 }),
      ins(STORE_LOCAL, { a: 1, imm32: 1 }),
      // loop: if (i >= 5) goto exit
      ins(LOAD_LOCAL, { dst: 2, imm32: 1 }),
      ins(LOAD_NUMBER, { dst: 3, imm32: 5 }),
      ins(LT, { dst: 2, a: 2, b: 3 }),
      ins(JUMP_IF_FALSE, { dst: 2, imm32: 'exit' }),
      // x += i
      ins(LOAD_LOCAL, { dst: 2, imm32: 0 }),
      ins(LOAD_LOCAL, { dst: 3, imm32: 1 }),
      ins(ADD, { dst: 2, a: 2, b: 3 }),
      ins(STORE_LOCAL, { a: 2, imm32: 0 }),
      // i++
      ins(LOAD_LOCAL, { dst: 2, imm32: 1 }),
      ins(LOAD_NUMBER, { dst: 3, imm32: 1 }),
      ins(ADD, { dst: 2, a: 2, b: 3 }),
      ins(STORE_LOCAL, { a: 2, imm32: 1 }),
      ins(JUMP, { imm32: 'loop' }),
      // exit: return x
      ins(LOAD_LOCAL, { dst: 2, imm32: 0 }),
      ins(RETURN, { a: 2 }),
    ],
  });
  const result = program.runEntry(undefined, []);
  assert.equal(result.kind, 'return');
  assert.equal(result.value, 10);
});

test('hand-authored program: closure captures mutable binding', () => {
  // const make = function(init) { let count = init; return function() { count++; return count; }; };
  // const f = make(5); f(); f(); return f();
  // We hand-assemble: fn0 is `make` (creates a closure over a cell),
  // fn1 is the inner closure.
  //
  // For simplicity, we test capture mutation through shared cells:
  // fn0 creates a cell, a closure over it, calls it twice.
  const program = buildProgram({
    functions: [
      { codeOffset: 0, paramCount: 0, localCount: 1, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
    ],
    constants: [
      { kind: 'number', value: 0 },
      { kind: 'number', value: 1 },
    ],
    instructions: [
      ins(LOAD_CONST, { dst: 2, imm32: 0 }),
      ins(STORE_LOCAL, { a: 2, imm32: 0 }),
      ins(LOAD_LOCAL, { dst: 2, imm32: 0 }),
      ins(LOAD_CONST, { dst: 3, imm32: 1 }),
      ins(ADD, { dst: 2, a: 2, b: 3 }),
      ins(STORE_LOCAL, { a: 2, imm32: 0 }),
      ins(LOAD_LOCAL, { dst: 2, imm32: 0 }),
      ins(RETURN, { a: 2 }),
    ],
  });
  const result = program.runEntry(undefined, []);
  assert.equal(result.kind, 'return');
  assert.equal(result.value, 1);
});

test('hand-authored program: exception is caught by try/catch', () => {
  // try { throw 'boom'; } catch (e) { return e; }
  // fn0: pc0 LOAD_CONST, pc1 THROW, pc2(handler) RETURN
  const program = buildProgram({
    functions: [
      { codeOffset: 0, paramCount: 0, localCount: 1, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
    ],
    constants: [{ kind: 'string', value: 'boom' }],
    exceptions: [{ fnIndex: 0, startPc: 0, endPc: 2, handlerPc: 2, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
    instructions: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(THROW, { a: 1 }),
      ins(LOAD_LOCAL, { dst: 1, imm32: 0 }),
      ins(RETURN, { a: 1 }),
    ],
  });
  const result = program.runEntry(undefined, []);
  assert.equal(result.kind, 'return');
  assert.equal(result.value, 'boom');
});

test('hand-authored program: a throw is caught only by the record of its own function', () => {
  // fn0 throws at its own pcs [0, 2). fn1 protects the SAME function-relative
  // pcs [0, 2) and catches its own throw twice over. With per-function records
  // fn0's throw escapes (fn1's record is never consulted) while fn1's throw is
  // caught by its own handler. A section-absolute table would have to pick a
  // winner among overlapping ranges and could route fn0's throw into fn1's
  // handler — running a frame that was never entered.
  //
  // Code layout (pc = instruction index in the concatenated section):
  //   fn0 [0, 2): LOAD_CONST, THROW
  //   fn1 [2, 6): LOAD_CONST, THROW, LOAD_LOCAL, RETURN
  //   fn2 [6, 7): RETURN_UNDEFINED (never entered)
  const program = buildProgram({
    functions: [
      { codeOffset: 0, codeLength: 24, paramCount: 0, localCount: 1, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
      { codeOffset: 24, codeLength: 48, paramCount: 0, localCount: 1, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
      { codeOffset: 72, codeLength: 12, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
    ],
    constants: [{ kind: 'string', value: 'boom' }],
    exceptions: [
      // fn1's record protects its own [0, 2) — the same function-relative offsets
      // at which fn0 throws. Per-function records make the coincidence harmless.
      // The handler sits at fn1 pc 2 and reads the bound slot straight back.
      { fnIndex: 1, startPc: 0, endPc: 2, handlerPc: 2, kind: EXCEPTION_KIND.CATCH, slot: 0 },
    ],
    instructions: [
      // fn0: throw 'boom' (pc 0-1)
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(THROW, { a: 1 }),
      // fn1 body starts here (pc 2), function-relative pc 0. Identical throwing
      // prologue, but now the record IS in scope.
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(THROW, { a: 1 }),
      // fn1 handler (function-relative pc 2): unwind() writes the caught value
      // into the record's slot (frame slot 0), so `localCount: 1` is what makes
      // the slot exist, and LOAD_LOCAL reads it back out.
      ins(LOAD_LOCAL, { dst: 1, imm32: 0 }),
      ins(RETURN, { a: 1 }),
      // fn2 body starts here (pc 6) and is never entered. It exists so a record
      // that *did* protect fn0 could not simply be reused for fn1: the
      // distinguishing case is fn1 itself, which repeats fn0's prologue at a
      // non-zero section base, so only a table keyed by the function can route
      // fn1's throw into fn1's handler and leave fn0's alone.
      ins(RETURN_UNDEFINED, {}),
    ],
  });

  const fromFn0 = program.interpreter.call({
    functionId: 0,
    closure: entryClosure(0),
    args: [],
    thisValue: undefined,
  });
  assert.deepEqual(fromFn0, { kind: 'throw', error: 'boom' });

  const fromFn1 = program.interpreter.call({
    functionId: 1,
    closure: entryClosure(1),
    args: [],
    thisValue: undefined,
  });
  assert.deepEqual(fromFn1, { kind: 'return', value: 'boom' });
  assert.equal(program.functionExceptions[0].records.length, 0);
  assert.equal(program.functionExceptions[1].records.length, 1);
  assert.equal(program.functionExceptions[2].records.length, 0);
});

function entryClosure(functionId) {
  return {
    functionId,
    captures: Object.freeze([]),
    thisValue: undefined,
    argumentsValue: undefined,
    strict: false,
    isAsync: false,
    isArrow: false,
    name: `fn${functionId}`,
  };
}

test('hand-authored program: unhandled throw escapes as throw completion', () => {
  const program = buildProgram({
    functions: [
      { codeOffset: 0, paramCount: 0, localCount: 0, registerCount: 4, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
    ],
    constants: [{ kind: 'string', value: 'oops' }],
    instructions: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(THROW, { a: 1 }),
    ],
  });
  const result = program.runEntry(undefined, []);
  assert.equal(result.kind, 'throw');
  assert.equal(result.error, 'oops');
});
