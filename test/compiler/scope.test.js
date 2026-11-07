'use strict';
// Phase 1 gate: scope analysis correctness (Spec §8.3).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSource } = require('../../dist/parser/adapter.js');
const { analyzeScopes } = require('../../dist/compiler/scope.js');

function analyze(source) {
  const { program } = parseSource({ source, filename: 'fixture.js' });
  return analyzeScopes(program);
}

test('var is hoisted into the function scope, not the block', () => {
  const a = analyze('if (1) { var x = 1; }');
  assert.equal(a.global.bindings.has('x'), true);
});

test('let/const stay in the block scope', () => {
  const a = analyze('{ let y = 1; const z = 2; }');
  assert.equal(a.global.bindings.has('y'), false);
  const names = a.scopes.flatMap((s) => [...s.bindings.keys()]);
  assert.ok(names.includes('y'));
  assert.ok(names.includes('z'));
});

test('var is marked hoisted; let/const are in the temporal dead zone', () => {
  const a = analyze('var v = 1; let l = 2; const c = 3;');
  assert.equal(a.global.bindings.get('v').hoisted, true);
  assert.equal(a.global.bindings.get('v').temporalDeadZone, false);
  assert.equal(a.global.bindings.get('l').temporalDeadZone, true);
  assert.equal(a.global.bindings.get('c').kind, 'const');
});

test('function declarations are hoisted into the enclosing function scope', () => {
  const a = analyze('{ function g() {} }');
  assert.equal(a.global.bindings.get('g').kind, 'function');
  assert.equal(a.global.bindings.get('g').hoisted, true);
});

test('parameters are declared in the function scope', () => {
  const a = analyze('function f(a, b) { return a + b; }');
  const fnScope = a.scopes.find((s) => s.kind === 'function');
  assert.ok(fnScope);
  assert.deepEqual([...fnScope.bindings.keys()].sort(), ['a', 'b']);
  assert.equal(fnScope.bindings.get('a').kind, 'param');
});

test('shadowing produces a nested binding with the same name', () => {
  const a = analyze('var x = 1; function f() { var x = 2; return x; }');
  assert.equal(a.global.bindings.get('x').scopeDepth, 0);
  const inner = a.scopes.filter((s) => s.bindings.has('x') && s.depth > 0);
  assert.equal(inner.length, 1);
});

test('catch parameter is a catch-scope binding', () => {
  const a = analyze('try { } catch (err) { err; }');
  const catchScope = a.scopes.find((s) => s.kind === 'catch');
  assert.ok(catchScope);
  assert.equal(catchScope.bindings.get('err').kind, 'catch');
});

test('strict mode is detected from a directive', () => {
  assert.equal(analyze('"use strict";\nvar a = 1;').strict, true);
  assert.equal(analyze('var a = 1;').strict, false);
  // A non-directive expression statement ends the directive prologue.
  assert.equal(analyze('var a = 1;\n"use strict";').strict, false);
});

test('free identifiers are reported without false declarations', () => {
  const a = analyze('var local = 1; console.log(local);');
  assert.deepEqual([...a.freeIdentifiers], ['console']);
});

test('arrow functions create a function boundary scope', () => {
  const a = analyze('var f = () => 1;');
  const fnScope = a.scopes.find((s) => s.kind === 'function');
  assert.ok(fnScope);
  assert.equal(fnScope.functionBoundary, true);
});

test('scope depth increases monotonically downward', () => {
  const a = analyze('function f() { if (1) { let x = 1; } }');
  for (const scope of a.scopes) {
    if (scope.parent) assert.equal(scope.depth, scope.parent.depth + 1);
  }
});
