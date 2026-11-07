'use strict';
/**
 * Opcode catalog integrity gate (Spec §19.3, rule 16).
 *
 * The per-opcode execution matrix lives in `opcodes.test.js`, in the same file
 * that runs the opcodes. It asserts there that every non-reserved catalogued
 * opcode was executed, that no unknown name is claimed, and that no reserved
 * opcode is claimed as executed — recorded and asserted in one process, because
 * `node --test` gives each file its own process and re-`require`ing the test file
 * would re-register every test in it.
 *
 * This file covers what that matrix cannot: properties of the catalog itself,
 * and the verifier's refusal to execute a reserved opcode. Those need no
 * knowledge of what ran.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  OPCODES,
  OPCODE_BY_NAME,
  RESERVED_OPCODE_IDS,
  isReservedOpcode,
  IDENTITY_OPMAP,
} = require('../../dist/bytecode/opcodes.js');
const { ins, encodeInstructions } = require('../../dist/bytecode/instruction.js');
const { encodeConstantPool } = require('../../dist/bytecode/constants.js');
const { encodeFunctionTable } = require('../../dist/bytecode/functions.js');
const { encodeExceptionTable } = require('../../dist/bytecode/exceptions.js');
const { assembleProgram } = require('../../dist/vm/program.js');

test('every reserved id is a catalogued opcode that is not executable', () => {
  for (const id of RESERVED_OPCODE_IDS) {
    const spec = OPCODES.find((op) => op.id === id);
    assert.ok(spec, `reserved opcode id ${id} is not in the catalog`);
    assert.ok(isReservedOpcode(id), `${spec.name} must be reported as reserved`);

    // Hand-assemble a program that emits the reserved opcode and prove the
    // verifier refuses it before any instruction runs. A half-implemented
    // operation must never reach execution on a best-effort basis.
    const code = encodeInstructions([ins(id, {})]);
    assert.throws(
      () =>
        assembleProgram(
          {
            code,
            constants: encodeConstantPool([]),
            functions: encodeFunctionTable([
              { codeOffset: 0, codeLength: code.length, paramCount: 0, localCount: 0, registerCount: 4, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
            ]),
            opmap: IDENTITY_OPMAP,
          },
          { resolve: () => undefined },
          { maxRegisters: 64, maxFrameSlots: 64 },
        ),
      (error) => error.code === 'KXOBH-E-ABI' && /reserved in VM ABI/.test(error.message),
      `${spec.name} must be rejected as reserved`,
    );
  }
});

test('opcode ids are unique and mnemonics are unique', () => {
  const ids = new Set();
  const names = new Set();
  for (const op of OPCODES) {
    assert.ok(!ids.has(op.id), `duplicate opcode id ${op.id}`);
    assert.ok(!names.has(op.name), `duplicate mnemonic ${op.name}`);
    ids.add(op.id);
    names.add(op.name);
  }
  assert.equal(OPCODES.length, OPCODE_BY_NAME.size);
});

/** Assembles a single-function program from instructions, failing the test on any throw. */
function assemble({ instructions, constantCount = 0, importCount = 0, exceptions, captureCount = 0, localCount = 0, functionRecords }) {
  const code = encodeInstructions(instructions);
  return assembleProgram(
    {
      code,
      constants: encodeConstantPool(
        Array.from({ length: constantCount }, (_, i) => ({ kind: 'number', value: i })),
      ),
      functions: encodeFunctionTable(
        functionRecords ?? [
          { codeOffset: 0, codeLength: code.length, paramCount: 0, localCount, registerCount: 8, maxStackHint: 0, flags: 0, captureCount, nameConstant: 0xffffffff },
        ],
      ),
      exceptions: exceptions ? encodeExceptionTable(exceptions) : undefined,
      opmap: IDENTITY_OPMAP,
      capabilityIds: Array.from({ length: importCount }, (_, i) => `cap${i}`),
    },
    { resolve: (id) => ({ name: id, async: false, fn: () => undefined }) },
    { maxRegisters: 64, maxFrameSlots: 64 },
  );
}

/** Asserts the assembler rejected the program as malformed bytecode. */
function rejects(instructions, pattern, options = {}) {
  assert.throws(
    () => assemble({ instructions, ...options }),
    (error) => error.code === 'KXOBH-E-BYTECODE' && pattern.test(error.message),
    `expected a verifier rejection matching ${pattern}`,
  );
}

test('malformed input: constant indexes past the pool are rejected, not read as undefined', () => {
  for (const name of ['LOAD_CONST', 'CREATE_REGEXP']) {
    rejects([ins(OPCODE_BY_NAME.get(name).id, { dst: 1, imm32: 0 })], /constant index 0 is out of range/);
  }
});

test('malformed input: import indexes past the import table are rejected', () => {
  for (const name of ['LOAD_GLOBAL_CAPABILITY', 'IMPORT_CAPABILITY']) {
    rejects([ins(OPCODE_BY_NAME.get(name).id, { dst: 1, imm32: 3 })], /import index 3 is out of range/);
  }
});

test('malformed input: CREATE_CLOSURE must name a catalogued function', () => {
  rejects([ins(OPCODE_BY_NAME.get('CREATE_CLOSURE').id, { dst: 1, imm32: 5 })], /function index 5 is out of range/);
});

test('CREATE_CLOSURE accepts its capture window in `b` and rejects a missing or stray one', () => {
  const CREATE_CLOSURE = OPCODE_BY_NAME.get('CREATE_CLOSURE').id;
  const twoFunctions = (captureCount) => [
    { codeOffset: 0, codeLength: 12, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount: 0, nameConstant: 0xffffffff },
    { codeOffset: 12, codeLength: 12, paramCount: 0, localCount: 0, registerCount: 8, maxStackHint: 0, flags: 0, captureCount, captureBase: captureCount === 0 ? undefined : 0, nameConstant: 0xffffffff },
  ];

  // The documented encoding must verify, otherwise no capturing closure could
  // ever be assembled (the two verifier rules would contradict).
  assert.doesNotThrow(() =>
    assemble({
      functionRecords: twoFunctions(1),
      instructions: [ins(CREATE_CLOSURE, { dst: 1, b: 2, imm32: 1 }), ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    }),
  );

  // A capturing callee with no window cannot borrow any cell.
  rejects(
    [ins(CREATE_CLOSURE, { dst: 1, imm32: 1 }), ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /captures 1 slot\(s\), so a capture window base is required in b/,
    { functionRecords: twoFunctions(1) },
  );

  // A non-capturing callee must not name a window it will not read.
  rejects(
    [ins(CREATE_CLOSURE, { dst: 1, b: 2, imm32: 1 }), ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /captures nothing, so b must be ABSENT/,
    { functionRecords: twoFunctions(0) },
  );
});

test('SWITCH_DISPATCH is rejected as reserved rather than dispatched to a runtime throw', () => {
  // `switch` is lowered to comparisons and jumps; the id stays catalogued so the
  // numbering never shifts, but a package that emits it must fail verification
  // instead of reaching a VM case that throws "not lowered" at runtime.
  const id = OPCODE_BY_NAME.get('SWITCH_DISPATCH').id;
  assert.ok(isReservedOpcode(id));
  assert.throws(
    () => assemble({ instructions: [ins(id, {})] }),
    (error) => error.code === 'KXOBH-E-ABI' && /reserved in VM ABI/.test(error.message),
  );
});

test('malformed input: CALL_CAPABILITY must name a declared capability', () => {
  rejects(
    [ins(OPCODE_BY_NAME.get('CALL_CAPABILITY').id, { dst: 1, a: 2, b: 1, imm32: 0 })],
    /capability index 2 is out of range/,
  );
});

test('malformed input: CATCH_BIND may not write a slot outside the frame', () => {
  rejects(
    [ins(OPCODE_BY_NAME.get('CATCH_BIND').id, { imm32: 4 }), ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /catch slot 4 is out of range/,
    { localCount: 1 },
  );
});

test('malformed input: a protected range outside every function is rejected', () => {
  // Function-local coordinates: pc 5 is past the end of the only function's body.
  rejects(
    [ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /protected range \[5, 6\) exceeds function #0 \(1 instructions\)/,
    { exceptions: [{ fnIndex: 0, startPc: 5, endPc: 6, handlerPc: 0, kind: 0, slot: 0 }] },
  );
});

test('malformed input: an exception record naming a missing function is rejected', () => {
  rejects(
    [ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /exception #0: names function #7, which does not exist/,
    { exceptions: [{ fnIndex: 7, startPc: 0, endPc: 1, handlerPc: 0, kind: 0, slot: 0 }] },
  );
});

test('malformed input: a handler pc in another function body is rejected', () => {
  rejects(
    [ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /handlerPc 4 is outside function #0/,
    { exceptions: [{ fnIndex: 0, startPc: 0, endPc: 1, handlerPc: 4, kind: 0, slot: 0 }] },
  );
});

test('malformed input: a catch slot wider than the function frame is rejected', () => {
  rejects(
    [ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /catch slot 3 is out of range in function #0/,
    { exceptions: [{ fnIndex: 0, startPc: 0, endPc: 1, handlerPc: 0, kind: 0, slot: 3 }], localCount: 0 },
  );
});

test('malformed input: a call window that runs past the function register file is rejected', () => {
  rejects([ins(OPCODE_BY_NAME.get('CALL').id, { dst: 1, a: 7, imm32: 4 })], /argument window .* exceeds registerCount/);
});

test('malformed input: an unbounded argument count is rejected', () => {
  rejects([ins(OPCODE_BY_NAME.get('CALL').id, { dst: 1, a: 1, imm32: 241 })], /argument count 241 exceeds limit/);
});

// A self-branch is legal: it is how a `for (;;)` body is lowered, and the loop is
// bounded by the VM's instruction budget rather than by the verifier. The check
// that replaces the old "offset must be non-zero" rule is that the branch target
// can never precede the branch itself.
// Branch offsets are measured in instruction units from the branch instruction
// itself, so the only way to address a pc before the section start is a negative
// offset at pc 0.
test('malformed input: a backward branch past the function start is rejected', () => {
  rejects([ins(OPCODE_BY_NAME.get('JUMP').id, { imm32: -1 })], /branch offset -1 targets pc -1/);
});

test('malformed input: an unconditional branch may target itself', () => {
  const instructions = [ins(OPCODE_BY_NAME.get('JUMP').id, { imm32: 0 })];
  const program = assemble({ instructions });
  assert.ok(program, 'a self-branch must assemble');
});

test('malformed input: a conditional branch may not re-test the same instruction', () => {
  // A taken conditional branch must make progress: offset 0 would re-test the
  // same condition forever (the instruction budget would catch it at runtime,
  // but a statically unresolvable hang is rejected here instead).
  rejects(
    [ins(OPCODE_BY_NAME.get('JUMP_IF_FALSE').id, { dst: 1, imm32: 0 }), ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /branch offset 0 targets pc 0, before the minimum 1/,
  );
});

test('malformed input: a branch leaving its own function is rejected', () => {
  // A forward offset past the last instruction of the (single) function.
  rejects(
    [ins(OPCODE_BY_NAME.get('JUMP').id, { imm32: 9 }), ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {})],
    /branch target 9 \(offset 9\) is outside the function/,
  );
});

test('malformed input: a branch offset is relative to the branch, not the function', () => {
  // `JUMP -2` at pc2 targets pc 0. Read as an absolute target it would point at
  // pc -2 and be rejected; read relatively it is an ordinary backward branch.
  const instructions = [
    ins(OPCODE_BY_NAME.get('NOP').id, {}), // pc0
    ins(OPCODE_BY_NAME.get('NOP').id, {}), // pc1
    ins(OPCODE_BY_NAME.get('JUMP').id, { imm32: -2 }), // pc2 -> pc0
    ins(OPCODE_BY_NAME.get('RETURN_UNDEFINED').id, {}), // pc3
  ];
  assert.ok(assemble({ instructions }), 'a relative backward branch inside the function must assemble');
});

test('malformed input: an uninitialized register operand is rejected', () => {
  rejects([ins(OPCODE_BY_NAME.get('MOVE').id, { dst: 1, a: 0xffff })], /a register is required/);
});

test('malformed input: operands on a no-operand opcode are rejected', () => {
  rejects([ins(OPCODE_BY_NAME.get('NOP').id, { dst: 1 })], /no operands allowed/);
});

test('opcode ids are contiguous from 1 so the append-only rule cannot drift', () => {
  const sorted = [...OPCODES].map((op) => op.id).sort((a, b) => a - b);
  sorted.forEach((id, index) => {
    assert.equal(id, index + 1, `opcode id ${id} breaks the contiguous 1..${OPCODES.length} contract`);
  });
});
