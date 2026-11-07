# TEST COVERAGE AUDIT — 376 tests, per-file and per-category

## 1. Executed evidence (this session, 2026-11-07)

```
$ node -v          -> v24.15.0
$ npm -v           -> 11.12.1
$ npm run build    -> exit 0   (tsc -p tsconfig.json)
$ npm run typecheck-> exit 0   (tsc -p tsconfig.json --noEmit)
$ npm test         -> exit 0
```

Tail of the real output (`node --test`, spec reporter):

```
ℹ tests 376
ℹ suites 0
ℹ pass 376
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2685.3044
```

Aggregate per-file counts were derived by counting `test(` declarations per file; the sum matches the runner total, so the counts below are the runner's counts, not an estimate.

## 2. Complete test inventory — 376 tests in 16 files

| File | Tests | Category | Covers |
|---|---:|---|---|
| `test/bytecode/functions.test.js` | 14 | **unit — encoding** | constant pool, function table, exception table round-trip + rejection |
| `test/bytecode/instruction.test.js` | 14 | **unit — encoding** | 12-byte codec, LE offsets, sentinels, bounds, `withOpcode` |
| `test/cli/cli.test.js` | 9 | **unit — CLI** | help/version/doctor/exit codes, unimplemented commands fail loudly |
| `test/compiler/emitter.test.js` | 31 | **unit — compiler semantics** | literal/arith/assignment/update lowering, TDZ, pressure, section build |
| `test/compiler/regalloc.test.js` | 16 | **unit — compiler internals** | allocator marks, spill, peak pressure, `slotCount`, arg validation |
| `test/compiler/scope.test.js` | 11 | **unit — scope analysis** | hoisting, block scope, TDZ flags, catch scope, strict, free ids |
| `test/compiler/support.test.js` | 8 | **unit — rejection policy** | every reachable unsupported rule has a fixture; diagnostics carry positions |
| `test/config/node-targets.test.js` | 7 | **unit — config** | declared vs `testedOnHost`, gap reporting, IO error path |
| `test/diagnostics/errors.test.js` | 8 | **unit — diagnostics** | code prefixes, uniqueness, exit mapping, format, cause preservation |
| `test/diff/arithmetic.test.js` | 11 | **differential** | 80 numeric fixtures native-vs-VM + 6 compile/verify assertions |
| `test/parser/adapter.test.js` | 9 | **unit — parser** | ESTree output, loc, parse errors, size limit, offset mapping |
| `test/vm/coverage.test.js` | 23 | **unit — verifier** | 21 malformed-bytecode rejections, reserved-id policy, contiguity |
| `test/vm/limits.test.js` | 14 | **unit — limits** | frozen defaults, overrides, unsafe values, typed errors |
| `test/vm/opcodes.test.js` | 33 | **dispatcher execution** | every non-reserved opcode executed; CALL/closure/exception/pack paths |
| `test/vm/operators.test.js` | 15 | **semantics + exceptions** | BigInt, mixed types, TypeError completions, handler attribution, budget |
| `test/vm/program.test.js` | 6 | **integration** | hand-authored programs: arith, control flow, closure, try/catch, escapes |
| **Total** | **376** | | |

## 3. The four reported differential categories

The prior report claimed differential coverage of arithmetic, strings, control flow, and operators. Reality:

| Claimed category | Actual differential coverage | Verdict |
|---|---|---|
| Arithmetic | `test/diff/arithmetic.test.js`: **80** source fixtures compiled → VM, compared with `new Function()` native evaluation. Operators exercised: `+` 25, `-` 28, `*` 27, `/` 10, `%` 4, `**` 6. Compares with `assert.deepStrictEqual`, so `-0`, `NaN`, `±Infinity` and bit patterns must agree exactly. | **CONFIRMED (arithmetic only)** |
| Strings | No string literal can be compiled (`emitter.test.js`: "a string literal is rejected instead of being coerced to a number"). Zero differential fixtures. | **NOT PRESENT** |
| Control flow | No branching/looping construct compiles. The only control flow in the differential file is the terminal `return`. | **NOT PRESENT** |
| Operators | Non-arithmetic operators (logical, comparison, bitwise, conditional) are rejected by the compiler. They are tested **at opcode level** in `opcodes.test.js` (e.g. "comparison and equality opcodes follow JS semantics"), which is *not* differential coverage. | **NOT PRESENT as differential** |

So: **1 of 4** claimed differential categories exists, and it covers one operator family.

## 4. Build & runtime reproducibility (Audit F)

| Item | Value | Source |
|---|---|---|
| Local Node | **v24.15.0** | `node -v` |
| Local npm | **11.12.1** | `npm -v` |
| Declared targets | `[20, 22, 24]` | `config/node-targets.json` |
| Actually executed | `[24]` only | `testedOnHost: [24]`, `hostNodeVersion: "24.15.0"` |
| Node 20 / 22 tested | **no** | no CI run; config notes forbid the claim |
| CI jobs executed | **none** | `scripts/ci.sh` exists but was not run in a CI system |
| Tests against fresh `dist` | **yes** | `npm run build` (exit 0) then tests; `find src -name '*.ts' -newer dist/compiler/emitter.js` → **0**, so no source is newer than its artifact |
| Stale-artifact risk | low this session, unmanaged overall | `dist/` is not in version control, so freshness depends on running `build` before `test`; `package.json` `test` script does **not** depend on `build`. **Addendum 2026-11-07:** `dist/` and `node_modules/` are now git-ignored rather than tracked (baseline `4e8acf5`), which makes the hazard structural instead of accidental — a fresh clone has no `dist/` at all and `npm test` fails until `npm run build` runs. Verified: clean clone → `npm ci` → `npm test` = `Cannot find module '../../dist/...'`; after `npm run build` → 376/376 pass. |
| Source maps | none (`find dist -name '*.map'` → 0) | — |

Exact commands and exit codes:

| Command | Exit |
|---|---:|
| `npm run build` (`tsc -p tsconfig.json`) | 0 |
| `npm run typecheck` (`tsc --noEmit`) | 0 |
| `npm test` (`node --test --test-reporter=spec "test/**/*.test.js"`) | 0 |
| `node dist/cli/main.js doctor` | not run in this session (covered by `cli.test.js`) |

`scripts/ci.sh` would additionally run `npm run clean` + `npm ci` (lockfile-exact install) + CLI smoke. That full clean-from-lockfile path was **not** executed here, so "reproducible from a clean checkout" remains **unproven**.

## 5. Harness limitations (must not be normalized away)

1. **Type coercion is not diffed.** The differential harness only feeds sources that compile, i.e. numeric expressions. It never observes `undefined`, `null`, or string coercion through `+`.
2. **`NaN` / `-0` are covered** — via `deepStrictEqual` on the fixture set (`emitter.test.js` "−0 goes through the pool and keeps its sign"; differential fixtures include `0/0`, `1/0`, `-1/0`, `0.1*3`, `1e300*1e10`).
3. **`BigInt` is not diffed.** `operators.test.js` asserts BigInt semantics against hand-written bytecode, so a compiler that mangles BigInt lowering would not be caught (it cannot compile BigInt anyway — rejected).
4. **Sparse arrays, getter side effects, evaluation order under objects** are untested: no array/object lowering exists.
5. **Exception behavior is not diffed.** Handler behaviour is tested with hand-authored bytecode (`operators.test.js`, `program.test.js`); no compiled `try`/`catch` exists to compare against native.
6. **Only one Node major.** `console`-observable output comparison across Node 20/22 is not performed.
7. **No optimization on/off differential.** Spec §19.1 item 4 requires repeating with optimization disabled and enabled; there is no optimizer, so the requirement is unmet by absence rather than by agreement.
8. **Harness trusts native evaluation for the *value*, not for *side effects*.** No stdout capture or module-export comparison, which §19.1 item 3 requires.

## 6. Verdict

Coverage is **broad but shallow in the dimension that matters for Gate 2**: 376 passing tests concentrate on encoding, verification, dispatch, scope analysis and one arithmetic operator family. Differential coverage — the only mechanism that can prove semantic equivalence — exists for **one** feature family. Gate 2 fails on feature absence first and coverage second.
