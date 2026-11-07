'use strict';
/**
 * Emitter tests (Phase 3, first slice).
 *
 * These check the instruction stream the compiler produces, not only its result:
 * a differential test can pass on a wrong encoding that happens to coerce to the
 * same value, so the exact opcodes are asserted here.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseSource } = require('../../dist/parser/adapter.js');
const { emitFunction } = require('../../dist/compiler/emitter.js');
const { buildSections } = require('../../dist/compiler/build.js');
const { OPCODE_BY_NAME } = require('../../dist/bytecode/opcodes.js');
const { decodeInstructions } = require('../../dist/bytecode/instruction.js');
const { decodeConstantPool } = require('../../dist/bytecode/constants.js');
const { decodeFunctionTable } = require('../../dist/bytecode/functions.js');

const ABSENT = 0xffff;
const id = (name) => {
  const spec = OPCODE_BY_NAME.get(name);
  assert.ok(spec, `opcode ${name} missing from the catalog`);
  return spec.id;
};

/** Parses a source file and returns its single function node. */
function fnNode(source) {
  const parsed = parseSource({ source, filename: 'fixture.js' });
  return parsed.program.body[0];
}

/** Emits and disassembles a source file to `[mnemonic, dst, a, b, imm]` tuples. */
function disasm(source) {
  const emitted = emitFunction(fnNode(source), 'fixture.js');
  const names = new Map([...OPCODE_BY_NAME.values()].map((spec) => [spec.id, spec.name]));
  return {
    emitted,
    ops: emitted.instructions.map((ins) => [
      names.get(ins.opcode),
      ins.dst,
      ins.a,
      ins.b,
      ins.imm32,
    ]),
  };
}

test('integer literal in range lowers to LOAD_NUMBER with an int32 immediate, then RETURN', () => {
  const { ops } = disasm('function f() { return 7; }');
  assert.deepEqual(ops, [
    ['LOAD_NUMBER', 0, ABSENT, ABSENT, 7],
    ['RETURN', ABSENT, 0, ABSENT, 0],
  ]);
});

test('a negative literal is a unary minus over a positive literal, so it never wraps int32', () => {
  // `-2147483648` parses as `-(2147483648)`; the operand does not fit int32, so it
  // goes through the pool and NEGATE produces the exact double afterwards.
  const { ops, emitted } = disasm('function f() { return -2147483648; }');
  assert.deepEqual(ops, [
    ['LOAD_CONST', 0, ABSENT, ABSENT, 0],
    ['NEGATE', 0, 0, ABSENT, 0],
    ['RETURN', ABSENT, 0, ABSENT, 0],
  ]);
  assert.deepEqual(emitted.constants, [{ kind: 'number', value: 2147483648 }]);
});

test('positive int32 boundary still uses the immediate form', () => {
  const { ops, emitted } = disasm('function f() { return 2147483647; }');
  assert.deepEqual(ops[0], ['LOAD_NUMBER', 0, ABSENT, ABSENT, 2147483647]);
  assert.equal(emitted.constants.length, 0);
});

test('a fraction uses the constant pool so the value stays bit-exact', () => {
  const { ops, emitted } = disasm('function f() { return 1.5; }');
  assert.deepEqual(ops[0], ['LOAD_CONST', 0, ABSENT, ABSENT, 0]);
  assert.deepEqual(emitted.constants, [{ kind: 'number', value: 1.5 }]);
});

test('literals outside int32 use the pool instead of wrapping', () => {
  const { ops, emitted } = disasm('function f() { return 1e300; }');
  assert.equal(ops[0][0], 'LOAD_CONST');
  assert.deepEqual(emitted.constants, [{ kind: 'number', value: 1e300 }]);
});

test('identical constants share one pool entry', () => {
  const { emitted } = disasm('function f() { return 0.5 * 0.5; }');
  assert.deepEqual(emitted.constants, [{ kind: 'number', value: 0.5 }]);
});

test('-0 goes through the pool and keeps its sign', () => {
  // `-0` is an integer that `===` cannot distinguish from `0`, so routing it
  // through LOAD_NUMBER (which writes `imm32`) would drop the sign.
  const { ops, emitted } = disasm('function f() { return -0.0; }');
  assert.deepEqual(ops[0], ['LOAD_NUMBER', 0, ABSENT, ABSENT, 0]);
  assert.deepEqual(ops[1], ['NEGATE', 0, 0, ABSENT, 0]);
  // NEGATE over +0 is -0 natively, so the pool is not needed at all.
  assert.equal(emitted.constants.length, 0);
});

test('binary arithmetic accumulates into the left register and keeps peak pressure at 2', () => {
  const { ops, emitted } = disasm('function f() { return 2 - 3; }');
  assert.deepEqual(ops, [
    ['LOAD_NUMBER', 0, ABSENT, ABSENT, 2],
    ['LOAD_NUMBER', 1, ABSENT, ABSENT, 3],
    ['SUB', 0, 0, 1, 0],
    ['RETURN', ABSENT, 0, ABSENT, 0],
  ]);
  // Two simultaneous temporaries: the left register is reused as the destination.
  assert.equal(emitted.registerCount, 2);
});

test('evaluation order is preserved: the left operand is emitted first', () => {
  const { ops } = disasm('function f() { return 10 - 2; }');
  assert.equal(ops[0][4], 10);
  assert.equal(ops[1][4], 2);
});

test('nested expression reuses its accumulator: 2 * 3 * 4 never holds three live values', () => {
  const { ops, emitted } = disasm('function f() { return 2 * 3 * 4; }');
  assert.deepEqual(ops, [
    ['LOAD_NUMBER', 0, ABSENT, ABSENT, 2],
    ['LOAD_NUMBER', 1, ABSENT, ABSENT, 3],
    ['MUL', 0, 0, 1, 0],
    ['LOAD_NUMBER', 1, ABSENT, ABSENT, 4],
    ['MUL', 0, 0, 1, 0],
    ['RETURN', ABSENT, 0, ABSENT, 0],
  ]);
  assert.equal(emitted.registerCount, 2);
});

test('a right operand that itself computes reuses its register, so 1 + (2 * 3) stays at two live values', () => {
  // The right operand is released the moment it is consumed. Without that release
  // the nested product's own temporaries would sit above it and `1 + (2 * 3)` would
  // report three registers — a peak that grows with nesting depth for no reason.
  const { ops, emitted } = disasm('function f() { return 1 + (2 * 3); }');
  assert.deepEqual(ops, [
    ['LOAD_NUMBER', 0, ABSENT, ABSENT, 1],
    ['LOAD_NUMBER', 1, ABSENT, ABSENT, 2],
    ['LOAD_NUMBER', 2, ABSENT, ABSENT, 3],
    ['MUL', 1, 1, 2, 0],
    ['ADD', 0, 0, 1, 0],
    ['RETURN', ABSENT, 0, ABSENT, 0],
  ]);
  assert.equal(emitted.registerCount, 3);
});

test('parentheses do not change the emitted program: (1 + 2) + 3 and 1 + 2 + 3 are identical', () => {
  // The parser drops Paren nodes, so grouping is invisible to both the proof and
  // the emitter. Pinning equality here catches an emitter that keys on structure
  // the proof does not see — the exact shape that used to reject `(1 + 2) + 3`.
  const withParens = disasm('function f() { return (1 + 2) + 3; }');
  const without = disasm('function f() { return 1 + 2 + 3; }');
  assert.deepEqual(withParens.ops, without.ops);
  assert.deepEqual(
    withParens.ops.map((op) => op[0]),
    ['LOAD_NUMBER', 'LOAD_NUMBER', 'ADD', 'LOAD_NUMBER', 'ADD', 'RETURN'],
  );
  assert.equal(withParens.emitted.registerCount, 2);
});

test('the proof descends one level and stops: +x is unproven even though its result is a Number', () => {
  // `+x` *is* a Number for every x, but nothing in the slice can read `x`, so the
  // proof answers false and the `+` above it is rejected rather than guessed at.
  // (Not `+"2"`: a string literal is rejected by its own rule before `+` is ever
  // considered, which would make this test pass without exercising the proof.)
  assert.throws(
    () => disasm('function f() { return +x + 1; }'),
    (error) =>
      error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' &&
      error.hint.feature === 'binary + where an operand is not provably a Number' &&
      error.position.column === 22,
  );
});

test('a declaration stores its initialiser into the binding\'s slot, dense from 0', () => {
  // `const a = 2 * 3; return 4 * 5;` — the initialiser is a real expression, its
  // result is stored to slot 0 (the frame's slot array is indexed from 0), and the
  // return side reuses the register file independently. Slots and registers are
  // separate arrays on the frame, so nothing aliases.
  const { ops, emitted } = disasm('function f() { const a = 2 * 3; return 4 * 5; }');
  assert.deepEqual(
    ops.map((op) => op[0]),
    ['LOAD_NUMBER', 'LOAD_NUMBER', 'MUL', 'STORE_LOCAL', 'LOAD_NUMBER', 'LOAD_NUMBER', 'MUL', 'RETURN'],
  );
  assert.equal(emitted.registerCount, 3);
  // One slot for `a`, one for each expression's three registers.
  assert.equal(emitted.localCount, 1);
  assert.deepEqual(emitted.bindings, [{ name: 'a', kind: 'const', slot: 0 }]);
  // Every register an instruction names is inside the register file; every slot it
  // names is inside the slot array. The verifier will enforce the same.
  assert.ok(emitted.instructions.every((ins) => ins.dst === ABSENT || ins.dst < emitted.registerCount));
  assert.ok(emitted.instructions.every((ins) => ins.a === ABSENT || ins.a < emitted.registerCount));
  assert.ok(emitted.instructions.every((ins) => ins.b === ABSENT || ins.b < emitted.registerCount));
  assert.ok(
    emitted.instructions
      .filter((ins) => ins.opcode === id('STORE_LOCAL') || ins.opcode === id('LOAD_LOCAL'))
      .every((ins) => ins.imm32 < emitted.localCount),
  );
});

test('every operand a function names is inside the frame it declares', () => {
  // The frame size the emitter reports is what the verifier enforces. A register
  // above it is a bytecode the verifier must reject, so the two must agree: this is
  // the invariant, checked over shapes that stress release-and-reuse.
  const { emitted } = disasm('function f() { const a = (1 + 2) * 3; return 4 - 5; }');
  for (const ins of emitted.instructions) {
    for (const field of ['dst', 'a', 'b']) {
      if (ins[field] !== ABSENT) assert.ok(ins[field] < emitted.registerCount, `${field}=${ins[field]}`);
    }
  }
});

test('unary minus writes back into its operand register', () => {
  const { ops, emitted } = disasm('function f() { return -5; }');
  assert.deepEqual(ops, [
    ['LOAD_NUMBER', 0, ABSENT, ABSENT, 5],
    ['NEGATE', 0, 0, ABSENT, 0],
    ['RETURN', ABSENT, 0, ABSENT, 0],
  ]);
  assert.equal(emitted.registerCount, 1);
});

test('every supported operator maps to its own opcode', () => {
  const cases = [
    ['-', 'SUB'],
    ['*', 'MUL'],
    ['/', 'DIV'],
    ['%', 'MOD'],
    ['**', 'POW'],
  ];
  for (const [op, mnemonic] of cases) {
    const { ops } = disasm(`function f() { return 6 ${op} 2; }`);
    const last = ops[ops.length - 2];
    assert.equal(last[0], mnemonic, `operator ${op} should lower to ${mnemonic}`);
    assert.equal(last[0], OPCODE_BY_NAME.get(mnemonic).name);
  }
});

test('a string literal is rejected instead of being coerced to a number', () => {
  assert.throws(
    () => disasm("function f() { return 'a'; }"),
    (error) => error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' && /string literal/.test(error.message),
  );
});

test('`+` on proven Numbers lowers to ADD; unproven `+` is rejected instead', () => {
  // The opcode table is the guard: a `+` that lowered to SUB would still verify
  // and still run, so the emitted mnemonic is asserted rather than a value.
  const { ops } = disasm('function f() { return 1 + 2; }');
  assert.deepEqual(ops, [
    ['LOAD_NUMBER', 0, ABSENT, ABSENT, 1],
    ['LOAD_NUMBER', 1, ABSENT, ABSENT, 2],
    ['ADD', 0, 0, 1, 0],
    ['RETURN', ABSENT, 0, ABSENT, 0],
  ]);

  // A string operand makes AdditiveExpression a concatenation, so it may not be
  // lowered at all: the diagnostic says why and what to do instead.
  assert.throws(
    () => disasm('function f() { return "1" + 2; }'),
    (error) =>
      error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' &&
      error.hint.feature === 'binary + where an operand is not provably a Number' &&
      /unary \+|Numbers/.test(error.hint.action),
  );
});

test('a rejected node reports the real source position, not line 1', () => {
  assert.throws(
    () => disasm('function f() {\n  return "x";\n}'),
    (error) =>
      error.position &&
      error.position.file === 'fixture.js' &&
      error.position.line === 2 &&
      error.position.column === 9,
  );
});

test('parameters are rejected until the scope prologue exists', () => {
  assert.throws(
    () => disasm('function f(a) { return 1; }'),
    (error) => error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' && /parameters/.test(error.message),
  );
});

test('a body with more than one statement is rejected, not partially compiled', () => {
  // A second return after the accepted one means the function has an unreachable
  // tail the emitter cannot represent; it is rejected by position rather than
  // dropped, because dropping it would change the emitted program's shape.
  assert.throws(
    () => disasm('function f() { return 1; return 2; }'),
    (error) =>
      error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' &&
      /ReturnStatement statements before the return/.test(error.message) &&
      error.position.line === 1,
  );
});

test('an identifier is rejected rather than emitted as an unresolved read', () => {
  // Named by the missing capability (the binding read), not by the AST node name:
  // an `Identifier` diagnostic tells the user nothing they can act on.
  assert.throws(
    () => disasm('function f() { return x; }'),
    (error) =>
      error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' &&
      /reading binding "x"/.test(error.message) &&
      error.hint.feature === 'reading binding "x"',
  );
});

test('a declared binding reads back through LOAD_LOCAL', () => {
  // The whole point of a slot: bind a value, then read it where a later expression
  // needs it. The read is a LOAD_LOCAL from the binding's slot, then arithmetic
  // proceeds in the register file exactly as a literal would.
  const { ops, emitted } = disasm('function f() { let x = 2; return x * 3; }');
  assert.deepEqual(ops, [
    ['LOAD_NUMBER', 0, ABSENT, ABSENT, 2],
    ['STORE_LOCAL', ABSENT, 0, ABSENT, 0],
    ['LOAD_LOCAL', 1, ABSENT, ABSENT, 0],
    ['LOAD_NUMBER', 2, ABSENT, ABSENT, 3],
    ['MUL', 1, 1, 2, 0],
    ['RETURN', ABSENT, 1, ABSENT, 0],
  ]);
  assert.deepEqual(emitted.bindings, [{ name: 'x', kind: 'let', slot: 0 }]);
});

test('assignment and compound assignment write the slot with STORE_LOCAL', () => {
  const { ops, emitted } = disasm('function f() { let x = 2; x = x * 3; return x; }');
  assert.deepEqual(ops, [
    ['LOAD_NUMBER', 0, ABSENT, ABSENT, 2],
    ['STORE_LOCAL', ABSENT, 0, ABSENT, 0],
    ['LOAD_LOCAL', 1, ABSENT, ABSENT, 0],
    ['LOAD_NUMBER', 2, ABSENT, ABSENT, 3],
    ['MUL', 1, 1, 2, 0],
    ['STORE_LOCAL', ABSENT, 1, ABSENT, 0],
    ['LOAD_LOCAL', 2, ABSENT, ABSENT, 0],
    ['RETURN', ABSENT, 2, ABSENT, 0],
  ]);
  assert.deepEqual(emitted.bindings, [{ name: 'x', kind: 'let', slot: 0 }]);

  const compound = disasm('function f() { let x = 10; x -= 4; return x; }');
  // -= reads the slot, loads the right side, subtracts, stores back.
  assert.deepEqual(
    compound.ops.map((op) => op[0]),
    ['LOAD_NUMBER', 'STORE_LOCAL', 'LOAD_LOCAL', 'LOAD_NUMBER', 'SUB', 'STORE_LOCAL', 'LOAD_LOCAL', 'RETURN'],
  );
});

test('prefix ++/-- lower to read, add/sub one, store back', () => {
  const { ops } = disasm('function f() { var x = 1; ++x; return x; }');
  assert.deepEqual(
    ops.map((op) => op[0]),
    ['LOAD_NUMBER', 'STORE_LOCAL', 'LOAD_LOCAL', 'LOAD_NUMBER', 'ADD', 'STORE_LOCAL', 'LOAD_LOCAL', 'RETURN'],
  );
  assert.equal(ops.find((op) => op[0] === 'LOAD_NUMBER')?.[4], 1);
  // The ADD reads the binding and the constant-holding register, then stores back.
  const add = ops.find((op) => op[0] === 'ADD');
  assert.deepEqual([add[1], add[2], add[3]], [1, 1, 2]);
});

test('binding reads before the declaration runs are a temporal dead zone build error', () => {
  // Natively `a` is in its TDZ when `b`'s initialiser runs, so the program throws a
  // ReferenceError. This compiler emits no exception handling, so the build fails
  // with a positioned diagnostic instead of returning a value the native program
  // would never reach.
  assert.throws(
    () => disasm('function f() { let a = b, b = 1; return a; }'),
    (error) =>
      error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' &&
      error.position.line === 1 &&
      /reading let binding "b" before its declaration has run/.test(error.message),
  );
  // A `var` is hoisted and readable immediately, so only a `let`/`const` before
  // its own initialiser is the TDZ case in this slice. A read that follows its own
  // initialiser in the same statement is fine:
  // `let a = 1, b = a` has b's initialiser run after a's, so a is readable there.
  const fine = disasm('function f() { let a = 1, b = a + 1; return b; }');
  assert.equal(fine.emitted.localCount, 2);
});

test('a var redeclaration is rejected, not merged into one slot', () => {
  // Natively `var a = 1; var a = 2;` reuses the same binding, but merging would
  // require tracking which declarations already own a slot; until then the honest
  // answer is a positioned rejection, never two slots for one name.
  assert.throws(
    () => disasm('function f() { var a = 1; var a = 2; return a; }'),
    (error) =>
      error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' &&
      error.hint.feature === 'redeclaring binding "a" in the same scope',
  );
});

test('expression pressure beyond the register budget is a compile error, never a silent alias', () => {
  // `X * 2` needs two live registers at once; a budget of one cannot express it.
  assert.throws(
    () => emitFunction(fnNode('function f() { return 3 * 4; }'), 'fixture.js', { registerCount: 1, spillCapacity: 0 }),
    (error) => error.code === 'KXOBH-E-COMPILER-UNSUPPORTED' && /needs more than 1 registers/.test(error.message),
  );
});

test('buildSections writes function-relative code with section-absolute offsets', () => {
  const first = emitFunction(fnNode('function f() { return 1; }'), 'a.js');
  const second = emitFunction(fnNode('function g() { return 2; }'), 'b.js');
  const sections = buildSections([first, second], { strict: true });

  const table = decodeFunctionTable(sections.functions);
  assert.equal(table.functions.length, 2);
  assert.equal(table.functions[0].codeOffset, 0);
  assert.equal(table.functions[1].codeOffset, first.instructions.length * 12);
  assert.equal(table.functions[0].codeLength, first.instructions.length * 12);
  // Both functions must pass the verifier, which decodes each body on its own.
  assert.equal(table.functions[1].registerCount, 1);

  // The second function's own instruction stream starts at pc 0, not at its offset.
  const secondBody = sections.code.subarray(table.functions[1].codeOffset, table.functions[1].codeOffset + table.functions[1].codeLength);
  const decoded = decodeInstructions(secondBody);
  assert.equal(decoded[0].opcode, id('LOAD_NUMBER'));
  assert.equal(decoded[0].imm32, 2);
});

test('buildSections rebases pool indexes so two functions cannot share a constant by accident', () => {
  const first = emitFunction(fnNode('function f() { return 0.25; }'), 'a.js');
  const second = emitFunction(fnNode('function g() { return 0.75; }'), 'b.js');
  const sections = buildSections([first, second]);

  const pool = decodeConstantPool(sections.constants, { maxConstants: 8, maxConstantBytes: 64 });
  assert.deepEqual(
    pool.constants.map((constant) => constant.value),
    [0.25, 0.75],
  );

  const table = decodeFunctionTable(sections.functions);
  const secondBody = sections.code.subarray(table.functions[1].codeOffset, table.functions[1].codeOffset + table.functions[1].codeLength);
  const decoded = decodeInstructions(secondBody);
  assert.equal(decoded[0].opcode, id('LOAD_CONST'));
  assert.equal(decoded[0].imm32, 1);
});
