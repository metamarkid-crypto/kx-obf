# PACKAGE CONFORMANCE AUDIT — spec §12 / §13 vs. implementation

## Headline finding

**There is no package implementation in this repository.** Not partial, not stubbed with a wrong constant: absent.

```
$ ls src/package* src/crypto src/loader* src/host*
ls: cannot access 'src/package*': No such file or directory
ls: cannot access 'src/crypto': No such file or directory
ls: cannot access 'src/loader*': No such file or directory
ls: cannot access 'src/host*': No such file or directory
$ grep -rn "SIG_FOOTER\|ed25519\|Ed25519\|createCipheriv\|hkdf" --include=*.ts src/
(no matches)
```

The only `96` occurrences in `src/` are `maxParams: 4096` / `maxCaptures: 4096` in `src/bytecode/functions.ts:72,75` — unrelated field widths, not a footer.

Public CLI behaviour confirms it (`src/cli/main.ts`): `build`, `verify`, `inspect`, `keygen` each return a documented not-implemented result with a phase tag and a non-zero exit, rather than pretending success. Test: `test/cli/cli.test.js` — "unimplemented commands fail loudly instead of pretending success".

Therefore the directive's Audit A questions 1–8 cannot be answered from code, because the code does not exist. Answering them would require inventing a design. Below, each question is answered with what the repository actually contains.

## AUDIT A — footer discrepancy, question by question

**A1. Why is the implementation using 96 bytes?**
It is not. No `SIG_FOOTER_SIZE` symbol exists in `src/` or `dist/`. The claim `SIG_FOOTER_SIZE = 96` is **unsupported by this repository**. I will not construct a rationale for a format change that has no implementation and no approved amendment.

**A2. What is the exact 96-byte layout?**
No such layout exists. The only footer described anywhere in the repo is the spec's 80-byte one, and `TRACEABILITY.md:74` records it as **not done** (`[ ]`). See also §12.5 of `SPEC.md` (quoted below).

**A3. Is a public key or metadata stored in the footer?**
Spec §12.5 says no: the footer is `magic[8] + keyId[8] + signature[64]`. `keyId` is the first 8 bytes of `SHA-256(DER-SPKI public key)`; the public key itself is *not* in the footer. The spec also requires the loader-side public key to be documented as replaceable, i.e. not a hardware/OS-pinned trust anchor (`SPEC.md:733-735`). No implementation stores either.

**A4. How is keyId generated?**
Per spec: `keyId = SHA-256(DER-SPKI public key)[0..8)`. Not implemented.

**A5. How does the writer construct the footer?**
No writer exists.

**A6. How does the verifier parse and validate it?**
No package parser or footer verifier exists.

**A7. Difference between signing and unsigned packages?**
Per spec §12.2, header `flags` bit 0 = signed. When set, the 80-byte footer is appended and `total package length` includes it. When clear, no footer. Not implemented.

**A8. Does the implementation conform to Technical Specification v1.0?**
**Vacuously non-conforming**: there is no implementation to conform or not conform. This is *not* a conformance pass — a missing component cannot satisfy a gate. Gate 3 is FAIL, and the correct framing is "unimplemented", not "80 vs 96 discrepancy".

## Normative footer (spec §12.5, `SPEC.md:721-737`)

```text
If the signed flag is set, append exactly 80 bytes:

magic[8]      = ASCII "KXSGv1\0\0"
keyId[8]      = first 8 bytes of SHA-256(DER-SPKI public key)
signature[64] = Ed25519 signature

Signature input:
  UTF8("KXOBH-PACKAGE-SIGNATURE-v1\0") || SHA256(packageBytesBeforeSignatureFooter)
```

Byte-offset table (the layout any Phase 5 implementation must reproduce, and the one a 96-byte design would violate):

| Offset from footer start | Size | Field | Value / rule |
|---:|---:|---|---|
| 0 | 8 | magic | `4B 58 53 47 76 31 00 00` (`KXSGv1\0\0`) |
| 8 | 8 | keyId | `SHA-256(DER-SPKI pubkey)[0..8)` |
| 16 | 64 | signature | Ed25519 over the domain-separated digest |
| **80** | — | **total** | **footer ends; `total package length` accounts for these 80 bytes** |

A 96-byte variant would add 16 unexplained bytes — for example a stored public key or a second digest — and would break `total package length` arithmetic, the signature-input definition, and every existing 80-byte consumer. Nothing in the repository authorises that, so it is reported as an unsupported claim.

## AUDIT E — section-by-section conformance table

Legend: `PRESENT` = implemented and evidence exists · `ABSENT` = no implementation.

| Spec requirement | Section | Implementation | Evidence |
|---|---|---|---|
| 64-byte fixed header, magic `KXOBH1\r\n`, major 1 / minor 0 | §12.2 (`SPEC.md:663-692`) | **ABSENT** | no header codec |
| Header fields: flags/sectionCount/reserved/packageId/ABI/node range/dirOffset=64/dirLength=count*32/totalLength | §12.2 | **ABSENT** | — |
| Version-mismatch typed error; no implicit minor compatibility | §12.2 | **ABSENT** | — |
| 32-byte section directory entry, sortable by offset | §12.3 (`SPEC.md:694-712`) | **ABSENT** | — |
| Section data layout `nonce[12] || ciphertext || authTag[16]` | §12.3 | **ABSENT** | — |
| `plainLength` = pre-compression size; `ciphertext == plainLength` when uncompressed | §12.3 | **ABSENT** | — |
| Section types 0x0001–0x0008, required vs optional, unknown-required fails | §12.4 | **ABSENT** | — |
| **80-byte signature footer** | §12.5 | **ABSENT** | `TRACEABILITY.md:74` marked `[ ]` |
| Signature input = domain label ‖ SHA-256(pre-footer) | §12.5 | **ABSENT** | — |
| Ed25519 via `crypto.sign(null,…)` / `crypto.verify(null,…)` | §12.5 | **ABSENT** | — |
| Private key never serialized into output | §12.5 | **ABSENT** (nothing to leak yet) | no key material in `dist/` |
| Parser safety: size bounds, exact header, dir count/length, overflow-safe ranges, no overlap, sorted entries, max compressed/decompressed, dup-required rejection, flag consistency, trailing-byte rejection | §12.6 (`SPEC.md:739-756`) | **ABSENT** | — |
| SHA-256 via `node:crypto` | §13.1 | **ABSENT** | — |
| AES-256-GCM authenticated encryption | §13.1 | **ABSENT** | — |
| HKDF-SHA-256, IKM=master, salt=packageId, info=`KXOBH/v1/section/<type>` | §13.2 | **ABSENT** | — |
| AAD = header(64) ‖ dir entry(32), prefixed by `KXOBH-AEAD-v1\0` | §13.2 | **ABSENT** | — |
| Brotli via `node:zlib` | §13.1 | **ABSENT** | — |
| `crypto.randomBytes()` only, never `Math.random()` | §13.1 | **ABSENT** | — |
| 96-bit nonce, never reused per derived key, new master key per build, build fails if nonce gen fails | §13.3 | **ABSENT** | — |
| Decryption order: parse → validate → authenticate → decompress | §13.4 | **ABSENT** | — |
| Verification before execution | §13.4 / §12.6 | **ABSENT** (no package to verify) | bytecode-level verify *does* precede execution |

## Explicit anti-claim

Per the directive: I do **not** state that encryption, signing, or the footer are correct. There is no round-trip test to lean on and no ciphertext in the repository. A round-trip test, had it existed, would in any case prove only self-consistency between two functions written together — not conformance to `SPEC.md` §12/§13 field order, AAD construction, HKDF info string, or footer arithmetic.

## Gate 3 verdict

**FAIL.** Zero of the required package/format/crypto components exist. Prior claims of a "stable Phase 5 package" and of a 96-byte footer are unsubstantiated. Corrective scope for Phase 5 is:

1. Implement header/directory/section codecs exactly per §12.2–§12.4.
2. Implement the 80-byte footer per §12.5, with the exact signature-input domain label.
3. Implement HKDF + AES-256-GCM + Brotli per §13.2 with the exact AAD and info strings.
4. Implement parser safety per §12.6 with hard maximums from runtime config.
5. Add adversarial tests: truncated header, overlapping sections, duplicate required types, wrong AAD, flipped tag byte, reordered directory, trailing bytes, footer magic mismatch, keyId mismatch, wrong signature domain, and a real Ed25519 sign/verify pair.
