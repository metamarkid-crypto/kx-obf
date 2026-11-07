# TRACEABILITY.md — KX-OBH v1.0

Matriks MUST requirement (Spec §0–§24) → modul → test. Baris hanya dianggap selesai bila test lulus. Kolom "Status" diisi per fase; `[ ]` = belum.

## Fase 0 — kontrak

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §4.2 | Parser nyata, bukan regex | `src/parser/adapter.ts` | `test/parser/adapter.test.js` | [x] |
| §4.4 | Node target config (declared vs tested) | `src/config/node-targets.ts` | `test/config/node-targets.test.js` | [x] |
| Appendix A | Katalog error stabil + exit code | `src/diagnostics/errors.ts` | `test/diagnostics/errors.test.js` | [x] |
| §3.3 | CLI surface, exit code stabil, tidak ada command palsu | `src/cli/main.ts` | `test/cli/cli.test.js` | [x] |
| §3.1 | Modul terpisah (compiler/vm/bytecode/diagnostics/cli) | `src/*` | `npm run typecheck` (strict) | [x] |
| §3.1 | Modul `package`/`crypto`/`loader` sebagai direktori terpisah | — | — | [ ] |
| §5.1 | Tidak ada fallback plaintext | (ditegakkan di Phase 5/6) | `test/leak/*` | [ ] |
| §21.1.3 | Traceability checklist | file ini | — | [x] |
| §15 | Instal dari lockfile; lockfile di-commit | `package-lock.json` | CI | [x] |

## Fase 1 — parser/AST/scope

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §8.1 | Subset v1.0 diterima | `src/compiler/support.ts` | `test/compiler/support.test.js` | [x] |
| §8.2 | Syntax unsupported ditolak dengan file:line:col+feature+action | `src/compiler/support.ts` | `test/compiler/support.test.js` | [x] |
| §8.3 | Scope analysis, TDZ, hoisting, closure capture | `src/compiler/scope.ts` | `test/compiler/scope.test.js` | [x] |
| §21.1.16 | Feature tak didukung punya test rejection | `test/compiler/support.test.js` | — | [x] |
| §4.2 | Parser permissif agar validator, bukan parser, yang menolak | `src/parser/adapter.ts` | `test/parser/adapter.test.js` | [x] |

## Fase 2 — ABI bytecode + VM

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §9.2 | Instruksi fixed 12-byte LE | `src/bytecode/instruction.ts` | `test/bytecode/instruction.test.js` | [x] |
| §9.3 | Catalog opcode canonical (unik, kontigu, append-only, reserved ditolak) | `src/bytecode/opcodes.ts` | `test/bytecode/opcodes.test.js`, `test/vm/coverage.test.js` | [x] |
| §9.4 | Calling convention stabil (CALL/CALL_METHOD/CALL_CAPABILITY/CONSTRUCT) | `src/vm/dispatch.ts` | `test/vm/opcodes.test.js` | [x] |
| §9.5 | Closure + environment cells mutable | `src/vm/dispatch.ts` | `test/vm/opcodes.test.js`, `test/vm/program.test.js` | [x] |
| §10.1 | Verifier statis penuh | `src/bytecode/verifier.ts` | `test/vm/coverage.test.js` | [x] |
| §9.7 | VM limits terkonfigurasi | `src/vm/limits.ts` | `test/vm/limits.test.js` | [x] |
| §12.2 | Function table + constant pool codec | `src/bytecode/functions.ts`, `src/bytecode/constants.ts` | `test/bytecode/functions.test.js` | [x] |
| §9.3 | Exception table codec | `src/bytecode/exceptions.ts` | `test/bytecode/functions.test.js` | [x] |
| §19.3 | Setiap opcode terimplementasi punya execution test | `src/vm/` | `test/vm/opcodes.test.js` | [x] |

## Fase 3 — compiler subset

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §8.1 | Semua fitur subset di-compile | `src/compiler/emitter.ts` | `test/compiler/emitter.test.js` | [ ] — slice: satu fungsi tanpa parameter, body deklarasi + `return <ekspresi>`; operator `- * / % **` dan `+` (hanya bila terbukti Number, DECISIONS #22), literal number/`null`, unary `+`/`-`, binding (baca `LOAD_LOCAL`, tulis `STORE_LOCAL` — DECISIONS #26), assignment/compound/prefix update, TDZ & const-write & redeklarasi ditolak berposisi (#27). Belum: statement lain selain deklarasi/ekspresi, parameter, closure, call/member, postfix yang memakai nilai lama |
| §19.1 | Differential test vs Node native | `test/diff/arithmetic.test.js` | `test/diff/arithmetic.test.js` | [x] untuk slice (71 CASES: aritmetika, `-0`, `NaN`, `±Infinity`, batas int32, overflow, `null`, `+` terbukti, binding read/assignment/compound/prefix-update, `var` tanpa init; 5 bentuk unproven `+`; 4 program wajib-ditolak) |
| §8.2 | `+` tak terbukti ditolak, bukan diturunkan asal | `src/compiler/emitter.ts` (`provesNumber`) | `test/diff/arithmetic.test.js`, `test/compiler/emitter.test.js` | [x] — 6 bentuk unproven (`"1" + 2`, `true + 1`, binding, call, bigint, `+x`) ditolak dengan feature + action; kontrol negatif ADD→SUB tertangkap |
| §8.3 | Semantik: coercion, short-circuit, TDZ, finally | `src/compiler/` | `test/compiler/semantics.test.js` | [ ] — ToNumber/`null` benar; TDZ & const-write ditolak saat build (#27); string concat, short-circuit, finally belum |
| §9.1 | Tidak ada aliasing register | `src/compiler/regalloc.ts`, `src/compiler/emitter.ts` | `test/compiler/regalloc.test.js`, `test/compiler/emitter.test.js` | [x] — setiap operand `< registerCount`; budget di-clamp ke `maxRegisters` VM (DECISIONS #25) |

## Fase 4 — async + CJS bridge

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §9.6 | Async/await state machine non-blocking | `src/vm/async.ts` | `test/vm/async.test.js` | [ ] |
| §11.1 | Capability table | `src/host/capability.ts` | `test/host/capability.test.js` | [ ] |
| §11.2 | Default: tidak ada eval/Function/require dinamis | `src/host/defaults.ts` | `test/host/defaults.test.js` | [ ] |
| §7.1 | CommonJS wrapper + cache + exports | `src/host/cjs.ts` | `test/host/cjs.test.js` | [ ] |

## Fase 5 — binary package + crypto

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §12.2 | Header 64B | `src/package/header.ts` | `test/package/header.test.js` | [ ] |
| §12.3 | Entri direktori 32B | `src/package/directory.ts` | `test/package/directory.test.js` | [ ] |
| §12.4 | Jenis section + flag | `src/package/section.ts` | `test/package/section.test.js` | [ ] |
| §12.6 | Verifier non-eksekusi + bounds-safe | `src/package/parser.ts` | `test/package/parser.test.js` | [ ] |
| §13.1 | SHA-256, AES-256-GCM, HKDF, Ed25519, randomBytes | `src/crypto/` | `test/crypto/*` | [ ] |
| §13.2 | Per-build master key + derivasi per-section | `src/crypto/keygen.ts` | `test/crypto/keygen.test.js` | [ ] |
| §13.4 | GCM dulu, baru decompress | `src/package/open.ts` | `test/package/open.test.js` | [ ] |
| §13.5 | Brotli/none per section + limit output | `src/package/compress.ts` | `test/package/compress.test.js` | [ ] |
| §12.5 | Footer signature 80B + SHA256(packageBeforeFooter) | `src/crypto/sign.ts` | `test/crypto/sign.test.js` | [ ] |

## Fase 6 — single-file loader

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §3.2 | Satu artefak `.js` self-contained | `src/loader/template.ts` | `test/loader/artifact.test.js` | [ ] |
| §14 | Loader: parse → verify → decrypt → decompress → VM → exports | `src/loader/` | `test/loader/*` | [ ] |
| §13.1 | Tanpa external runtime key | `src/loader/` | `test/loader/no-external-key.test.js` | [ ] |
| §1.2 | Tanpa plaintext fallback | `src/loader/` | `test/leak/no-fallback.test.js` | [ ] |

## Fase 7 — diversifikasi

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §9.2 | Per-build opcode remap | `src/diversify/opmap.ts` | `test/diversify/opmap.test.js` | [ ] |
| §15 | Profil balanced/advanced/maximum lolos suite sama | `src/diversify/profiles.ts` | `test/diversify/profiles.test.js` | [ ] |
| §10.3 | Tanpa junk code | (design: no junk) | `test/leak/no-junk.test.js` | [ ] |

## Fase 8 — hardening/release

| Spec MUST | Syarat | Modul | Test | Status |
|---|---|---|---|---|
| §19.6 | Fuzz parser & verifier | `test/fuzz/*` | — | [ ] |
| §4.4 | Matriks Node target teruji | CI | — | [ ] |
| §19.7 | Benchmark (size/startup/throughput/memory/build) | `bench/` | — | [ ] |
| §19.5 | Source-leakage scan | `src/leak/scan.ts` | `test/leak/scan.test.js` | [ ] |
| §4.3 | Dependency license inventory | `LICENSES.md` | — | [ ] |
| Appendix C | Release checklist | `CHECKLIST.md` | — | [ ] |
