# REQUIREMENT TRACEABILITY — KX-OBH v1.0

Normative source: `SPEC.md` (Technical Specification v1.0, 1420 lines, verbatim in repo).
Audit mode: READ-ONLY. No implementation file was modified.

## 0. Provenance

```
$ git rev-parse 4e8acf5   -> 4e8acf5788987836779a354e82890d9cd9a8775f
$ git log --oneline -2    -> <recording commit> Record audit baseline hash
                             4e8acf5 Baseline: initial repo state for KX-OBH v1.0 audit
$ git remote -v           -> origin https://github.com/metamarkid-crypto/kx-obf.git (main)
```

- **Baseline commit:** `4e8acf5788987836779a354e82890d9cd9a8775f` (branch `main`)
- **Remote:** `https://github.com/metamarkid-crypto/kx-obf.git` — pushed
- **Commit message:** `Baseline: initial repo state for KX-OBH v1.0 audit`
- **Diff point:** `git diff 4e8acf5..HEAD` pada audit berikutnya.

### Struktur dua commit

Baseline `4e8acf5` merekam **seluruh isi repo** (source, test, spec, docs, config).
Hash-nya dicatat di dokumen ini pada commit **anaknya**, karena satu commit tidak
bisa memuat hash-nya sendiri. Konsekuensinya: `git diff 4e8acf5..HEAD` pada audit
berikutnya akan selalu memuat satu perubahan dokumentasi ini saja di awal —
sesudah itu murni perubahan kode.

### Apa yang sengaja TIDAK di-track

`node_modules/` dan `dist/` ada di `.gitignore` (lihat [.gitignore](kxobh/kx-obh/.gitignore)).
Keduanya artefak turunan: `dist/` dihasilkan `npm run build`, `node_modules/` oleh
`npm ci` dari `package-lock.json` yang **di-commit**. Kalau ikut di-track, setiap
instalasi akan tampak seperti perubahan source dan diff audit jadi tidak terbaca.
Akibatnya: clone bersih **wajib** menjalankan `npm ci && npm run build` sebelum
`npm test`, karena test meng-`require` dari `dist/`.

Resolves discrepancy D6 (process gap): repo kini version-controlled dengan baseline yang bisa di-diff.

## 1. Environment and executed checks

| Item | Value |
|---|---|
| Node | v24.15.0 |
| npm | 11.12.1 |
| TypeScript | 7.0.2 (devDependency) |
| acorn | 8.19.0 |
| `npm run build` | exit **0** |
| `npm run typecheck` | exit **0** |
| `npm test` | exit **0** — `tests 376 / pass 376 / fail 0` |
| Source newer than dist | 0 files (artifacts fresh for this run) |

## 2. Phase traceability

| Phase | Spec deliverable (`SPEC.md`) | Implemented? | Evidence |
|---|---|---|---|
| 0 — Foundation | repo/contract, versioning, limits | PARTIAL | `config/node-targets.json`, `limits.test.js`, git baseline `4e8acf5`; no Phase 0 contract doc |
| 1 — VM ABI | 12-byte encoding, catalog, verifier | YES (impl.) / CONDITIONAL | `instruction.ts`, `opcodes.ts`, `verifier.ts`, `coverage.test.js` |
| 2 — VM execution | dispatch for all opcodes, frames, closures, exceptions | YES (impl.) | `dispatch.ts` (519 lines), `frame.ts`, `opcodes.test.js` executes all 74 non-reserved |
| 3 — Compiler subset | literals, vars, expressions, **functions/closures/calls/returns**, **branches/loops**, **arrays/objects**, **exceptions** | **PARTIAL — 1 of 6 groups** | `docs/COMPILER_SUPPORT_MATRIX.md` |
| 4 — Async + CommonJS bridge | async state machine, capability bridge | NOT STARTED (correctly — not authorized) | no `src/async*`, no host bridge |
| 5 — Package + crypto | header/dir/sections/footer/crypto | **NOT STARTED** | no `src/package*`, `src/crypto*` |
| 6 — Loader | runtime loader, embedded key | NOT STARTED | no `src/loader*` |
| 7 — Hardening | remapping validation, obfuscation | NOT STARTED | — |

## 3. Specification section → implementation map

| Spec § | Requirement | Implementation | Status |
|---|---|---|---|
| §9.2 | 12-byte instruction, LE | `src/bytecode/instruction.ts:21,108-113` | DONE |
| §9.3 | opcode catalog, append-only | `src/bytecode/opcodes.ts:78-209`, ids 1–78 | DONE |
| §9.3 | opcode remapping | `opmap` plumbing exists; no package permutation validation | PARTIAL |
| §9.4 | frames, register file, slots | `src/vm/frame.ts` | DONE |
| §9.5 | closure capture by shared cell | `EnvironmentCell`, `CREATE_CLOSURE` copy-by-reference | DONE (VM); no compiler lowering |
| §9.x | exception tables | `src/bytecode/exceptions.ts` | DONE (VM); no compiler lowering |
| §11.2-11.3 | capability restriction, sandbox caveat | `LOAD_GLOBAL_CAPABILITY`, `CALL_CAPABILITY` verified; no host bridge | PARTIAL |
| §12.2 | 64-byte header | — | **MISSING** |
| §12.3 | 32-byte directory entry | — | **MISSING** |
| §12.4 | section types 0x0001–0x0008 | — | **MISSING** |
| §12.5 | **80-byte signature footer** | — (`TRACEABILITY.md:74` `[ ]`) | **MISSING** |
| §12.6 | parser safety rules | — | **MISSING** |
| §13.1 | SHA-256 / AES-256-GCM / HKDF / Ed25519 / Brotli | — | **MISSING** |
| §13.2 | per-build key, AAD, info strings | — | **MISSING** |
| §13.3 | nonce rules | — | **MISSING** |
| §13.4 | decrypt order, auth before decompress | — | **MISSING** |
| §19.1 | differential semantic tests per feature | numeric arithmetic only (80 fixtures) | **PARTIAL** |
| §19.2 | compiler tests (parser, scope, hoist, TDZ, closures, control flow, regalloc, exception table, async, diagnostics) | scope/TDZ/regalloc/diagnostics done; closures, control flow, exception-table-lowering, async missing | PARTIAL |

## 4. Discrepancy register

| ID | Discrepancy | Class | Corrective owner |
|---|---|---|---|
| D1 | Reported `SIG_FOOTER_SIZE = 96`; spec mandates 80; **no implementation exists** | reporting error + missing feature | Phase 5 |
| D2 | Reported 41/41 tests; measured 376/376 | reporting error | doc fix |
| D3 | Reported Phase 3 & Phase 5 "stable"; Phase 3 is 1/6, Phase 5 absent | reporting error | Phase 3, then Phase 5 |
| D4 | Reported "all four gates passed"; measured 1 conditional + 3 fail | reporting error | gates re-evaluated |
| D5 | Directive paths (`src/package.ts`, `src/vm.ts`, `src/compiler.ts`, `docs/PACKAGE_FORMAT.md`) do not match repo layout | document set mismatch | CTO to reconcile which doc set is authoritative |
| D6 | No version control; no reproducible baseline | process gap | **RESOLVED** — baseline `4e8acf5788987836779a354e82890d9cd9a8775f` on `origin/main` |
| D7 | Node 20/22 declared but never executed | process gap | CI matrix |
| D8 | Phase 3 features attributed to Phase 4 in prior report | misattribution, explicitly rejected | Phase 3 scope restated |

## 5. Evidence commands (re-runnable verbatim)

```bash
cd kxobh/kx-obh
npm ci && npm run build          # wajib dulu: dist/ tidak di-track
git rev-parse 4e8acf5            # 4e8acf5788987836779a354e82890d9cd9a8775f (baseline)
git log --oneline -1 4e8acf5     # Baseline: initial repo state for KX-OBH v1.0 audit
git diff --stat 4e8acf5..HEAD    # apa yang berubah sejak baseline
ls src/package* src/crypto      # No such file or directory
grep -rn "SIG_FOOTER" --include=*.ts src/   # no match
grep -cE "^  spec\([0-9]+," src/bytecode/opcodes.ts   # 78
npm run build                   # exit 0
npm run typecheck               # exit 0
npm test                        # exit 0, tests 376 pass 376 fail 0
find dist -name '*.map' | wc -l # 0
find src -name '*.ts' -newer dist/compiler/emitter.js | wc -l  # 0 -> artifacts fresh
```

## 6. Repository file tree

```text
kx-obh/
├── DECISIONS.md  ROADMAP.md  SPEC.md  TRACEABILITY.md
├── config/{node-targets.json, node-targets.schema.json}
├── package.json  package-lock.json  tsconfig.json
├── scripts/{ci.sh, clean.mjs}
├── docs/{FINAL_RECONCILIATION_AUDIT, COMPILER_SUPPORT_MATRIX, VM_ABI_AUDIT,
│         PACKAGE_CONFORMANCE_AUDIT, TEST_COVERAGE_AUDIT, SECURITY_LIMITATIONS}.md
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

## 7. Recommended corrective work (awaiting CTO authorization — nothing started)

Priority order, each item independently reviewable:

1. **Version control baseline.** ~~`git init`, commit current tree, record the hash in this file. Without it no future audit can diff.~~ **DONE** — baseline `4e8acf5788987836779a354e82890d9cd9a8775f`, remote `metamarkid-crypto/kx-obf` branch `main`. Audit berikutnya: `git diff 4e8acf5..HEAD`.
2. **Correct the reporting record.** Retract 41/41, "four gates passed", and `SIG_FOOTER_SIZE = 96`; replace with the measured numbers in this audit.
3. **Complete Phase 3** in spec order: functions with parameters → calls → closures (capture lowering) → returns → `if`/loops → arrays/objects → try/catch/finally. Add differential tests per feature, per §19.1, including `undefined`, `NaN`, `-0`, BigInt, sparse arrays, evaluation order, exception behaviour, object property order.
4. **Then Phase 5** exactly per §12/§13, starting with the 80-byte footer and adversarial parser tests before adding any crypto.
5. **CI matrix** actually running Node 20/22/24, with `npm ci` + clean build, updating `testedOnHost` only from real runs.
6. **Only then** consider Phase 4 authorization.

## 8. Approval status

This document asserts **no approval**. Gate 1 is CONDITIONAL; Gates 2, 3, 4 FAIL. Phase 4 remains unauthorized. Awaiting CTO review.
