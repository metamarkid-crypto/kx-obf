'use strict';
// Phase 0 gate: CLI surface is testable in-process with stable exit codes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, parseArgv, TOOL_VERSION } = require('../../dist/cli/main.js');

test('help exits 0 and mentions authorized use', () => {
  const r = run(['help']);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /AUTHORIZED USE/);
  assert.match(r.stdout, /build <input\.js> --out <output\.js>/);
});

test('no arguments prints help rather than failing', () => {
  assert.equal(run([]).exitCode, 0);
});

test('version prints tool, format and parser versions', () => {
  const r = run(['version']);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, new RegExp(`kxobh ${TOOL_VERSION}`));
  assert.match(r.stdout, /format 1\.0\.0/);
  assert.match(r.stdout, /parser acorn@/);
});

test('doctor exits 0 on a supported host and states declared vs tested', () => {
  const r = run(['doctor']);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /declared/);
  assert.match(r.stdout, /tested/);
  // The host must never be reported as declared-but-unchecked without a label.
  assert.doesNotMatch(r.stdout, /tested\s+\(none\)/);
});

test('doctor rejects an undeclared node target with exit 30', () => {
  const r = run(['doctor', '--node-target', '14']);
  assert.equal(r.exitCode, 30);
  assert.match(r.stderr, /KXOBH-E-NODE-VERSION/);
});

test('doctor rejects a non-numeric target with exit 2', () => {
  const r = run(['doctor', '--node-target', 'abc']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /KXOBH-E-CONFIG/);
});

test('unimplemented commands fail loudly instead of pretending success', () => {
  for (const cmd of ['build', 'verify', 'inspect', 'keygen']) {
    const r = run([cmd, 'x.js']);
    assert.notEqual(r.exitCode, 0, `${cmd} must not exit 0`);
    assert.match(r.stderr, /KXOBH-E-INTERNAL/);
    assert.match(r.stderr, /has not passed its gate/);
  }
});

test('unknown command exits 2 with usage hint', () => {
  const r = run(['frobnicate']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /Unknown command/);
  assert.match(r.stderr, /kxobh help/);
});

test('argv parser handles repeated flags and = syntax', () => {
  const parsed = parseArgv(['build', 'in.js', '--out', 'o.js', '--allow-builtin', 'node:fs', '--allow-builtin=node:path', '--diagnostic']);
  assert.equal(parsed.command, 'build');
  assert.deepEqual([...parsed.positionals], ['in.js']);
  assert.deepEqual(parsed.flags.get('--allow-builtin'), ['node:fs', 'node:path']);
  assert.deepEqual(parsed.flags.get('--diagnostic'), ['']);
  assert.deepEqual(parsed.flags.get('--out'), ['o.js']);
});
