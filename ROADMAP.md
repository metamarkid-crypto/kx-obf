# KX-OBH v1.0 — Implementation Roadmap

Sumber kontrak: `KX-OBH_Technical_Specification_v1.0.md` (v1.0.0, 6 Nov 2026).
Standar kualitas: correctness dulu, security engineering kedua, obfuscation ketiga, performance terakhir.

## Prinsip eksekusi

- 8 fase, tiap fase punya **gate** yang harus lulus sebelum lanjut.
- Verifikasi dengan test, bukan dengan "file tergenerate".
- Jujur: fase yang belum lulus gate **tidak** di-mark complete.
- Setiap opcode terimplementasi wajib punya unit test. Setiap fitur bahasa wajib punya differential test vs Node native.
- Kunci embedded = obfuscation material yang recoverable, bukan secret.

## Fase & gate

### Phase 0 — Repo & kontrak
Deliver: skeleton repo, TS config, parser adapter, node-target config, error catalog, SPEC.md, traceability matrix, CI.
- [x] Baca spec lengkap & directive
- [x] Resolusi open decisions → DECISIONS.md
- [x] Scaffold repo `kx-obh/` (TS, tsconfig, package.json, lint/test scripts)
- [x] Parser adapter (acorn@8.19.0 pinned) + versi pinned
- [x] `config/node-targets.json` (declared vs tested dipisah jujur)
- [x] `src/diagnostics/errors.ts` — katalog error stabil
- [x] `TRACEABILITY.md` — matriks MUST → modul + test
- [x] CI script (`scripts/ci.sh`)
- **Gate:** LULUS — `npm ci` dari lockfile, typecheck, build, 189 test, smoke CLI `doctor`/`version` di Node 24.15.0.

### Phase 1 — Parser, AST validator, syntax diagnostics
Deliver: parser integration, AST normalization, scope analysis, supported-syntax validator, diagnostics actionable.
- **Gate:** fixture terklasifikasi benar (support/reject) + 0 codegen.

### Phase 2 — Bytecode ABI & VM skeleton
Deliver: opcode catalog canonical, 12-byte instr codec, function/constant table format, frame model, verifier, unit-test per opcode.
- [x] Opcode catalog canonical (id kontigu, mnemonic unik, reserved ditolak verifier)
- [x] 12-byte instruction codec + test offset/LE/signed-imm32/sentinel
- [x] Function, constant, exception table codec
- [x] Frame model + closure cells mutable
- [x] Verifier statis: register, call window, constant/import index, branch target, exception range & catch slot
- [x] VM limits (`resolveLimits`/`enforceLimit`) + test
- [x] Execution test untuk **setiap** opcode non-reserved (gate coverage dua arah)
- **Gate:** LULUS — 5 program hand-authored berjalan benar; 189 test hijau.
- Catatan jujur: VM saat ini mengimplementasikan subset opcode yang dipakai Phase 2; opcode katalog yang belum dieksekusi dijaga sebagai reserved dan ditolak verifier, bukan dijalankan best-effort.

### Phase 3 — Compiler subset
Deliver: literal, deklarasi, ekspresi/operator, fungsi/closure/call, cabang/loop, array/object, exception, differential test.
- [x] Emitter slice 1: satu fungsi tanpa parameter, deklarasi (initialiser saja) + `return <aritmetika>`
- [x] `- * / % **`, unary `+`/`-`, literal int32 vs pool, `null` → `+0`
- [x] `+` → `ADD` hanya lewat bukti `provesNumber` (rekursif, jadi `(1 + 2) + 3` terbukti); sisanya ditolak dengan posisi + feature + action
- [x] Budget register di-clamp ke `maxRegisters` VM; peak pressure dihitung allocator, bukan ditebak
- [x] Differential test vs Node native + kontrol negatif ADD→SUB
- [x] Binding di-lower ke frame slot: baca `LOAD_LOCAL`, tulis (assignment/compound/prefix `++`/`--`) `STORE_LOCAL`; `let`/`const` yang dibaca sebelum initialiser sendiri (TDZ) ditolak berposisi; tulis ke `const` ditolak; redeklarasi nama ditolak
- [x] Differential test total **71 CASES** (aritmetika + binding/assignment/update), 5 bentuk unproven `+`, 4 program wajib-ditolak, 2 kontrol opcode; 374 test hijau, `dist` di-rebuild, smoke CLI `doctor`/`version` OK
- **Gate:** differential test lulus untuk subset. **Belum lulus penuh** — slice, bukan seluruh subset: call/member, cabang/loop, array/object, exception belum di-codegen; postfix `x++` yang memakai nilai lama ditolak.
- Kandidat slice berikut: `ToPrimitive`/string concat + operan non-Number supaya `+` tak perlu bukti dan `+=` bisa menerima string; lalu parameter (`LOAD_PARAM`/`STORE_PARAM`) dan prologue scope penuh.

### Phase 4 — Async & CommonJS host bridge
Deliver: async/await state machine, Promise propagation, CJS wrapper, capability/import table, allowlist.
- **Gate:** fixture async & module lulus.

### Phase 5 — Binary package & crypto
Deliver: header 64B + entri direktori 32B, Brotli, AES-GCM per-section, embedded per-build key, Ed25519 opsional, verifier non-eksekusi.
- **Gate:** test tamper & parser-boundary lulus.

### Phase 6 — Single-file runtime loader
Deliver: runtime template, embedded package generator, loader verify/decrypt/decompress, VM startup, CJS export, post-build verify.
- **Gate:** artifact jalan di direktori bersih tanpa source/key terpisah.

### Phase 7 — Diversifikasi & profil
Deliver: per-build opcode remap, transform constant/string, lazy decode, safe instruction fusion, profil balanced/advanced/maximum.
- **Gate:** semua profil lolos suite semantik & integritas sama.

### Phase 8 — Hardening, fuzzing, release
Deliver: fuzz harness, compatibility matrix, benchmark, lisensi dependency, security docs, contoh, README penuh.
- **Gate:** semua mandatory acceptance criteria lulus.

## Open decisions → DECISIONS.md

Lihat `DECISIONS.md` untuk tiap resolusi (nilai, rationale, owner, tanggal).

---

### Status terkini
- Fase selesai (gate lulus): **Phase 0**, **Phase 1**, **Phase 2** (gate diperkuat 2026-11-07: branch offset relatif + throw-sebagai-completion; 247 test hijau)
- Fase aktif: **Phase 3** (compiler subset) — `src/compiler/` kini punya `emitter.ts`, `regalloc.ts`, `build.ts`, `index.ts`: satu fungsi tanpa parameter, deklarasi + `return <aritmetika>`, `+` hanya bila terbukti Number. Binding kini di-lower ke frame slot (DECISIONS #26): baca `LOAD_LOCAL`, tulis `STORE_LOCAL`, TDZ/const-write/redeklarasi ditolak berposisi (DECISIONS #27). Gate differential test lulus **untuk slice ini** (374 test hijau, smoke CLI OK; `npm ci` tidak dijalankan ulang — node_modules dijaga offline), tapi gate Phase 3 secara keseluruhan belum: call/member, cabang/loop, array/object, exception belum di-codegen.
- Dilaporkan jujur per akhir turn; tidak ada klaim selesai tanpa gate lulus.
