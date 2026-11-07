'use strict';
// Phase 0 gate: node target config must never blur declared vs tested.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNodeTargets,
  loadNodeTargets,
  untestedDeclaredMajors,
  isTestedMajor,
  currentNodeMajor,
} = require('../../dist/config/node-targets.js');

test('the committed config loads and is internally consistent', () => {
  const config = loadNodeTargets();
  assert.ok(config.declared.length > 0);
  for (const major of config.testedOnHost) {
    assert.ok(config.declared.includes(major), `${major} tested but not declared`);
  }
});

test('declared majors are sorted ascending', () => {
  const config = loadNodeTargets();
  const sorted = [...config.declared].sort((a, b) => a - b);
  assert.deepEqual([...config.declared], sorted);
});

test('a tested major outside the declared matrix is rejected', () => {
  assert.throws(
    () => parseNodeTargets({ declared: [20, 22], testedOnHost: [24] }),
    (err) => err.code === 'KXOBH-E-CONFIG',
  );
});

test('non-integer or too-low majors are rejected', () => {
  assert.throws(() => parseNodeTargets({ declared: ['20'], testedOnHost: [] }), (e) => e.code === 'KXOBH-E-CONFIG');
  assert.throws(() => parseNodeTargets({ declared: [12], testedOnHost: [] }), (e) => e.code === 'KXOBH-E-CONFIG');
  assert.throws(() => parseNodeTargets({ declared: [], testedOnHost: [] }), (e) => e.code === 'KXOBH-E-CONFIG');
  assert.throws(() => parseNodeTargets(null), (e) => e.code === 'KXOBH-E-CONFIG');
});

test('untestedDeclaredMajors reports the gap, not a support claim', () => {
  const config = parseNodeTargets({ declared: [20, 22, 24], testedOnHost: [24] });
  assert.deepEqual(untestedDeclaredMajors(config), [20, 22]);
  assert.equal(isTestedMajor(config, 24), true);
  assert.equal(isTestedMajor(config, 22), false);
});

test('the running Node major is detected', () => {
  const major = currentNodeMajor();
  assert.equal(typeof major, 'number');
  assert.ok(major >= 18, `unexpected major ${major}`);
});

test('a missing config file surfaces an IO error, not a crash', () => {
  assert.throws(() => loadNodeTargets('/definitely/not/here.json'), (e) => e.code === 'KXOBH-E-IO');
});
