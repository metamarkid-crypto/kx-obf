'use strict';
/**
 * Differential test: compiled VM result vs. Node native (Spec §19.1 — Phase 3 gate).
 *
 * Each fixture is real source text. It is (a) compiled to bytecode and run on the
 * VM and (b) evaluated natively by the host engine. The two results must agree
 * structurally — including `-0`, `NaN`, `Infinity` and exact bit patterns, which
 * `assert.deepStrictEqual` compares correctly and `==` would not.
 *
 * Agreement is the *only* thing asserted. A test that computes the expected value
 * from the same expression in JS would prove nothing beyond "JS works"; the value
 * compared here is whatever native evaluation produces, so a VM that disagrees is
 * visibly wrong.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compileSource } = require('../../dist/compiler/index.js');

/** Runs `source` natively and returns what its entry function returns. */
function nativeResult(source, name) {
  // Deliberately the host engine evaluating the same text — not a reimplementation.
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${source}\nreturn ${name};`)();
  return fn();
}

/** Compiles `source` and returns the VM's result, failing loudly on a VM throw. */
function vmLResult(source) {
  const compiled = compileSource({ source, filename: 'diff.js' });
  const completion = compiled.call();
  if (completion.kind === 'throw') {
    assert.fail(`the VM threw where native evaluation did not: ${String(completion.error)}`);
  }
  return completion.value;
}

const CASES = [
  'function f() { return 7; }',
  'function f() { return 0; }',
  'function f() { return 1 - 1; }',
  'function f() { return 2 * 3; }',
  'function f() { return 10 / 4; }',
  'function f() { return 7 % 3; }',
  'function f() { return 2 ** 10; }',
  'function f() { return 2 ** 0.5; }',
  'function f() { return -3 * (4 - 9); }',
  'function f() { return 2 * 3 * 4 * 5; }',
  'function f() { return 1 - 2 - 3; }',
  'function f() { return 100 / 10 / 5; }',
  'function f() { return 1.5 * 2; }',
  'function f() { return -(-(-5)); }',
  'function f() { return 0.1 * 3; }',
  'function f() { return 1e300 * 1e10; }',
  'function f() { return -1e300 * 1e10; }',
  'function f() { return 1 / 0; }',
  'function f() { return -1 / 0; }',
  'function f() { return 0 / 0; }',
  'function f() { return 2147483647; }',
  'function f() { return -2147483648; }',
  'function f() { return 2147483648; }',
  'function f() { return -2147483649; }',
  'function f() { return -0.0; }',
  'function f() { return 1 * -0.0; }',
  'function f() { return (2 - 2) * -1; }',
  'function f() { return 0.1 * 0.2; }',
  'function f() { return 5 - 0.5; }',
  'function f() { return 3 ** -2; }',
  'function f() { return 7 % -3; }',
  'function f() { return -7 % 3; }',
  'function f() { return 5 % 0; }',
  'function f() { return 1 / 3 * 3; }',
  // 9007199254740991 does not fit int32, so this exercises the pool path at the
  // one magnitude where an off-by-one in the double encoding would be visible.
  'function f() { return 9007199254740991; }',
  'function f() { return 4 * 4 * 4 * 4 * 4; }',

  // ---- `+` on operands the compiler proves are Numbers (lowered to ADD) ----
  'function f() { return 1 + 2; }',
  'function f() { return 0.1 + 0.2; }',
  'function f() { return (1 + 2) + 3; }',
  'function f() { return 1 + 2 * 3; }',
  'function f() { return (2 ** 53) + 1; }',
  'function f() { return 2147483647 + 1; }',
  'function f() { return 1 + -0.0; }',
  // `null` proves as a Number (ToNumber(null) is +0) but is not one, so it is the
  // case where a compiler stronger than the spec would print `null1`.
  'function f() { return null + 1; }',
  'function f() { return 1 + null; }',

  // ---- unary - on a proven operand ----
  'function f() { return -7 + 3; }',
  'function f() { return 5 - -3; }',

  // ---- declarations before the return: their initialisers really run ----
  'function f() { const a = 2 * 3; return 4 * 5; }',
  'function f() { let a = 1 + 1; return 7; }',
  'function f() { var a = 3; var b = 4; return 5; }',
  'function f() { const a = 0.1 + 0.2; return 1e300 * 1e10; }',
  'function f() { const a = 1 / 0; return 0 / 0; }',

  // ---- bindings read back out of their slot ----
  'function f() { const a = 2 * 3; return a * 5; }',
  'function f() { let a = 1, b = a + 1; return a + b; }',
  'function f() { let a = 1, b = a + 1, c = a * b; return c - 1; }',
  'function f() { var a = 0.1; return a + 0.2; }',
  'function f() { const big = 1e300; return big * 1e10; }',
  'function f() { const zero = 0; return -zero; }',
  'function f() { var a = 2; var b = a; return b ** 10; }',
  // A `var` without an initialiser is `undefined`, never a stale frame value.
  'function f() { var y; return 1; }',
  // Reading that `undefined` back and doing arithmetic on it: a bound identifier
  // is treated as a Number by the `+` proof, so ADD runs on `undefined` and must
  // produce the same NaN native does — not a type error the compiler invented.
  'function f() { var y; return y + 1; }',
  'function f() { var y; return y * 2; }',

  // ---- assignment, compound assignment and prefix update write the slot ----
  'function f() { let x = 2; x = x * 3; return x + 1; }',
  'function f() { let x = 2; return x = x * 3; }',
  'function f() { var x = 5; x += 2; x *= 3; return x; }',
  'function f() { let x = 10; x -= 4; return x ** 2; }',
  'function f() { let x = 7; x %= 4; return x; }',
  'function f() { let x = 1; x /= 4; x -= 0.25; return x; }',
  'function f() { var x = 1; ++x; ++x; return x; }',
  'function f() { var x = 1; --x; return x; }',
  'function f() { let x = 3; ++x; x *= 2; return x - 1; }',
];

for (const source of CASES) {
  const expression = source.replace(/^function f\(\) \{ return /, '').replace(/; \}$/, '');
  test(`vm matches native: ${expression}`, () => {
    const expected = nativeResult(source, 'f');
    const actual = vmLResult(source);
    assert.deepStrictEqual(actual, expected);
    // `deepStrictEqual` treats NaN as equal to NaN and 0/-0 as distinct, which is
    // exactly the semantics the VM must reproduce; this line makes the intent
    // explicit rather than incidental.
    assert.ok(Object.is(actual, expected) || (Number.isNaN(actual) && Number.isNaN(expected)));
  });
}

test('a compiled program is accepted by the same verifier every package faces', () => {
  const compiled = compileSource({ source: 'function f() { return 1 * 2; }', filename: 'diff.js' });
  // `assembleProgram` verifies before it returns, so reaching this line at all
  // means verification passed; the instruction count confirms the body was
  // actually decoded, not rejected-and-ignored.
  assert.equal(compiled.program.functions.length, 1);
  assert.equal(compiled.program.instructions.length, 4);
});

test('call() forwards the VM completion verbatim', () => {
  // `call()` must surface the VM's return completion, so this fixture pins the
  // shape rather than re-deriving the value: `kind` and `value` both come from
  // the VM, and no host exception may escape in their place.
  const source = 'function f() { return 3 * 4; }';
  const compiled = compileSource({ source, filename: 'diff.js' });
  const completion = compiled.call();
  assert.equal(completion.kind, 'return');
  assert.equal(completion.value, nativeResult(source, 'f'));
});

test('unsupported syntax fails the build with a positioned diagnostic, never a wrong result', () => {
  assert.throws(
    () => compileSource({ source: 'function f() { return 1 + "2"; }', filename: 'diff.js' }),
    (error) =>
      error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' &&
      error.position &&
      error.position.file === 'diff.js' &&
      error.position.line === 1,
  );
});

/**
 * Sources whose `+` must *not* be lowered to ADD.
 *
 * Each one proves the same point from a different angle: the operand is not
 * provably a Number, so AdditiveExpression may concatenate and the compiler has no
 * right to guess. `'1' + 2` is the canonical string case; `a + 2` and `+x` are
 * unproven because a binding could hold a string; `f() + 1` is unproven because a
 * call may return a string.
 */
const UNPROVEN_PLUS = [
  'function f() { return 1 + "2"; }',
  'function f() { return "1" + 2; }',
  'function f() { return true + 1; }',
  'function f() { return g() + 1; }',
  'function f() { return 1n + 1; }',
];

for (const source of UNPROVEN_PLUS) {
  test(`unproven + is rejected instead of mislowered: ${source}`, () => {
    let threw = false;
    try {
      compileSource({ source, filename: 'diff.js' });
    } catch (error) {
      threw = true;
      assert.equal(error.code, 'KXOBH-E-COMPILER-UNSUPPORTED');
      assert.ok(error.position && error.position.file === 'diff.js');
      assert.ok(error.hint && error.hint.action);
    }
    assert.ok(threw, 'compilation must fail: ADD would concatenate here');
  });
}

test('a compiled + uses ADD, not SUB', () => {
  // Guards the opcode mapping itself: `1 + 2` must emit id 24. A `+` that lowered
  // to SUB would still verify and still "run", and only this assertion (or the
  // differential value check above) would notice.
  const compiled = compileSource({ source: 'function f() { return 1 + 2; }', filename: 'diff.js' });
  const opcodes = compiled.program.instructions.map((instruction) => instruction.opcode);
  assert.ok(opcodes.includes(24), `expected ADD (24) in ${opcodes.join(',')}`);
  assert.ok(!opcodes.includes(25), `unexpected SUB (25) in ${opcodes.join(',')}`);
});

test('declarations before the return are emitted, not dropped', () => {
  const compiled = compileSource({ source: 'function f() { const a = 2 * 3; return 4; }', filename: 'diff.js' });
  // LOAD 2, LOAD 3, MUL, STORE_LOCAL, LOAD 4, RETURN: the initialiser is a real
  // expression in the instruction stream and its result lands in the binding's
  // slot, so it runs in source order like it does natively.
  assert.equal(compiled.program.instructions.length, 6);
  assert.equal(compiled.program.functions[0].localCount, 1);
  assert.equal(compiled.call().value, nativeResult('function f() { const a = 2 * 3; return 4; }', 'f'));
});

/**
 * Programs whose *original* source must be rejected instead of lowered.
 *
 * Each one is legal JavaScript that this compiler cannot yet reproduce, so the
 * only honest outcome is a positioned build failure — never bytecode that returns
 * where native throws, or that lets a `const` change value.
 */
const MUST_REJECT = [
  // Writing a const is a TypeError natively; the compiler emits no throw yet.
  'function f() { const c = 1; c = 2; return c; }',
  'function f() { const c = 1; ++c; return c; }',
  // `b` is still in its temporal dead zone when `a`'s initialiser reads it.
  'function f() { let a = b, b = 1; return a; }',
  // A postfix update whose old value is the expression's result.
  'function f() { let x = 1; return x++; }',
];

for (const source of MUST_REJECT) {
  test(`rejected instead of mislowered: ${source}`, () => {
    let threw = false;
    try {
      compileSource({ source, filename: 'diff.js' });
    } catch (error) {
      threw = true;
      assert.equal(error.code, 'KXOBH-E-COMPILER-UNSUPPORTED');
      assert.ok(error.position && error.position.file === 'diff.js' && error.position.line === 1);
      assert.ok(error.hint && error.hint.action);
    }
    assert.ok(threw, 'compilation must fail: the native program throws or reads a dead binding');
  });
}

test('a binding read lowers to LOAD_LOCAL over the slot the declaration wrote', () => {
  // The pair is the contract: STORE_LOCAL writes slot 0 when `a` is declared and
  // LOAD_LOCAL reads slot 0 where `a` is used. A mismatched index would still verify
  // whenever both are in range, so the indices and the count are pinned here.
  const compiled = compileSource({ source: 'function f() { const a = 2 * 3; return a * 5; }', filename: 'diff.js' });
  const opcodes = compiled.program.instructions.map((instruction) => [instruction.opcode, instruction.imm32]);
  assert.deepEqual(
    opcodes,
    [[5, 2], [5, 3], [26, 0], [11, 0], [10, 0], [5, 5], [26, 0], [56, 0]],
  );
  assert.equal(compiled.program.functions[0].localCount, 1);
  assert.equal(compiled.call().value, 30);
});

test('the compiler never emits a function the VM register limit rejects', () => {
  // A budget wider than the VM accepts would be a verifier error dressed as a
  // compiler bug; the budget is clamped to the limit instead and the program runs.
  const compiled = compileSource({
    source: 'function f() { return 1 + 2; }',
    filename: 'diff.js',
    emitLimits: { registerCount: 1024, spillCapacity: 0 },
    vmLimits: { maxRegisters: 8 },
  });
  assert.equal(compiled.program.functions[0].registerCount, 2);
  assert.equal(compiled.call().value, 3);
});

test('an expression wider than the clamped budget fails as a positioned compile error', () => {
  // The budget is clamped to maxRegisters 1, so `1 - 2` (two live temporaries at
  // its widest) cannot be emitted even by spilling: a spilled temporary shares one
  // slot, so a budget of one can never hold an operand *and* the spill target that
  // both alive at once describe. It must be the unsupported diagnostic, not a
  // verifier failure: the source is too big for this frame, the bytecode is fine.
  //
  // Subtraction is used on purpose: `+` here could be rejected by the Number proof
  // first and the test would pass without ever reaching the allocator.
  const source = 'function f() { return 1 - 2; }';
  assert.throws(
    () => compileSource({
      source,
      filename: 'diff.js',
      emitLimits: { registerCount: 16, spillCapacity: 16 },
      vmLimits: { maxRegisters: 1 },
    }),
    (error) =>
      error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' &&
      error.hint.feature === 'register spilling' &&
      error.position &&
      error.position.file === 'diff.js' &&
      error.position.line === 1,
  );
});
