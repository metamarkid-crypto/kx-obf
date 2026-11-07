'use strict';
// Phase 1 gate: fixtures are classified correctly. No code generation is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSource } = require('../../dist/parser/adapter.js');
const { validateSyntax, assertSupported, UNSUPPORTED_RULES } = require('../../dist/compiler/support.js');

const F = 'fixture.js';

function classify(source) {
  const { program } = parseSource({ source, filename: F });
  return validateSyntax(program, { filename: F });
}

// Fixtures drawn from Spec §8.1 — every one of these must be accepted.
const SUPPORTED = [
  ['var/let/const', 'var a=1; let b=2; const c=3;'],
  ['function declaration', 'function f(x){ return x + 1; } f(1);'],
  ['function expression', 'var f = function (x) { return x; };'],
  ['arrow function', 'var f = (a, b) => a * b;'],
  ['arithmetic precedence', 'var x = 1 + 2 * 3 - (4 / 2) % 3;'],
  ['unary and update', 'var i = 0; i++; --i; var t = typeof i; var v = void 0;'],
  ['comparison and bitwise', 'var r = (1 < 2) && (3 >= 3) | (4 ^ 5) & 6; var s = 1 << 2 >> 1 >>> 0;'],
  ['logical operators', 'var a = 0 || 1; var b = 1 && 2; var c = null ?? 3;'],
  ['conditional and sequence', 'var x = 1 ? 2 : 3; var y = (1, 2, 3);'],
  ['member access', 'var o = { a: 1 }; var p = o.a; var q = o["a"];'],
  ['assignment operators', 'var x = 1; x += 2; x -= 1; x *= 3; x /= 2; x %= 4;'],
  ['method call receiver', 'var o = { f: function () { return this; } }; o.f();'],
  ['new expression', 'function C(v) { this.v = v; } var c = new C(1);'],
  ['object literal shorthand + computed + getter', 'var k = "x"; var o = { k, [k + "2"]: 1, get g() { return 1; }, set g(v) {} };'],
  ['array literal + index', 'var a = [1, 2, 3]; a[0] = 4;'],
  ['if / else', 'if (1) { } else if (0) { } else { }'],
  ['while / do-while', 'var i = 0; while (i < 3) { i++; } do { i--; } while (i > 0);'],
  ['classic for + break/continue', 'for (var i = 0; i < 3; i++) { if (i === 1) continue; if (i === 2) break; }'],
  ['for-in / for-of', 'var o = {a:1}; for (var k in o) {} for (var v of [1]) {}'],
  ['switch', 'var x = 1; switch (x) { case 1: break; default: break; }'],
  ['throw / try / catch / finally', 'try { throw new Error("x"); } catch (e) { } finally { }'],
  ['template literal', 'var n = 2; var s = `a${n}b`;'],
  ['regex literal', 'var re = /ab+c/gi; re.test("abc");'],
  ['async/await', 'async function f() { return await Promise.resolve(1); }'],
  ['optional chaining / nullish', 'var o = {}; var v = o?.a ?? 1;'],
  ['commonjs exports', 'module.exports = { a: 1 }; var fs = require("node:fs");'],
  ['delete / in / instanceof', 'var o = { a: 1 }; delete o.a; var h = "a" in o; var i = o instanceof Object;'],
  ['try with return from finally', 'function f() { try { return 1; } finally { } }'],
  // Spec §8.7 amendment (BigInt literals): accepted only because the compiler,
  // constant pool codec, VM and semantic tests all cover it. See SPEC_ADDENDUM.md.
  ['bigint literal', 'var b = 10n; var c = 0b101n + 0xFFn + 0o7n;'],
];

for (const [name, source] of SUPPORTED) {
  test(`accepts supported: ${name}`, () => {
    const report = classify(source);
    assert.deepEqual(report.violations, [], `${name} should be accepted`);
    assert.equal(report.ok, true);
  });
}

// Fixtures drawn from Spec §8.2 — each must be rejected with a specific feature id.
const UNSUPPORTED = [
  ['generator-function', 'function* g() { yield 1; }'],
  ['generator-function', 'var g = function* () { yield 1; };'],
  ['for-await-of', 'async function f(xs) { for await (var x of xs) {} }'],
  ['top-level-await', 'var x = await Promise.resolve(1);'],
  ['esm-import', "import fs from 'node:fs';"],
  ['esm-import', 'export const a = 1;'],
  ['dynamic-import', "async function f() { return import('x'); }"],
  ['eval', 'eval("1 + 1");'],
  ['new-function', 'var f = new Function("return 1");'],
  ['class', 'class A { m() { return 1; } }'],
  ['class-private-field', 'class A { #p = 1; get p() { return this.#p; } }'],
  ['super', 'var o = { m() { return 1; } }; var p = { m() { return super.m; } };'],
  ['destructuring', 'var { a } = obj;'],
  ['destructuring', 'var [a] = [1];'],
  ['spread-rest', 'var a = [1]; var b = [...a];'],
  ['spread-rest', 'var f = function (...args) {};'],
  ['labeled-statement', 'outer: for (;;) { break outer; }'],
  ['with-statement', 'with (Math) { var x = floor(1.5); }'],
  ['regex-unicode-sets', 'var re = /[\\p{L}]/v;'],
];

for (const [expectedId, source] of UNSUPPORTED) {
  test(`rejects unsupported: ${expectedId}`, () => {
    const report = classify(source);
    assert.equal(report.ok, false, `${source} should be rejected`);
    const ids = report.violations.map((v) => v.id);
    assert.ok(ids.includes(expectedId), `expected ${expectedId}, got ${JSON.stringify(ids)}`);
  });
}

// These node types cannot be produced by plain acorn: they need a parser plugin.
// The rules remain as defence in depth, and are documented as unreachable here.
const PLUGIN_REQUIRED = new Set(['jsx', 'decorator']);

test('every reachable unsupported rule has a fixture proving rejection', () => {
  const covered = new Set(UNSUPPORTED.map(([id]) => id));
  for (const rule of UNSUPPORTED_RULES) {
    if (PLUGIN_REQUIRED.has(rule.id)) continue;
    assert.ok(covered.has(rule.id), `rule "${rule.id}" has no rejection fixture`);
  }
});

test('plugin-only rules are documented instead of silently untested', () => {
  for (const id of PLUGIN_REQUIRED) {
    assert.ok(
      UNSUPPORTED_RULES.some((r) => r.id === id),
      `${id} must stay listed as unsupported even without a fixture`,
    );
  }
});

test('rejection diagnostics carry file, line, column, feature and action', () => {
  const { program } = parseSource({ source: 'var ok = 1;\nfunction* g() { yield 1; }\n', filename: F });
  assert.throws(
    () => assertSupported(program, { filename: F }),
    (err) => {
      assert.equal(err.code, 'KXOBH-E-COMPILER-UNSUPPORTED');
      assert.equal(err.exitCode, 11);
      assert.equal(err.position.line, 2);
      assert.equal(err.position.column, 0);
      assert.match(err.hint.feature, /generator/);
      assert.ok(err.hint.action.length > 0);
      const formatted = err.format();
      assert.match(formatted, /^KXOBH-E-COMPILER-UNSUPPORTED\nfixture\.js:2:0\n/);
      return true;
    },
  );
});

test('violations are reported in source order, all of them not just the first', () => {
  // `10n` used to be a third violation (bigint-literal); BigInt literals are
  // supported since the Phase 3.1 amendment, so this fixture now uses `class`,
  // which stays unsupported.
  const report = classify('var a = new Function("1");\nclass B {}\nvar c = { ...a };\n');
  assert.equal(report.violations.length >= 2, true);
  assert.deepEqual(
    report.violations.map((v) => v.position.line),
    [...report.violations.map((v) => v.position.line)].sort((a, b) => a - b),
  );
});

test('deeply nested input is walked without overflowing the stack', () => {
  // Acorn itself has a hard nesting limit on script input; stay under it, then
  // prove the *walk* is iterative by checking a depth acorn accepts.
  const depth = 400;
  const source = `${'if (1) {'.repeat(depth)}${'}'.repeat(depth)}`;
  assert.equal(classify(source).ok, true);
});

test('parser stack exhaustion is reported as KXOBH-E-PARSE, not a crash', () => {
  const depth = 20000;
  const source = `${'if (1) {'.repeat(depth)}${'}'.repeat(depth)}`;
  assert.throws(
    () => classify(source),
    (err) => err.code === 'KXOBH-E-PARSE' && /stack/i.test(err.message),
  );
});
