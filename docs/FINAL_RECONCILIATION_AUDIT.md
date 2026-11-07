# KX-OBH v1.0 — Final Reconciliation Audit

Audit mode: **READ-ONLY**. No implementation code was changed. No tests were added, removed, or weakened.
Only files created during this audit are the audit deliverables themselves (`docs/*.md`, `REQUIREMENT_TRACEABILITY.md`).

Audit date: 2026-11-07. Authority scope: evidence collection and documentation only. Phase 4 is **NOT** authorized by this document.

---

## 0. Audit scope, sources of truth, and repository identity

The CTO directive names paths such as `src/package.ts`, `src/opcode-catalog.ts`, `src/compiler.ts`, `src/vm.ts`, `docs/PACKAGE_FORMAT.md`. Those paths do **not exist** in this repository. The actual layout differs. This mismatch is itself an audit finding and is documented below rather than silently reconciled.

| Directive expects | Actual repository | Note |
|---|---|---|
| `src/package.ts` | does not exist | No package implementation exists in any form |
| `src/bytecode/opcode-catalog.ts` | `src/bytecode/opcodes.ts` | Same role, different filename |
| `src/bytecode/instruction-schema.ts` | `src/bytecode/instruction.ts` | Same role, different filename |
| `src/compiler.ts` | `src/compiler/index.ts` | Directory module, not a single file |
| `src/runtime.ts` | does not exist | Execution lives in `src/vm/program.ts`, `src/vm/interpreter.ts`, `src/vm/dispatch.ts` |
| `src/vm.ts` | does not exist | See above |
| `src/opcode.ts` | `src/bytecode/opcodes.ts` | See above |
| `docs/PACKAGE_FORMAT.md` | does not exist | `docs/` did not exist before this audit |

### Git metadata — UNAVAILABLE (findings G1)

The working directory is **not a Git repository**:

```
$ git log --oneline -5
fatal: not a git repository (or any of the parent directories): .git
$ git status --short
fatal: not a git repository (or any of the parent directories): .git
$ git diff --stat
fatal: not a git repository (or any of the parent directories): .git
```

Consequences, stated plainly:

- **No commit hash can be reported.** Any commit hash in a prior report was not verifiable from this checkout.
- **No working-tree status can be reported.** The "no uncommitted changes" claim in any prior report cannot be confirmed here.
- **No `git diff --stat` can be reported.**
- The KX-OBH spec §3.1 requires a versioned repository. A Phase 0 repository-contract deliverable is therefore not provable.

Recommendation (corrective work, not performed now): initialize version control and record a baseline commit **before** any Phase 4 work, so the next audit can diff against a real tree.

#### Addendum — 2026-11-07, later the same day: G1 RESOLVED

The recommendation above was carried out. The text in this section is preserved
as written because it accurately describes the state during the audit run; it is
no longer the current state.

```
$ git rev-parse 4e8acf5   -> 4e8acf5788987836779a354e82890d9cd9a8775f
$ git remote -v           -> origin https://github.com/metamarkid-crypto/kx-obf.git (main)
```

- **Baseline commit:** `4e8acf5` — 58 tracked files, source + tests + spec + docs + config.
- **Pushed to:** `https://github.com/metamarkid-crypto/kx-obf.git`, branch `main`.
- **Diff point for the next audit:** `git diff 4e8acf5..HEAD`.
- **`node_modules/` and `dist/` are ignored** ([.gitignore](kxobh/kx-obh/.gitignore)). Verified from a clean clone: `npm ci && npm run build && npm test` → `tests 376 / pass 376 / fail 0`. Running `npm test` immediately after `npm ci`, without a build, fails with `Cannot find module '../../dist/...'` — so a clean checkout must build first.

This changes no other finding in this document. Gates 2, 3 and 4 remain FAIL.

### Repository file tree (excluding `node_modules`, `dist`, `docs`)

Actual tree, verified by enumeration on 2026-11-07:

```text
kx-obh/
├── DECISIONS.md
├── ROADMAP.md
├── SPEC.md                        (spec v1.0 verbatim, 1420 lines)
├── TRACEABILITY.md
├── config/node-targets.json
├── config/node-targets.schema.json
├── package.json
├── package-lock.json
├── scripts/ci.sh
├── scripts/clean.mjs
├── tsconfig.json
├── src/
│   ├── bytecode/{constants,exceptions,functions,instruction,opcodes,verifier}.ts
│   ├── cli/main.ts
│   ├── compiler/{build,emitter,index,regalloc,scope,support}.ts
│   ├── config/node-targets.ts
│   ├── diagnostics/errors.ts
│   ├── index.ts
│   ├── parser/adapter.ts
│   └── vm/{dispatch,frame,interpreter,limits,operations,program}.ts
└── test/
    ├── bytecode/{functions,instruction}.test.js
    ├── cli/cli.test.js
    ├── compiler/{emitter,regalloc,scope,support}.test.js
    ├── config/node-targets.test.js
    ├── diagnostics/errors.test.js
    ├── diff/arithmetic.test.js
    ├── parser/adapter.test.js
    └── vm/{coverage,limits,opcodes,operators,program}.test.js
```

Note the **absence** of `src/crypto/`, `src/package*/`, `src/loader*/`, `src/host*/`, `src/capability*/`. Every Phase 5/6 component is absent from the source tree. The repository's own `ROADMAP.md` and `TRACEABILITY.md` already record this; see finding C4.

---

## 1. Executive finding on the prior report

The CTO directive asks me not to assume the previous completion report is correct. The strongest available evidence on that point is this: **no prior stabilization report exists in this repository**. A filesystem search for the six named deliverable files returns nothing; the only tracking documents are `ROADMAP.md`, `TRACEABILITY.md`, and `DECISIONS.md`, all of which describe Phase 5 as not started.

The specific claims quoted in the directive ("Phase A–H completed", "41/41 tests passed", "all four acceptance gates passed", "Phase 3 compiler and Phase 5 package are stable", `SIG_FOOTER_SIZE = 96`) are therefore **unverifiable from this repository and contradicted by direct measurement** where measurement is possible:

| Prior claim (as quoted by CTO) | Measured reality | Verdict |
|---|---|---|
| `SIG_FOOTER_SIZE = 96` | No package implementation, no signature code, no footer constant exists anywhere in the repository | **Unsubstantiated** — see Audit A |
| 41/41 tests passed | 376 tests, 376 pass, 0 fail | **Contradicted by measurement** — the count is 376, not 41 |
| Phase 3 compiler stable | Compiler accepts exactly one function shape; ~14 of 78 opcodes reachable from source | **Contradicted** — see Audit B |
| Phase 5 package stable | No `src/crypto/`, no package writer/reader, no signing, CLI `build`/`verify`/`inspect`/`keygen` all return not-implemented | **Contradicted** — see Audit E |
| Phase A–H completed | No phasing artifacts for A–H exist in the repo | **Unverifiable** |

I could not locate the previous report to audit it against its own text. That limitation is reported rather than filled with an invented summary.

---

## 2. Critical discrepancies (numbered, referenced)

### C1 — Package/signature footer: 96 bytes does not exist; the spec demands 80

Detail in `docs/PACKAGE_CONFORMANCE_AUDIT.md`. Summary:

- Spec §12.5 requires, when the signed flag is set, an appended footer of **exactly 80 bytes**: `magic[8]` (`KXSGv1\0\0`), `keyId[8]`, `signature[64]`.
- No SIG_FOOTER_SIZE constant exists in any source file. The only value matching the "signature footer" requirement in the repository is in `TRACEABILITY.md` line 74, which says "Footer signature 80B + SHA256(packageBeforeFooter)" and is marked `[ ]` (not done).
- The 96-byte claim in the prior report cannot be attributed to any code in this repository. **No justification for 96 bytes is offered, and none should be invented**: there is no implementation to justify. Spec §12.5 remains the normative 80-byte layout.

### C2 — 41 tests vs. 376 tests

Direct measurement, repeated per file and in aggregate: 16 test files, **376 tests, 376 pass, 0 fail** on Node v24.15.0. Full breakdown in `docs/TEST_COVERAGE_AUDIT.md`. The prior report's "41/41" is not reproducible; it matches no file, subset, or aggregate available now.

### C3 — Directory / path mismatch between the directive and the repo

Section 0 table. Every implementation path the directive names either does not exist or has a different name. This indicates the directive was written against a different document set or a different checkout. Any "source reference" in the prior report using those paths should be treated as unverified.

### C4 — Phase 3 declared incomplete by the repository's own documents, despite any prior "stable" claim

`ROADMAP.md` and `TRACEABILITY.md` mark Phase 5 as not started and Phase 3 as a partial slice. In other words, the repository's honest state disagrees with the prior report's "Phases 3 and 5 stable" claim. This is a reporting-accuracy problem, not a code problem.

### C5 — No version control

Section 0/G1. Reproducibility and change auditing are impossible without it.

**Addendum 2026-11-07: RESOLVED.** Baseline `4e8acf5` pushed to `origin/main`; reproducibility and change auditing are now possible via `git diff 4e8acf5..HEAD`. See the addendum in Section 1.

### C6 — Node 20 / 22 compatibility not tested

`config/node-targets.json` declares `[20, 22, 24]` but `testedOnHost: [24]`. The notes field states the policy explicitly: only `testedOnHost` majors may be claimed as tested. No CI matrix executed. Detail in `docs/TEST_COVERAGE_AUDIT.md` §4.

---

## 3. Confirmed implementations (what is genuinely built and verified)

These items are verified by direct inspection **and** by executed tests in this session:

1. **12-byte fixed instruction codec, little-endian** — `src/bytecode/instruction.ts` (INSTRUCTION_SIZE 12; opcode u8, flags u8, dst u16LE, a u16LE, b u16LE, imm32 i32LE; `encodeInstruction`/`decodeInstruction` at lines ~74–125). Matches spec §9.2 byte-for-byte.
2. **Canonical opcode catalog** — `src/bytecode/opcodes.ts`: 78 entries, IDs append-only, `RESERVED_OPCODE_IDS` holds 4 opcodes the verifier rejects until their phase lands (74 implemented).
3. **Verifier runs before execution** — program assembly verifies; a program that reaches the VM was verified (`src/compiler/index.ts` `compileSource` docs; `src/vm/program.ts`).
4. **Single VM dispatch implementation** — one `dispatchImpl` in `src/vm/dispatch.ts`, installed into the interpreter once, with a "used before dispatch.ts was loaded" trap. No second dispatch path exists.
5. **Frame model with separated slot and register spaces** — `src/vm/frame.ts`: `registers` sized to `registerCount`; `slots` separate; `EnvironmentCell` boxing for closure captures per spec §9.5.
6. **Parser adapter** — acorn, ESTree Program out, permissive-by-design with semantic classification in `src/compiler/support.ts` (`KXOBH-E-COMPILER-UNSUPPORTED` with position/feature/action).
7. **Scope analysis** — `src/compiler/scope.ts`: var hoisting to function scope, let/const block scope with TDZ, function/block/catch scopes, strict-mode detection, free identifiers.
8. **Compiler slice** — one parameterless function; numeric literal/arithmetic expressions; `var`/`let`/`const` declarations with two-pass slot publishing; assignment, compound assignment, prefix `++`/`--` to declared bindings; TDZ/const-write/redeclaration rejected as positioned build errors.
9. **Differential arithmetic testing vs. native Node** — `test/diff/arithmetic.test.js`: 11 tests over **80 numeric source fixtures**, each compiled to bytecode and compared against `new Function()` evaluation of the same text with `assert.deepStrictEqual`, so `NaN`, `-0`, `±Infinity` and bit patterns must agree exactly.
10. **Public CLI** — `doctor`, `version` work; `build`, `verify`, `inspect`, `keygen` return a documented not-implemented result with a phase tag instead of lying.
11. **No source leakage in artifacts** — no `.map` files, no `sourceMappingURL`, no `fs`/`readFile` in `dist/`, no embedded key material, no plaintext source fallback. (Phase 5/6 have nothing to leak *yet*; the property is confirmed for the current artifacts, not promised for future ones.)

---

## 4. Missing functionality (Phase 3 incomplete — Gate 2 FAILS)

Full matrix with emitted opcodes and test coverage: `docs/COMPILER_SUPPORT_MATRIX.md`.

Every Phase 3 deliverable from spec lines 1181–1192 is missing except "literals, variable declarations, expressions and operators (numeric subset)".

| Phase 3 deliverable | Status |
|---|---|
| Literals | PARTIALLY_IMPLEMENTED (numbers and `null` only; strings/booleans/bigint/regexp rejected) |
| Variable declarations | PARTIALLY_IMPLEMENTED (single function frame, no params, one shape of body) |
| Expressions and operators | PARTIALLY_IMPLEMENTED (numeric arithmetic + numeric unary only; no logical/comparison/bitwise/conditional/sequence/member/call) |
| **Functions, closures, calls, returns** | **NOT_IMPLEMENTED** (only the analytical one-function entry; no params, no nested functions, no CREATE_CLOSURE lowering, no CALL lowering) |
| **Branches and loops** | **NOT_IMPLEMENTED** |
| **Arrays and objects** | **NOT_IMPLEMENTED** |
| **Exceptions** | **NOT_IMPLEMENTED** |

`unsupported()` in `src/compiler/emitter.ts` (lines ~330–336) rejects any other AST node type at a real position; `singleFunctionOf` in `src/compiler/index.ts` rejects any program that is not exactly one function declaration. Nothing silently degrades — which is correct behavior, but it is not completion.

---

## 5. Acceptance gates

Evidence in `docs/VM_ABI_AUDIT.md`, `docs/PACKAGE_CONFORMANCE_AUDIT.md`, `docs/TEST_COVERAGE_AUDIT.md`, `docs/SECURITY_LIMITATIONS.md`.

| Gate | Result | Basis |
|---|---|---|
| Gate 1 — VM ABI | **CONDITIONAL PASS** | Encoding, catalog, verifier, single dispatch, register validation, flag validation, instruction-boundary checks all verified. Not a full pass: no opcode-remapping section validation (Phase 7), and reserved opcodes exist; "every opcode tested" holds only for implemented ones. |
| Gate 2 — Compiler correctness | **FAIL** | Phase 3 incomplete (Section 4). Differential coverage exists only for numeric arithmetic. |
| Gate 3 — Package conformance | **FAIL** | No package implementation exists. Spec §12.5 80-byte footer unimplemented; no tamper, parser-boundary, or crypto tests can exist. |
| Gate 4 — Build reproducibility | **FAIL** | No Git. Only Node 24 executed. No CI run. Stale-artifact risk mitigated by a fresh `tsc` build this session, but a clean-from-lockfile run (`npm ci`) was not performed. |

---

## 6. Stop condition

This audit ends here. Phase 4 is not started and not authorized. No completion is declared. Corrective work awaits CTO review; suggested items are listed in `REQUIREMENT_TRACEABILITY.md` §7 and the final report.
