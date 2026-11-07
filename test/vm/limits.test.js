'use strict';
/**
 * VM resource limits (Spec §9.7).
 *
 * Limits are the VM's only defence against a hostile or corrupt package driving
 * an unbounded allocation. Two properties matter and are tested here: a bad
 * override is refused loudly rather than being coercively reinterpreted, and an
 * exceeded limit raises a typed KXOBH-E-VM-LIMIT instead of a bare RangeError or
 * an out-of-memory crash.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_VM_LIMITS, resolveLimits, enforceLimit } = require('../../dist/vm/limits.js');

test('defaults are frozen and cover every documented limit', () => {
  assert.ok(Object.isFrozen(DEFAULT_VM_LIMITS));
  assert.deepEqual(Object.keys(DEFAULT_VM_LIMITS).sort(), [
    'instructionBudget',
    'maxConstantBytes',
    'maxConstants',
    'maxExceptionRecords',
    'maxFrameDepth',
    'maxFrameSlots',
    'maxFunctions',
    'maxInstructionsPerFunction',
    'maxPackageBytes',
    'maxRegisters',
    'maxSectionBytes',
  ]);
});

test('defaults are finite positive integers so no limit is silently disabled', () => {
  for (const [name, value] of Object.entries(DEFAULT_VM_LIMITS)) {
    if (name === 'instructionBudget') continue; // 0 is the documented "disabled"
    assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  }
});

test('resolveLimits with no overrides returns the defaults', () => {
  assert.deepEqual({ ...resolveLimits() }, { ...DEFAULT_VM_LIMITS });
});

test('an override changes only the named limit and the result is frozen', () => {
  const limits = resolveLimits({ maxFrameDepth: 8 });
  assert.equal(limits.maxFrameDepth, 8);
  assert.equal(limits.maxRegisters, DEFAULT_VM_LIMITS.maxRegisters);
  assert.ok(Object.isFrozen(limits));
});

test('undefined overrides are ignored rather than zeroing a limit', () => {
  assert.equal(resolveLimits({ maxFrameDepth: undefined }).maxFrameDepth, DEFAULT_VM_LIMITS.maxFrameDepth);
});

test('the defaults themselves are never mutated by a resolve', () => {
  const before = { ...DEFAULT_VM_LIMITS };
  resolveLimits({ maxFrameDepth: 4, maxRegisters: 16 });
  assert.deepEqual({ ...DEFAULT_VM_LIMITS }, before);
});

test('unknown limit names are rejected instead of silently ignored', () => {
  assert.throws(
    () => resolveLimits({ maxFrames: 4 }),
    (error) => error.code === 'KXOBH-E-CONFIG' && /unknown VM limit maxFrames/.test(error.message),
  );
});

test('non-integer, negative, and non-finite overrides are rejected', () => {
  for (const value of [-1, 1.5, Number.NaN, Infinity, -Infinity, '64', null]) {
    assert.throws(
      () => resolveLimits({ maxFrameDepth: value }),
      (error) => error.code === 'KXOBH-E-CONFIG',
      `maxFrameDepth ${String(value)} must be refused`,
    );
  }
});

test('an unsafe integer override is rejected rather than losing precision', () => {
  assert.throws(
    () => resolveLimits({ maxConstants: Number.MAX_SAFE_INTEGER + 2 }),
    (error) => error.code === 'KXOBH-E-CONFIG',
  );
});

test('maxRegisters must be at least 1', () => {
  assert.throws(
    () => resolveLimits({ maxRegisters: 0 }),
    (error) => error.code === 'KXOBH-E-CONFIG' && /at least 1/.test(error.message),
  );
});

test('maxRegisters may not outgrow the 16-bit operand field', () => {
  // Register operands are u16, so a register file above 0xffff is unaddressable.
  for (const value of [0xffff + 1, 1 << 20]) {
    assert.throws(
      () => resolveLimits({ maxRegisters: value }),
      (error) => error.code === 'KXOBH-E-CONFIG' && /16-bit/.test(error.message),
      `maxRegisters ${value} must be refused`,
    );
  }
  // 0xffff itself is allowed and still safe: valid indexes are 0 .. maxRegisters-1,
  // so the ABSENT sentinel (0xffff) remains out of range.
  assert.equal(resolveLimits({ maxRegisters: 0xffff }).maxRegisters, 0xffff);
});

test('enforceLimit passes at the limit and throws one past it', () => {
  const limits = resolveLimits({ maxFunctions: 2 });
  enforceLimit('maxFunctions', 2, limits);
  assert.throws(
    () => enforceLimit('maxFunctions', 3, limits),
    (error) =>
      error.code === 'KXOBH-E-VM-LIMIT' &&
      error.details.limit === 'maxFunctions' &&
      error.details.actual === 3 &&
      error.details.maximum === 2,
  );
});

test('a limit of 0 disables the check', () => {
  const limits = resolveLimits({ maxPackageBytes: 0 });
  enforceLimit('maxPackageBytes', 2 ** 40, limits);
});

test('an exceeded limit reports as a typed VM error, not a RangeError', () => {
  const limits = resolveLimits({ maxSectionBytes: 1 });
  assert.throws(
    () => enforceLimit('maxSectionBytes', 2, limits),
    (error) => error instanceof Error && error.name !== 'RangeError' && error.code === 'KXOBH-E-VM-LIMIT',
  );
});
