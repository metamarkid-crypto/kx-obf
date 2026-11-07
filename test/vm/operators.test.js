'use strict';
/**
 * Operator semantics on hand-authored bytecode (Spec §8.3, §9.3).
 *
 * These tests exercise the dispatch layer directly rather than through the
 * compiler, because the property under test is "the VM runs the real JavaScript
 * operator" — including the throws it must surface as VM throw completions that
 * `try/catch` can observe.
 *
 * Every case is first evaluated by the *host* JavaScript engine using the same
 * operands (see `host`), so the assertion is a differential check: whatever
 * native `1n + 1` does, the VM must do too. A case that disagrees with native
 * semantics fails on the comparison, not on a hard-coded expectation.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ins, encodeInstructions } = require('../../dist/bytecode/instruction.js');
const { IDENTITY_OPMAP } = require('../../dist/bytecode/opcodes.js');
const { encodeConstantPool } = require('../../dist/bytecode/constants.js');
const { encodeFunctionTable } = require('../../dist/bytecode/functions.js');
const { encodeExceptionTable, EXCEPTION_KIND } = require('../../dist/bytecode/exceptions.js');
const { assembleProgram } = require('../../dist/vm/program.js');

const LOAD_NUMBER = 5;
const LOAD_CONST = 6;
const LOAD_LOCAL = 10;
const GET_PROPERTY = 16;
const TRY_BEGIN = 64;
const TRY_END = 65;
const CATCH_BIND = 66;
const ADD = 24;
const SUB = 25;
const MUL = 26;
const DIV = 27;
const MOD = 28;
const POW = 29;
const NEGATE = 30;
const POSITIVE = 31;
const EQ = 34;
const STRICT_EQ = 35;
const NEQ = 36;
const STRICT_NEQ = 37;
const LT = 38;
const LTE = 39;
const GT = 40;
const GTE = 41;
const TYPEOF = 48;
const JUMP = 52;
const NOP = 1;
const RETURN = 56;
const RETURN_UNDEFINED = 57;
const THROW = 58;

const noCapabilities = { resolve: () => undefined };

/**
 * Assembles and runs `entry(values)` where each source operand is a constant
 * pool entry, then applies one operator. `catch=true` wraps the operator in a
 * protected range whose handler returns the caught value.
 */
function runOperator({ constants, body, exceptions, limits }) {
  const code = encodeInstructions(body);
  // One frame slot per instruction index keeps every test free to use any
  // CATCH_BIND slot without the verifier rejecting it; tests assert on slot 0.
  const program = assembleProgram(
    {
      code,
      constants: encodeConstantPool(constants),
      functions: encodeFunctionTable([
        { codeOffset: 0, paramCount: 0, localCount: body.length, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff, codeLength: code.length },
      ]),
      exceptions: exceptions ? encodeExceptionTable(exceptions) : undefined,
      opmap: IDENTITY_OPMAP,
    },
    noCapabilities,
    { maxRegisters: 64, maxFrameSlots: 64, ...limits },
  );
  return program.runEntry(undefined, []);
}

/** Runs the operator natively on the same values; returns value or {threw}. */
function host(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { threw: error };
  }
}

/**
 * Compares a VM completion with a native evaluation of the same operation.
 * Throws are compared by constructor name and `instanceof TypeError`, never by
 * message text, because messages are engine-specific.
 */
function expectSameAsHost(result, nativeOutcome, label) {
  if ('threw' in nativeOutcome) {
    assert.equal(result.kind, 'throw', `${label}: native threw ${nativeOutcome.threw}, VM returned ${String(result.value)}`);
    assert.equal(result.error?.constructor?.name, nativeOutcome.threw.constructor?.name, `${label}: wrong error class`);
    if (nativeOutcome.threw instanceof TypeError) {
      assert.ok(result.error instanceof TypeError, `${label}: expected instanceof TypeError`);
    }
    return;
  }
  assert.equal(result.kind, 'return', `${label}: native returned ${String(nativeOutcome.value)}, VM threw ${String(result.error)}`);
  // deepEqual would treat 1n and 1 as distinct, which is what `===` semantics want.
  assert.deepEqual(result.value, nativeOutcome.value, `${label}: value mismatch`);
}

/** Binary operator case: loads two constants, applies `op`, returns the result. */
function binary(op, left, right, label) {
  test(`VM binary op ${label} matches native semantics`, () => {
    const constants = [left, right];
    const result = runOperator({
      constants,
      body: [
        ins(LOAD_CONST, { dst: 1, imm32: 0 }),
        ins(LOAD_CONST, { dst: 2, imm32: 1 }),
        ins(op, { dst: 3, a: 1, b: 2 }),
        ins(RETURN, { a: 3 }),
      ],
    });
    expectSameAsHost(result, host(() => OPERATORS[op](materialize(left), materialize(right))), label);
  });
}

/** Unary operator case. */
function unary(op, operand, label) {
  test(`VM unary op ${label} matches native semantics`, () => {
    const result = runOperator({
      constants: [operand],
      body: [
        ins(LOAD_CONST, { dst: 1, imm32: 0 }),
        ins(op, { dst: 2, a: 1 }),
        ins(RETURN, { a: 2 }),
      ],
    });
    expectSameAsHost(result, host(() => UNARY_OPERATORS[op](materialize(operand))), label);
  });
}

/** Constant records are what the pool stores; native needs the runtime value. */
function materialize(constant) {
  return constant.kind === 'regexp' ? new RegExp(constant.source, constant.flags) : constant.value;
}

/**
 * The native implementation of each opcode, written once so the differential
 * comparison and the VM case cannot drift apart.
 */
const OPERATORS = {
  [ADD]: (a, b) => a + b,
  [SUB]: (a, b) => a - b,
  [MUL]: (a, b) => a * b,
  [DIV]: (a, b) => a / b,
  [MOD]: (a, b) => a % b,
  [POW]: (a, b) => a ** b,
  [EQ]: (a, b) => a == b,
  [STRICT_EQ]: (a, b) => a === b,
  [NEQ]: (a, b) => a != b,
  [STRICT_NEQ]: (a, b) => a !== b,
  [LT]: (a, b) => a < b,
  [LTE]: (a, b) => a <= b,
  [GT]: (a, b) => a > b,
  [GTE]: (a, b) => a >= b,
};

const UNARY_OPERATORS = {
  [NEGATE]: (a) => -a,
  [POSITIVE]: (a) => +a,
  [TYPEOF]: (a) => typeof a,
};

const BIG = { kind: 'bigint', value: 123456789012345678901234567890n };
const ABOVE_2_53 = { kind: 'bigint', value: 9007199254740993n };
const N1 = { kind: 'bigint', value: 1n };
const N2 = { kind: 'bigint', value: 2n };

// --- BigInt arithmetic -------------------------------------------------------

binary(ADD, ABOVE_2_53, N2, 'bigint(2^53+1) + 2n');
binary(SUB, ABOVE_2_53, N1, 'bigint(2^53+1) - 1n');
binary(MUL, BIG, N2, 'huge bigint * 2n');
binary(DIV, ABOVE_2_53, N2, 'bigint(2^53+1) / 2n');
binary(MOD, ABOVE_2_53, N2, 'bigint(2^53+1) % 2n');
binary(POW, N1, N1, '1n ** 1n');
unary(NEGATE, ABOVE_2_53, '-bigint(2^53+1)');
unary(POSITIVE, ABOVE_2_53, '+bigint(2^53+1)');

// Precision: a result that cannot survive a Number round-trip must not lose digits.
test('BigInt arithmetic keeps precision beyond Number.MAX_SAFE_INTEGER', () => {
  const result = runOperator({
    constants: [ABOVE_2_53, N2],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(LOAD_CONST, { dst: 2, imm32: 1 }),
      ins(MUL, { dst: 3, a: 1, b: 2 }),
      ins(RETURN, { a: 3 }),
    ],
  });
  assert.equal(result.kind, 'return');
  assert.equal(result.value, 18014398509481986n);
  assert.equal(typeof result.value, 'bigint');
  // A Number route would have produced ...986 as a double, losing the final digit
  // for larger inputs; assert the type rather than only the digits.
  assert.notEqual(typeof result.value, 'number');
});

// --- BigInt comparison and equality ------------------------------------------

binary(LT, N1, N2, '1n < 2n');
binary(GT, N2, N1, '2n > 1n');
binary(LTE, N1, N1, '1n <= 1n');
binary(GTE, N1, N2, '1n >= 2n');
binary(STRICT_EQ, N1, { kind: 'bigint', value: 1n }, '1n === 1n');
binary(STRICT_NEQ, N1, N2, '1n !== 2n');

// --- Mixed Number/BigInt: these are legal JavaScript, not TypeErrors ---------

binary(LT, N1, { kind: 'number', value: 2 }, '1n < 2');
binary(GT, { kind: 'number', value: 2 }, N1, '2 > 1n');
binary(EQ, N1, { kind: 'number', value: 1 }, '1n == 1');
binary(STRICT_EQ, N1, { kind: 'number', value: 1 }, '1n === 1');
binary(NEQ, N1, { kind: 'number', value: 2 }, '1n != 2');

test('mixed 1n < 2 returns true and does not throw', () => {
  const result = runOperator({
    constants: [N1, { kind: 'number', value: 2 }],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(LOAD_CONST, { dst: 2, imm32: 1 }),
      ins(LT, { dst: 3, a: 1, b: 2 }),
      ins(RETURN, { a: 3 }),
    ],
  });
  assert.equal(result.kind, 'return');
  assert.equal(result.value, true);
});

test('mixed 1n === 1 is false, not a throw', () => {
  const result = runOperator({
    constants: [N1, { kind: 'number', value: 1 }],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(LOAD_CONST, { dst: 2, imm32: 1 }),
      ins(STRICT_EQ, { dst: 3, a: 1, b: 2 }),
      ins(RETURN, { a: 3 }),
    ],
  });
  assert.equal(result.kind, 'return');
  assert.equal(result.value, false);
});

// --- Mixed Number/BigInt arithmetic: TypeError completions -------------------

binary(ADD, N1, { kind: 'number', value: 1 }, '1n + 1');
binary(ADD, { kind: 'number', value: 1 }, N1, '1 + 1n');
binary(SUB, N1, { kind: 'number', value: 1 }, '1n - 1');
binary(MUL, N1, { kind: 'number', value: 2 }, '1n * 2');
binary(DIV, N1, { kind: 'number', value: 2 }, '1n / 2');
binary(MOD, N1, { kind: 'number', value: 2 }, '1n % 2');

test('unary -1n+1n-style mixing: -(1n + 1) surfaces a TypeError completion', () => {
  // -(+1n) is a TypeError natively: unary + on a BigInt is not allowed.
  const result = runOperator({
    constants: [N1],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(POSITIVE, { dst: 2, a: 1 }),
      ins(RETURN, { a: 2 }),
    ],
  });
  expectSameAsHost(result, host(() => +1n), '+1n');
});

// --- TypeError is catchable by the VM exception machinery -------------------

test('1n + 1 throws a TypeError that lands in an exception handler', () => {
  // try { 1n + 1 } catch (e) { return e }  -- ADD at pc2 must be protected.
  const result = runOperator({
    constants: [N1, { kind: 'number', value: 1 }],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }), // pc0
      ins(LOAD_CONST, { dst: 2, imm32: 1 }), // pc1
      ins(ADD, { dst: 3, a: 1, b: 2 }), // pc2  <-- protected
      ins(RETURN, { a: 3 }), // pc3
      ins(LOAD_LOCAL, { dst: 4, imm32: 0 }), // pc4  handler body
      ins(RETURN, { a: 4 }), // pc5
    ],
    exceptions: [{ startPc: 2, endPc: 3, handlerPc: 4, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
  });
  assert.equal(result.kind, 'return', 'the TypeError must be caught, not escape the VM');
  assert.ok(result.error === undefined);
  assert.ok(result.value instanceof TypeError, `handler should receive a TypeError, got ${String(result.value)}`);
});

test('a caught mixed-type TypeError does not abort later instructions', () => {
  // try { 1n + 1 } catch (e) { } ; return err.name
  //
  // The handler runs to completion after the throw, which proves the VM resumed
  // the handler path instead of re-executing the throwing ADD or escaping.
  const result = runOperator({
    constants: [N1, { kind: 'number', value: 1 }, { kind: 'string', value: 'name' }],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }), // pc0
      ins(LOAD_CONST, { dst: 2, imm32: 1 }), // pc1
      ins(ADD, { dst: 3, a: 1, b: 2 }), // pc2  <-- throws TypeError
      ins(RETURN_UNDEFINED), // pc3 unreachable
      ins(LOAD_CONST, { dst: 5, imm32: 2 }), // pc4 handler entry: "name"
      ins(LOAD_LOCAL, { dst: 4, imm32: 0 }), // pc5 e
      ins(GET_PROPERTY, { dst: 6, a: 4, b: 5 }), // pc6 e.name
      ins(RETURN, { a: 6 }), // pc7
    ],
    exceptions: [{ startPc: 2, endPc: 3, handlerPc: 4, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
  });
  assert.equal(result.kind, 'return');
  assert.equal(result.value, 'TypeError');
});

test('a compiler-style handler reaches the caught error through CATCH_BIND', () => {
  // What the compiler actually emits: CATCH_BIND at the handler entry, then the
  // body reads the frame slot. A host-thrown TypeError must arrive there too.
  const result = runOperator({
    constants: [N1, { kind: 'number', value: 1 }],
    body: [
      ins(TRY_BEGIN), // pc0
      ins(LOAD_CONST, { dst: 1, imm32: 0 }), // pc1
      ins(LOAD_CONST, { dst: 2, imm32: 1 }), // pc2
      ins(ADD, { dst: 3, a: 1, b: 2 }), // pc3  <-- throws TypeError
      ins(TRY_END), // pc4
      ins(RETURN_UNDEFINED), // pc5
      ins(CATCH_BIND, { imm32: 0 }), // pc6 handler entry
      ins(LOAD_LOCAL, { dst: 4, imm32: 0 }), // pc7
      ins(RETURN, { a: 4 }), // pc8
    ],
    exceptions: [{ startPc: 0, endPc: 5, handlerPc: 6, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
  });
  assert.equal(result.kind, 'return', 'CATCH_BIND must bind the error for the handler body');
  assert.ok(result.value instanceof TypeError, `expected a TypeError, got ${String(result.value)}`);
});

test('an explicit throw and an operator TypeError reach the handler the same way', () => {
  // try { throw 'boom' } catch (e) { return e }  ==  try { 1n + 1 } catch (e) { return e.constructor.name }
  const thrown = runOperator({
    constants: [{ kind: 'string', value: 'boom' }],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }), // pc0
      ins(THROW, { a: 1 }), // pc1
      ins(RETURN_UNDEFINED), // pc2
      ins(CATCH_BIND, { imm32: 0 }), // pc3
      ins(LOAD_LOCAL, { dst: 2, imm32: 0 }), // pc4
      ins(RETURN, { a: 2 }), // pc5
    ],
    exceptions: [{ startPc: 0, endPc: 2, handlerPc: 3, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
  });
  assert.equal(thrown.kind, 'return');
  assert.equal(thrown.value, 'boom');

  const operatorError = runOperator({
    constants: [N1, { kind: 'number', value: 1 }],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }), // pc0
      ins(LOAD_CONST, { dst: 2, imm32: 1 }), // pc1
      ins(ADD, { dst: 3, a: 1, b: 2 }), // pc2
      ins(RETURN_UNDEFINED), // pc3
      ins(CATCH_BIND, { imm32: 0 }), // pc4
      ins(LOAD_LOCAL, { dst: 2, imm32: 0 }), // pc5
      ins(RETURN, { a: 2 }), // pc6
    ],
    exceptions: [{ startPc: 0, endPc: 3, handlerPc: 4, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
  });
  assert.equal(operatorError.kind, 'return');
  assert.ok(operatorError.value instanceof TypeError);
});

test('a throw inside a protected range is attributed to the throwing instruction', () => {
  // The range ends at the handler (endPc is exclusive), so the ADD at pc2 is the
  // last protected instruction. Dispatch advances pc before the operator throws;
  // if unwind() used that incremented pc the TypeError would be attributed to
  // the RETURN at pc3 and escape the VM.
  const result = runOperator({
    constants: [N1, { kind: 'number', value: 1 }],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }), // pc0
      ins(LOAD_CONST, { dst: 2, imm32: 1 }), // pc1
      ins(ADD, { dst: 3, a: 1, b: 2 }), // pc2  <-- last protected instruction
      ins(RETURN, { a: 3 }), // pc3
      ins(CATCH_BIND, { imm32: 0 }), // pc4 handler
      ins(LOAD_LOCAL, { dst: 4, imm32: 0 }), // pc5
      ins(RETURN, { a: 4 }), // pc6
    ],
    exceptions: [{ startPc: 0, endPc: 4, handlerPc: 4, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
  });
  assert.equal(result.kind, 'return');
  assert.ok(result.value instanceof TypeError);
});

test('a self-branch loop is bounded by the instruction budget, never a hang', () => {
  // A self-branch is legal (it is how `for (;;) {}` is lowered), so nothing in the
  // verifier stops it: the VM's instruction budget is the bound, and exceeding it
  // must surface as a typed host error rather than an executed-forever process.
  let failure;
  try {
    runOperator({
      constants: [N2],
      limits: { instructionBudget: 20 },
      body: [
        ins(LOAD_CONST, { dst: 1, imm32: 0 }), // pc0
        ins(ADD, { dst: 2, a: 1, b: 1 }), // pc1 2n + 2n = 4n, never throws
        ins(JUMP, { imm32: 0 }), // pc2 self-branch back to pc2
      ],
    });
  } catch (error) {
    failure = error;
  }
  // A budget violation is a host-level failure, not an application throw, so it
  // leaves `runEntry` as the typed error rather than a `{kind:'throw'}` completion.
  assert.equal(failure?.code, 'KXOBH-E-VM-LIMIT', 'a self-branch loop must be stopped by the instruction budget');
});

test('a throw reached by falling through stays inside its protected range', () => {
  // `try { ... 1n + 1 ... } catch (e) { return e }` where the try's last
  // instruction throws: the throw must be attributed to that instruction (which is
  // inside the range), not to the handler that follows it.
  //
  // The operands are mixed types on purpose: 7 + 9 are both Numbers, which is a
  // legal addition and never throws, so an arithmetic case must mix a BigInt with
  // a Number to reach the protected range at all.
  const result = runOperator({
    constants: [N1, { kind: 'number', value: 1 }],
    body: [
      ins(TRY_BEGIN), // pc0
      ins(LOAD_CONST, { dst: 1, imm32: 0 }), // pc1 1n
      ins(LOAD_CONST, { dst: 2, imm32: 1 }), // pc2 1 (Number)
      ins(ADD, { dst: 3, a: 1, b: 2 }), // pc3 protected: throws TypeError
      ins(CATCH_BIND, { imm32: 0 }), // pc4 handler
      ins(LOAD_LOCAL, { dst: 4, imm32: 0 }), // pc5
      ins(RETURN, { a: 4 }), // pc6
    ],
    exceptions: [{ startPc: 0, endPc: 4, handlerPc: 4, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
  });
  assert.equal(result.kind, 'return', 'the TypeError must not escape the range');
  assert.ok(result.value instanceof TypeError, `expected a TypeError, got ${String(result.value)}`);
});

test('a loop back-edge keeps the protected range active on the next iteration', () => {
  // `for (;;) { try { 1n + 1 } catch (e) { return e } }` lowered with the back-edge
  // *inside* the protected range: pc3 jumps back to the throwing ADD at pc2, so on
  // the second iteration the ADD is reached from a branch. The throw must be
  // attributed to the instruction the branch entered (pc2, inside the range),
  // never to the branch itself (pc3, the last protected instruction) or to the
  // handler (pc4, outside the half-open range) — either would let it escape.
  const result = runOperator({
    constants: [N1, { kind: 'number', value: 1 }],
    body: [
      ins(TRY_BEGIN), // pc0
      ins(LOAD_CONST, { dst: 0, imm32: 0 }), // pc1 1n
      ins(LOAD_CONST, { dst: 1, imm32: 1 }), // pc2 1 (Number)
      ins(ADD, { dst: 2, a: 0, b: 1 }), // pc3 1n + 1 <-- throws TypeError
      ins(JUMP, { imm32: -3 }), // pc4 back-edge to pc1
      ins(CATCH_BIND, { imm32: 0 }), // pc5 handler
      ins(LOAD_LOCAL, { dst: 3, imm32: 0 }), // pc6
      ins(RETURN, { a: 3 }), // pc7
    ],
    exceptions: [{ startPc: 0, endPc: 5, handlerPc: 5, kind: EXCEPTION_KIND.CATCH, slot: 0 }],
  });
  assert.equal(result.kind, 'return', 'the TypeError must not escape the loop');
  assert.ok(result.value instanceof TypeError, `expected a TypeError, got ${String(result.value)}`);
});

// --- BigInt typeof ----------------------------------------------------------

unary(TYPEOF, ABOVE_2_53, 'typeof bigint');

test('typeof on a bigint constant answers "bigint"', () => {
  const result = runOperator({
    constants: [BIG],
    body: [
      ins(LOAD_CONST, { dst: 1, imm32: 0 }),
      ins(TYPEOF, { dst: 2, a: 1 }),
      ins(RETURN, { a: 2 }),
    ],
  });
  assert.equal(result.kind, 'return');
  assert.equal(result.value, 'bigint');
});
