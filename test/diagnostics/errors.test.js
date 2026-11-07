'use strict';
// Phase 0 gate: error catalog contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const { KxobhError, ERROR_CODES, EXIT_CODES, toKxobhError, errors } = require('../../dist/diagnostics/errors.js');

test('every error code is prefixed with KXOBH-E-', () => {
  for (const code of Object.values(ERROR_CODES)) {
    assert.match(code, /^KXOBH-E-[A-Z-]+$/);
  }
});

test('error codes are unique', () => {
  const values = Object.values(ERROR_CODES);
  assert.equal(new Set(values).size, values.length);
});

test('every code maps to a declared exit code', () => {
  const known = new Set(Object.values(EXIT_CODES));
  for (const code of Object.values(ERROR_CODES)) {
    const err = new KxobhError(code, 'x');
    assert.ok(known.has(err.exitCode), `${code} -> ${err.exitCode}`);
    assert.notEqual(err.exitCode, undefined);
  }
});

test('unsupported syntax exits with 11, package errors with 20', () => {
  const pos = { file: 'a.js', line: 42, column: 7 };
  assert.equal(errors.unsupported('nope', pos, { feature: 'generators' }).exitCode, 11);
  assert.equal(new KxobhError(ERROR_CODES.PACKAGE_MAGIC, 'bad').exitCode, 20);
  assert.equal(new KxobhError(ERROR_CODES.AEAD, 'bad').exitCode, 22);
  assert.equal(new KxobhError(ERROR_CODES.SIGNATURE, 'bad').exitCode, 21);
  assert.equal(new KxobhError(ERROR_CODES.NODE_VERSION, 'bad').exitCode, 30);
});

test('diagnostic format matches file:line:column + feature + action', () => {
  const err = errors.unsupported(
    'Unsupported syntax: GeneratorFunction',
    { file: 'src/payment.js', line: 42, column: 7 },
    { feature: 'generator functions', action: 'rewrite the loop without yield' },
  );
  assert.equal(
    err.format(),
    [
      'KXOBH-E-COMPILER-UNSUPPORTED',
      'src/payment.js:42:7',
      'Unsupported syntax: GeneratorFunction',
      'Feature: generator functions',
      'Action: rewrite the loop without yield',
    ].join('\n'),
  );
});

test('toKxobhError preserves the original cause instead of swallowing it', () => {
  const inner = new Error('real cause');
  const wrapped = toKxobhError(inner);
  assert.equal(wrapped.code, ERROR_CODES.INTERNAL);
  assert.equal(wrapped.cause, inner);
  assert.equal(wrapped.message, 'real cause');
});

test('toKxobhError passes an existing KxobhError through unchanged', () => {
  const original = errors.config('bad config');
  assert.equal(toKxobhError(original), original);
});

test('a message with no readable text still yields a safe message', () => {
  assert.equal(toKxobhError({}).message, 'Unexpected internal error');
});
