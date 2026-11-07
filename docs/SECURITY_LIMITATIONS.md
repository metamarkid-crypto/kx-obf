# SECURITY LIMITATIONS — confirmed vs. tested vs. assumed vs. known limits

The directive requires distinguishing four classes. I use exactly those four and no others.

## 1. Confirmed properties (verified by direct inspection of artifacts)

| Property | Evidence |
|---|---|
| No source maps in build output | `find dist -name '*.map'` → 0 |
| No `sourceMappingURL` anywhere in `dist/` | grep → no match |
| No embedded key material | grep for key/cipher/hkdf symbols in `src/` → no match |
| No plaintext-source fallback | `src/` contains no reader that falls back to reading original source; the only `readFileSync` in `dist/` is `dist/config/node-targets.js:58`, which reads the **config JSON**, not user source |
| Original source is not retained in artifacts | compiler emits bytecode sections only (`buildSections`); comments are captured by the parser *specifically so a test can assert their absence* (`test/parser/adapter.test.js`: "captures comments so the leakage test can assert their absence") |
| Private signing keys are not in output | no signing code exists; no `.pem`/`.key` files in the tree |
| Build metadata is minimal | `BUILD_INFO` section (spec 0x0008) is not emitted; package layer absent |
| Verification precedes execution | program assembly verifies before the VM runs; a program that reaches `dispatch.ts` was verified |
| Single dispatch path with a loud trap | `interpreter.ts:400` default throws `VM dispatch was used before dispatch.ts was loaded`; no duplicate `switch(opcode)` exists |
| Adversarial parser/verifier rejection | 21 malformed-bytecode rejections in `coverage.test.js`; parser size limit and deep-nesting guard in `support.test.js` |
| Errors never swallow their cause | `errors.test.js`: "toKxobhError preserves the original cause instead of swallowing it" |
| Limits are finite and cannot be silently disabled | `limits.test.js`: "defaults are finite positive integers so no limit is silently disabled" |

Note on scope: Phase 5 does not exist, so "no key leakage" is currently true because there is nothing to leak. It is a confirmed property *of the present artifact set*, not a guarantee about a future package format.

## 2. Tested properties (asserted by an executed test, with the test named)

| Property | Test |
|---|---|
| Malformed bytecode is rejected, not executed | `test/vm/coverage.test.js` (21 cases) |
| Reserved opcodes cannot be dispatched | "SWITCH_DISPATCH is rejected as reserved rather than dispatched to a runtime throw" |
| Branch targets cannot escape their function | "malformed input: a branch leaving its own function is rejected" |
| Registers cannot address outside the frame | "malformed input: a call window that runs past the function register file is rejected" |
| Constant/import indexes are bounds-checked | "malformed input: constant indexes past the pool are rejected, not read as undefined" |
| Unbounded/hostile argument counts are refused | "malformed input: an unbounded argument count is rejected" |
| Runaway loops are bounded | "a self-branch loop is bounded by the instruction budget, never a hang" |
| Oversized input is refused before parsing | `test/parser/adapter.test.js`: "oversized input is rejected before parsing" |
| Parser stack exhaustion is a typed error, not a crash | `test/compiler/support.test.js`: "parser stack exhaustion is reported as KXOBH-E-PARSE, not a crash" |
| Unimplemented CLI commands fail instead of faking success | `test/cli/cli.test.js`: "unimplemented commands fail loudly instead of pretending success" |
| Undeclared Node target is refused | `test/cli/cli.test.js`: "doctor rejects an undeclared node target with exit 30" |

## 3. Unverified assumptions

1. **No package crypto exists to assume anything about.** Every §13 property (HKDF info strings, AAD construction, nonce uniqueness, tag length, decryption order) is unverified because unimplemented.
2. **Node 20 / 22 behaviour is assumed equivalent.** Only Node 24.15.0 was executed. `config/node-targets.json` states explicitly that untested majors are targets, not proof.
3. **Clean-checkout reproducibility is assumed.** `npm ci` from the lockfile was not run in this session; `dist/` is not version-controlled, so a checkout without a build would run tests against whatever artifacts happen to be present.
4. **No Git history** means no provenance: I cannot prove the current source is the source that produced any prior claim.
5. **Capability enforcement is unverified beyond the bytecode layer.** `LOAD_GLOBAL_CAPABILITY` and `CALL_CAPABILITY` are verifier-checked against an import table, but there is no host bridge, so real-world capability containment is untested.
6. **Brotli/compression behaviour** is entirely unimplemented; nothing to verify.

## 4. Known limitations (must be stated, not softened)

1. **The VM is not a security sandbox.** `SPEC.md:645-647` says so directly: capability restriction reduces accidental exposure, but for untrusted code the boundary must be an OS process/container. This audit repeats that claim rather than expanding it.
2. **There is no embedded build key, and no obfuscation to evaluate.** Spec §13.2 item 8 instructs embedding a per-build transformed key, and §13.2 warns in the same paragraph that such a transformation is obfuscation only. **If such a key is ever added, it must not be described as secret.** Any analyst with the loader can recover it. No such key exists today; the claim "embedded keys are cryptographically secret" is false both now (vacuously) and in any future design.
3. **Source-leakage protection is currently structural, not cryptographic.** Bytecode-only emission means there is no source text in the artifact. Once a package layer exists with a plaintext or fallback section, that property must be re-established, not assumed.
4. **The verifier is a correctness gate, not an adversary-resistant hardening boundary.** It validates structure, indexes and branch rules. It does not defend against a hostile *host* (a modified `node:crypto`, a patched `Buffer`, a debugger), and it cannot: the loader runs in the same process as the attacker.
5. **Opcode remapping has no permutation proof** (no package/VM_CONFIG layer): a malformed opmap can only be partially caught by unknown/reserved-id checks.
6. **`eval`-free is not asserted.** The differential harness itself uses `new Function()` to produce native reference values; that is test-only code, but it means the test process executes arbitrary test-authored source by design.
7. **No integrity check on `dist/`.** Nothing detects a stale or tampered build artifact before tests run.

## 5. Explicit non-claims

- I do not claim encryption or signing work correctly — they do not exist.
- I do not claim the package format is spec-compliant — it does not exist.
- I do not claim Node 20/22 support.
- I do not claim the 96-byte footer was justified — no implementation or amendment supports it.
- I do not claim the VM is a sandbox.
