'use strict';
// Phase 0 gate: parser adapter must produce ESTree and report precise positions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSource, PARSER_NAME, PARSER_VERSION, offsetToPosition, MAX_SOURCE_BYTES } =
  require('../../dist/parser/adapter.js');

const F = 'sample.js';

test('parses CommonJS source into an ESTree Program', () => {
  const { program, parser } = parseSource({ source: 'const a = 1;\nmodule.exports = a;\n', filename: F });
  assert.equal(program.type, 'Program');
  assert.equal(program.body.length, 2);
  assert.equal(parser.name, PARSER_NAME);
  assert.match(parser.version, /^\d+\.\d+\.\d+/);
});

test('captures comments so the leakage test can assert their absence', () => {
  const { comments } = parseSource({ source: '// sentinel-comment\nconst x = 1;\n', filename: F });
  assert.deepEqual([...comments], ['// sentinel-comment']);
});

test('produces nodes with loc information for diagnostics', () => {
  const { program } = parseSource({ source: 'function f() {\n  return 1;\n}\n', filename: F });
  const fn = program.body[0];
  assert.equal(fn.type, 'FunctionDeclaration');
  assert.ok(fn.loc, 'expected loc on function declaration');
  assert.equal(fn.loc.start.line, 1);
});

test('a syntax error becomes KXOBH-E-PARSE with a real position', () => {
  assert.throws(
    () => parseSource({ source: 'const = ;\n', filename: F }),
    (err) => {
      assert.equal(err.code, 'KXOBH-E-PARSE');
      assert.equal(err.position.file, F);
      assert.ok(err.position.line >= 1);
      return true;
    },
  );
});

test('error position points at the offending line, not line 1', () => {
  const source = 'const ok = 1;\nconst ok2 = 2;\nconst broken = (;\n';
  assert.throws(
    () => parseSource({ source, filename: F }),
    (err) => {
      assert.equal(err.position.line, 3);
      return true;
    },
  );
});

test('ESM syntax parses so the validator can reject it precisely, not the parser', () => {
  // v1.0 is CommonJS-only, but rejection belongs to the syntax validator which can
  // report a feature name and an action. Bare parser failure would lose that.
  const { program } = parseSource({ source: "import fs from 'node:fs';\n", filename: F });
  assert.equal(program.body[0].type, 'ImportDeclaration');
});

test('oversized input is rejected before parsing', () => {
  const big = 'a'.repeat(MAX_SOURCE_BYTES + 1);
  assert.throws(
    () => parseSource({ source: big, filename: F }),
    (err) => err.code === 'KXOBH-E-PARSE' && /exceed/i.test(err.message),
  );
});

test('offsetToPosition converts offsets correctly across newlines', () => {
  const source = 'abc\ndef\nghi';
  assert.deepEqual(offsetToPosition(source, 0, F), { file: F, line: 1, column: 0 });
  assert.deepEqual(offsetToPosition(source, 4, F), { file: F, line: 2, column: 0 });
  assert.deepEqual(offsetToPosition(source, 9, F), { file: F, line: 3, column: 1 });
});

test('offsetToPosition clamps out-of-range offsets instead of throwing', () => {
  assert.equal(offsetToPosition('ab', 999, F).line, 1);
  assert.equal(offsetToPosition('ab', -5, F).column, 0);
});
