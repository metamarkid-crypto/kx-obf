# KX-OBH v1.0
## Technical Specification & Agent Implementation Brief

**Document status:** Proposed implementation specification  
**Version:** 1.0.0  
**Date:** 6 November 2026  
**Target:** A self-contained Node.js JavaScript protection/packaging tool combining KTech-style custom bytecode virtualization with OBH-style package integrity and cryptographic packaging.

---

# 0. Executive direction

KX-OBH is a build-time compiler, bytecode virtualizer, package protector, and single-file runtime packager. It transforms an authorized JavaScript application into a single distributable `.js` file. The distributable contains a compact runtime loader, a custom KX-OBH virtual machine (VM), an embedded encrypted package, and the package metadata required to execute the compiled program.

The architecture combines:

- **KTech concepts:** AST-to-bytecode compilation, custom VM execution, per-build opcode diversification, transformed constant/string storage, and a compact self-contained output.
- **OBH concepts:** structured packaging, Brotli compression, AES-256-GCM authenticated encryption, SHA-256 integrity metadata, and optional Ed25519 release signing.
- **Required corrections:** no plaintext JavaScript fallback; no dependency on V8 cached bytecode for the main execution path; no undocumented runtime key-fetch; no false claim that an embedded encryption key is secret; no silent decoy behavior on normal errors.

The primary product objective is to increase the cost of static source recovery while preserving application behavior and making package corruption detectable. KX-OBH is not a guarantee that client-side logic can never be reverse-engineered.

## 0.1 Non-negotiable design truth: no external runtime key

For this specification, **no external key** means:

1. The output must not request a passphrase, secret, license key, environment secret, or remote key service to decrypt and execute its own package.
2. Runtime decryption material, when embedded, is generated per build and included in obfuscated form inside the single output file.
3. An embedded key is recoverable by an analyst who controls the output file and can inspect or instrument its runtime. Therefore embedded AES-GCM is an **at-rest obfuscation layer and corruption detector**, not cryptographic confidentiality against a determined reverse engineer.
4. Ed25519 signing is optional and happens at build time with a local private key. The private key must never be included in the output. The runtime needs only a public key. If no signing key is configured, the build is unsigned and must not claim publisher authenticity.
5. A public key embedded in a modifiable JavaScript file is not an immutable trust anchor. It detects ordinary package changes when the verifier is not modified, but a determined attacker can patch the loader or replace the embedded public key. Strong authenticity requires a trust anchor outside the modifiable output, which is outside the no-external-runtime-key constraint.

The implementation and all user-facing documentation must state these limits accurately.

---

# 1. Product goals, scope, and non-goals

## 1.1 Goals

- Accept authorized JavaScript source code and compile supported syntax into KX-OBH bytecode.
- Produce one self-contained `.js` output file.
- Execute the protected application through the custom KX-OBH VM.
- Keep the original application source out of the output package. No source fallback, source string, source map, or recoverable source archive may be embedded in a production build.
- Use a versioned VM ABI that is independent of V8 cached-data formats.
- Use Node.js built-in cryptography and compression at runtime; do not require a separate key file or decryptor executable.
- Provide precise compile errors for unsupported syntax rather than silently leaving source code unprotected.
- Preserve supported JavaScript semantics and CommonJS module behavior.
- Detect malformed, corrupted, truncated, or tampered package data before executing bytecode.
- Keep the VM runtime and package parser defensive against malformed bytecode and resource exhaustion.
- Provide build profiles, diagnostics, test fixtures, and reproducible compiler outputs where safe.

## 1.2 Non-goals

- Hiding code from a determined analyst who controls the machine and runtime.
- Providing DRM, licensing enforcement, anti-cheat, or anti-debug guarantees.
- Acting as a security sandbox for untrusted application code.
- Replacing OS-level isolation, containers, least-privilege service accounts, or server-side authorization.
- Supporting all ECMAScript syntax in the first release.
- Making Node.js native addons or arbitrary external dependencies disappear into one file.
- Executing source through `eval`, `new Function`, or `vm.Script` as a way to bypass the custom compiler.
- Using malware-style stealth, persistence, destructive anti-analysis, environment sabotage, or evasion of security products.

## 1.3 Authorized use

The tool is intended to protect software the operator owns or is explicitly authorized to package. The CLI must display this condition in its help or documentation. Do not add features intended to conceal malicious behavior, persist covertly, evade endpoint controls, steal credentials, or disable security/debugging facilities.

---

# 2. Terminology

| Term | Meaning |
|---|---|
| Source | Original JavaScript input selected by the user. |
| AST | Abstract Syntax Tree generated by the parser. |
| Compiler | Converts supported AST nodes into KX-OBH bytecode and metadata. |
| Bytecode | Versioned instruction stream consumed by the KX-OBH VM. |
| VM | Custom interpreter included in the output JavaScript file. |
| VM ABI | Contract between compiler-generated bytecode and VM runtime. |
| Constant pool | Serialized literals and constant values referenced by bytecode. |
| Host capability | Explicit, policy-controlled access from VM code to Node.js or application host APIs. |
| Package | Binary KX-OBH container holding compiled sections and metadata. |
| Loader | Minimal bootstrap in the final `.js` file that validates, decrypts, decompresses, and starts the VM. |
| Embedded key material | Per-build decryption material stored inside the output in transformed form; not secret against the output owner. |
| Release signing key | Optional local Ed25519 private key used only during build. Never included in output. |

Normative words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as implementation requirements.

---

# 3. Deliverables

The Agent must deliver a working repository, not only a design or a code skeleton.

## 3.1 Required repository components

```text
kx-obh/
├── package.json
├── package-lock.json (or equivalent locked package manager file)
├── tsconfig.json
├── README.md
├── SPEC.md
├── LICENSES.md
├── src/
│   ├── cli/
│   ├── config/
│   ├── parser/
│   ├── compiler/
│   ├── bytecode/
│   ├── optimizer/
│   ├── vm/
│   ├── package-format/
│   ├── crypto/
│   ├── loader-template/
│   ├── diagnostics/
│   └── utils/
├── test/
│   ├── compiler/
│   ├── vm/
│   ├── package-format/
│   ├── crypto/
│   ├── integration/
│   ├── compatibility/
│   ├── fuzz/
│   └── fixtures/
├── examples/
├── scripts/
└── dist/ (generated; not committed unless project policy says otherwise)
```

The Agent MAY adjust the internal folder names, but module boundaries and responsibilities MUST remain explicit.

## 3.2 Required distributable

A successful production build must generate exactly one primary artifact:

```text
application.protected.js
```

The artifact must run with the configured supported Node.js runtime without a separate package file, `.key` file, `.bin` file, source file, or decryptor. Runtime dependencies required by the protected application may still need to be installed in `node_modules` unless explicitly bundled and legally safe to bundle. The single-file guarantee applies to the KX-OBH protection artifact and its package/key data, not automatically to every third-party native dependency.

## 3.3 Required command-line interface

Minimum commands:

```text
kxobh build <input.js> --out <output.js> [options]
kxobh verify <output.js>
kxobh inspect <output.js>
kxobh doctor [--node-target <major>]
kxobh keygen --out <directory>                 # optional release signing setup
kxobh version
kxobh help
```

Recommended build options:

```text
--profile balanced|advanced|maximum
--module commonjs
--target-node <comma-separated-major-versions>
--allow-builtin <module-name>                  # repeatable
--allow-package <package-name>                 # repeatable
--bundle-dependencies                           # only if supported and license-safe
--signing-key <local-private-key-path>          # optional, build-time only
--require-signature                             # fail if no valid signer configured
--compression brotli|none
--report <path>
--diagnostic                                    # development-only diagnostic output
--no-color
```

`--diagnostic` MUST NOT embed original source in a production artifact. It may emit a separate local build report containing source locations and compiler diagnostics. The default output remains a single `.js` file.

`inspect` must display safe metadata only: format version, package ID, VM ABI, build ID, section sizes, compression/encryption identifiers, signature state, and declared Node target range. It must not print decrypted bytecode, keys, or source.

`verify` must validate package structure, supported algorithms, signature policy, authentication tags, decompression limits, and bytecode verifier rules without executing the application program.

---

# 4. Implementation technology and dependency policy

## 4.1 Language

- Implement the build tool in TypeScript or strongly typed modern JavaScript. TypeScript is preferred for compiler and binary-format code.
- The generated runtime artifact must be compatible with the configured Node.js target matrix.
- Use Node.js built-ins for `node:crypto`, `node:zlib`, `node:fs`, `node:path`, `node:module`, and other host facilities as needed.

## 4.2 Parser

Use a maintained JavaScript parser that produces a well-defined AST (ESTree or a documented normalized AST). The parser package and version must be pinned by the lockfile. Hide the parser behind a `ParserAdapter` so it can be upgraded without rewriting the compiler.

The Agent must not write a JavaScript parser using regular expressions. Parsing with regex is prohibited.

The compiler must normalize parser-specific AST structures before code generation. The supported syntax matrix in Section 8 is authoritative. Parser acceptance does not imply compiler support.

## 4.3 Dependencies

- Pin all direct dependencies and commit the lockfile.
- Avoid runtime dependencies in the generated artifact other than Node.js built-ins and explicitly declared application dependencies.
- Do not download or execute remote code during a build.
- Provide an SBOM or at minimum a dependency/license inventory.
- Do not bundle a dependency without reviewing its license and runtime compatibility.
- Do not use custom cryptographic algorithms. Custom transforms are permitted only as obfuscation; cryptographic protection must use Node.js crypto implementations.

## 4.4 Node.js target selection

Do not guess or hard-code a broad support claim. Establish a release matrix in `config/node-targets.json` before implementation. The Agent must verify the supported Node.js release lines against the project's deployment requirements and official Node.js release information available to it. Record exact tested Node major versions and CI results.

The VM must not depend on V8 cachedData or undocumented V8 internals. The only engine-dependent parts should be ordinary ECMAScript and documented Node.js APIs.

---

# 5. Overall build pipeline

The required pipeline is:

```text
Input Source
  -> Source Discovery / Dependency Analysis
  -> AST Parse
  -> Scope & Semantic Analysis
  -> Supported-Syntax Validation
  -> AST Normalization / Lowering
  -> Bytecode Generation
  -> Register Allocation / Frame Layout
  -> Bytecode Verification
  -> Safe Bytecode Optimization
  -> Constant / String Section Generation
  -> Binary Section Serialization
  -> Brotli Compression (optional per section)
  -> AES-256-GCM Section Encryption
  -> Package Header + Directory Construction
  -> Optional Ed25519 Release Signing
  -> Base64 Embedding in Runtime Template
  -> Runtime Bootstrap Minification / Identifier Diversification
  -> Final Single .js Artifact
  -> Verify Artifact (mandatory post-build gate)
```

## 5.1 Pipeline invariants

1. Each phase has typed input/output contracts.
2. No phase may silently skip unsupported syntax.
3. All offsets, lengths, identifiers, and indices must be bounds-checked.
4. The original source must not be copied into the package, loader string table, comment, source map, or build metadata.
5. The output must be verified by the same package reader used by runtime, in a non-executing verification mode.
6. Compiler and runtime versions must be recorded in build metadata without embedding sensitive filesystem paths.
7. Failed builds must not leave a partially written output file. Write to a temporary file, fsync where appropriate, then atomic rename.

---

# 6. Final artifact structure

The final file is a normal JavaScript CommonJS entry point containing:

```text
application.protected.js
├── Minimal bootstrap wrapper
├── Runtime version / format guard
├── Embedded package bytes (Base64 or safe chunk array)
├── Per-build embedded key material (transformed; not a secret)
├── Optional pinned release public key
├── Package parser and verifier
├── AES-GCM / Brotli loader
├── KX-OBH VM runtime
└── Application entry execution
```

Requirements:

- The package must be a binary buffer before it is parsed. Do not parse a giant ad hoc JSON string as the primary binary format.
- Base64 is an embedding format only; it is not encryption.
- Use deterministic chunk concatenation if needed to avoid giant source-line or parser limits. Chunk boundaries must not affect package bytes.
- The bootstrap may be minified and have identifiers transformed, but the team must retain a readable source template in the repository.
- The VM implementation itself is necessarily present in the distributed JavaScript file. It can be minimized/obfuscated, but it cannot be made cryptographically secret from someone who controls the file and runtime.
- The output must not self-modify, alter environment variables, install process hooks for stealth, or sabotage debuggers.

---

# 7. Source and module compatibility policy

## 7.1 v1.0 module format

**CommonJS is the required v1.0 output and input execution model.** The protected program must preserve the observable behavior of a CommonJS module to the extent covered by the supported syntax and host capability policy.

Required bindings when applicable:

- `module`
- `exports`
- `__filename`
- `__dirname`
- `require` through a host capability bridge
- CommonJS cache and module identity semantics where feasible

The loader must not expose unrestricted `require` to bytecode by default. Static imports/requires must be analyzed and matched against the configured allowlist. A compatibility option may allow an explicitly approved package set.

ES modules, top-level await, dynamic import, and dual-package interop are outside the minimum v1.0 contract unless the Agent implements them as a separately tested feature. Unsupported module syntax must produce a compile-time error, not a plaintext fallback.

## 7.2 Dependency behavior

- Built-in modules must be explicitly allowlisted. Distinguish `node:fs` and `fs` aliases consistently.
- External packages must be declared in build configuration or package metadata.
- Static `require("name")` may be represented in an import table.
- Dynamic `require(expr)` must be rejected by default with source location. It may only be enabled through an explicit unsafe compatibility option and a runtime policy that restricts the resolved names.
- Native addons cannot generally be inlined into a single JavaScript artifact. Document this limitation.
- If dependency bundling is implemented, preserve licenses and package notices; do not bundle native addons unless explicitly supported.

---

# 8. JavaScript language support matrix

The VM compiler is not required to support all ECMAScript in v1.0. It is required to support a documented subset accurately and reject everything else clearly.

## 8.1 v1.0 required syntax

| Category | Required support |
|---|---|
| Program | CommonJS script, directives, top-level statements |
| Declarations | `var`, `let`, `const`, function declarations |
| Primitive literals | `null`, booleans, numbers, strings |
| Expressions | identifiers, `this`, unary, binary, logical, conditional, sequence, assignment, update |
| Member access | dot and computed property access |
| Calls | function call, method call, `new` |
| Functions | function expression, arrow function, lexical closure capture |
| Control flow | block, `if`, `switch`, `while`, `do/while`, classic `for`, `break`, `continue`, `return` |
| Objects | object literals, data properties, shorthand properties, computed keys |
| Arrays | array literals and indexed access |
| Exceptions | `throw`, `try/catch/finally` |
| Operators | arithmetic, comparison, bitwise, logical, `typeof`, `void`, `in`, `instanceof` |
| Templates | template literals with expressions, lowered to concatenation |
| Regex | regex literals represented by pattern and flags |
| Async | `async` functions, `await`, Promise return and rejection propagation |
| Optional syntax | optional chaining and nullish coalescing if semantic tests pass |
| CommonJS | supported module bindings and approved static imports |

The Agent must preserve strict-mode behavior based on source directives and module semantics. It must not force strict mode if doing so changes behavior.

## 8.2 Unsupported in v1.0 unless separately implemented and tested

- Generator functions and `yield`.
- `for await...of`.
- Top-level await.
- ESM import/export execution.
- Dynamic `import()`.
- `eval` and `new Function` source generation.
- Class private fields and private methods.
- Complex `super` behavior.
- Destructuring patterns, unless fully lowered and tested.
- Spread/rest semantics, unless fully implemented and tested.
- Proxy-specific edge behavior beyond native object operations.
- Decorators and experimental syntax.
- WebAssembly modules.
- Native addon compilation or inlining.

If an unsupported construct is encountered, emit an error such as:

```text
KXOBH-E-COMPILER-UNSUPPORTED
src/payment.js:42:7
Unsupported syntax: ClassPrivateProperty
Feature: class private fields
Action: simplify the construct or use a future KX-OBH version that supports it.
```

Never silently pass the original construct through as executable plaintext.

## 8.3 Semantic correctness requirements

The compiler must explicitly test:

- Lexical scope, shadowing, TDZ behavior for `let`/`const`.
- `var` function scope and hoisting.
- Closure capture and mutation.
- Arrow function lexical `this` and `arguments` behavior.
- Regular function `this` behavior, including strict mode.
- Method receiver preservation (`obj.method()` must receive `obj` as `this`).
- `new` and constructor return rules.
- Property getter/setter side effects and thrown errors.
- JavaScript coercion rules, including `NaN`, `-0`, `null`, `undefined`, and string/number conversion.
- Short-circuit behavior for `&&`, `||`, and `??`.
- Evaluation order and side-effect order.
- `try/catch/finally`, including return/throw from `finally`.
- Promise resolution, rejection, and await resumption.
- Object identity and array mutation.
- `typeof` behavior for undefined identifiers where applicable.
- `delete`, `in`, and `instanceof` if they are included in the supported compiler subset.

Native JavaScript values should be used inside VM registers wherever practical. Do not invent a custom number/string/object representation unless needed and proven correct.

---

# 9. KX-OBH VM specification

## 9.1 VM design

The VM is a register-based interpreter. The initial design retains a **64-register working register file per frame** as a reasonable starting profile, but this is a configurable implementation detail, not a semantic requirement. If register pressure exceeds the configured register budget, the compiler must spill values into frame slots. The VM must not silently alias or overwrite live registers.

Each frame contains at minimum:

```text
Frame
├── functionId
├── programCounter
├── registerFile[64]
├── localSlots[]
├── closureEnvironment
├── thisValue
├── argumentsValue (when required)
├── callerFrame
├── completionState
└── asyncContinuationState (for async functions)
```

The VM uses JavaScript native values for operands. It must correctly represent `undefined`, `null`, booleans, numbers, strings, BigInt only if supported, Symbols when received from host APIs, and object references.

## 9.2 Instruction encoding v1.0

Use a fixed-width **12-byte instruction record** for the first stable ABI. This is intentionally chosen for simpler validation and predictable instruction boundaries rather than copying KTech's compact four-byte encoding.

All multi-byte integers are little-endian.

| Offset | Size | Field | Meaning |
|---:|---:|---|---|
| 0 | 1 | opcode | Canonical operation ID after deobfuscation mapping |
| 1 | 1 | flags | Operation-specific flags; undefined bits must be zero |
| 2 | 2 | dst | Destination register or `0xFFFF` when absent |
| 4 | 2 | a | First source register or operation-specific index |
| 6 | 2 | b | Second source register or operation-specific index |
| 8 | 4 | imm32 | Immediate, signed branch offset, constant index, or operation-specific value |

The compiler can use opcode remapping at build time, but the runtime must map each stored opcode to exactly one canonical operation. The mapping must be represented in a versioned VM configuration section and validated before execution.

The VM ABI must define:

- Canonical opcode IDs.
- Operand meaning for every opcode.
- Register constraints.
- Immediate signedness and interpretation.
- Program-counter update rules.
- Exception behavior.
- Side-effect behavior.
- Instruction cost category for optional resource accounting.

Do not add opaque or undefined opcode behavior. Unknown opcode IDs must cause a controlled verification/runtime error.

## 9.3 Minimum opcode families

Exact numeric opcode IDs are generated/mapped per build. The canonical operation catalog must include, at minimum:

**Data movement and constants**
- `NOP`
- `LOAD_UNDEFINED`
- `LOAD_NULL`
- `LOAD_BOOL`
- `LOAD_NUMBER`
- `LOAD_CONST`
- `MOVE`
- `LOAD_THIS`
- `LOAD_ARGUMENTS`

**Variables and scope**
- `LOAD_LOCAL`
- `STORE_LOCAL`
- `LOAD_CAPTURE`
- `STORE_CAPTURE`
- `LOAD_GLOBAL_CAPABILITY`
- `DECLARE_BINDING`

**Property/object operations**
- `GET_PROPERTY`
- `SET_PROPERTY`
- `DELETE_PROPERTY`
- `HAS_PROPERTY`
- `CREATE_OBJECT`
- `CREATE_ARRAY`
- `DEFINE_DATA_PROPERTY`
- `CREATE_REGEXP`

**Arithmetic and comparison**
- `ADD`, `SUB`, `MUL`, `DIV`, `MOD`, `POW`
- `NEGATE`, `POSITIVE`, `BIT_NOT`, `LOGICAL_NOT`
- `EQ`, `STRICT_EQ`, `NEQ`, `STRICT_NEQ`
- `LT`, `LTE`, `GT`, `GTE`
- `BIT_AND`, `BIT_OR`, `BIT_XOR`, `SHL`, `SHR`, `USHR`
- `TYPEOF`, `VOID`, `IN`, `INSTANCEOF`

**Control flow**
- `JUMP`
- `JUMP_IF_TRUE`
- `JUMP_IF_FALSE`
- `JUMP_IF_NULLISH`
- `RETURN`
- `THROW`
- `SWITCH_DISPATCH` or equivalent sequence of verified comparisons/jumps

**Functions and calls**
- `CREATE_CLOSURE`
- `CALL`
- `CALL_METHOD`
- `CONSTRUCT`
- `RETURN_UNDEFINED`

**Async and exceptions**
- `TRY_BEGIN` / exception-table equivalent
- `TRY_END` / exception-table equivalent
- `CATCH_BIND`
- `FINALLY_RESUME`
- `AWAIT`
- `RESOLVE_ASYNC`
- `REJECT_ASYNC`

**Host bridge**
- `IMPORT_CAPABILITY`
- `CALL_CAPABILITY`

The actual catalog may be refined, but the VM ABI document must define all operations before the compiler emits them.

## 9.4 Call convention

Define and document a stable calling convention. Recommended baseline:

- Callee stored in a register.
- Receiver (`this`) stored separately for method calls.
- Arguments are placed in a contiguous argument window or copied into a call record.
- Argument count is explicit.
- Return value is written into the caller's destination register.
- A VM function call creates a VM frame; a host function call crosses the capability bridge.
- Exceptions from host calls must be converted into VM throw completions without losing the original error identity where possible.

The compiler must preserve evaluation order when evaluating callee, receiver, and arguments.

## 9.5 Closure model

A closure contains:

- Function ID.
- Captured lexical environment reference.
- Required lexical `this` binding for arrow functions.
- Strictness and async flags.

Captured mutable bindings must be boxed or represented through shared environment cells so changes remain visible across closures. Copying captured values at closure creation is not sufficient when the original binding is mutable.

## 9.6 Async/await model

Async functions must return a Promise-compatible result immediately. `AWAIT` suspends the current VM frame, attaches continuation handlers, then resumes execution with either a fulfilled value or a throw completion. Await rejection must enter the correct VM exception handler/finally path.

Do not implement async by blocking the Node.js event loop. Do not fake async by synchronously extracting Promise internals.

## 9.7 VM execution limits

Provide configurable safety limits:

- Maximum bytecode package size.
- Maximum section decompressed size.
- Maximum function count.
- Maximum instructions per function.
- Maximum constant count and constant byte length.
- Maximum frame depth.
- Maximum VM frame allocation.
- Optional instruction budget for diagnostics/testing.

Defaults must be generous enough for ordinary applications and documented. Limits must be enforced before dangerous allocation where possible. Exceeding a limit must throw a typed error, not crash the process.

The instruction budget is a reliability/resource-control feature, not anti-debugging or an attempt to prevent the application owner from inspecting execution.

---

# 10. Bytecode verification and safe optimization

## 10.1 Static verifier

A verifier must run after compilation and again in runtime verification mode before execution.

It must validate:

- Header and ABI versions.
- Instruction stream length is a multiple of 12 bytes.
- Opcode is known.
- Flags contain only supported bits.
- Register IDs are in range.
- Constant/function/import indexes are in range.
- Branch targets land on instruction boundaries inside the same function.
- Function ranges do not overlap unexpectedly and remain inside the code section.
- Exception ranges are valid and properly nested according to the VM rule.
- Closure references point to valid functions and capture layouts.
- Argument windows and frame-slot references are in range.
- No section offset/length overflows integer limits.
- No duplicate mandatory sections.
- No undeclared required feature flags.

The runtime verifier must reject unknown future ABI features rather than attempting best-effort execution.

## 10.2 Optimization policy

Safe optimizations may include:

- Constant folding where JavaScript coercion semantics are preserved.
- Dead-code elimination when side effects and exceptions are preserved.
- Basic-block jump simplification.
- Register allocation and spill optimization.
- Instruction fusion with an explicit canonical definition.
- Removal of unreachable compiler-generated blocks.

Do not use speculative or semantics-changing transformations in v1.0. Preserve side-effect order. Each optimization must have differential tests against an unoptimized bytecode build.

## 10.3 No junk-code requirement

Junk instructions, bogus branches, and fake functions are not required for v1.0. They often increase file size, reduce performance, complicate debugging, and create new verifier risks. Prioritize correct virtualization, compact serialization, and per-build opcode mapping.

---

# 11. Runtime capability and host API model

The VM must not receive unrestricted host access by default.

## 11.1 Capability table

Represent host access as a stable import/capability table. Each capability has:

- Capability ID.
- Public name.
- Required permissions.
- Argument validation rule where practical.
- Return/error behavior.
- Sync/async classification.

Examples may include approved `node:fs` functions, `node:path`, `node:crypto`, network clients, timers, or selected application dependencies. These examples are not automatically enabled.

## 11.2 Defaults

- No implicit `eval` or `Function` constructor.
- No unrestricted dynamic `require` by default.
- No automatic access to all of `process.env`.
- No hidden modification of environment variables.
- No automatic file-system scanning.
- No process spawning unless explicitly configured and documented.
- No access to native modules not explicitly allowed.

If the protected application legitimately requires a host API, the user must configure the capability. The compiler must report missing capabilities clearly.

## 11.3 Security boundary clarification

Capability restriction reduces accidental exposure and can help create a least-privilege runtime, but the VM is not a proven security sandbox. For untrusted code, use a separate OS process/container and OS-level restrictions.

---

# 12. KX-OBH binary package format v1.0

The package is a binary container embedded as Base64 in the final JavaScript file. The binary container itself is not JSON.

## 12.1 Endianness and integer policy

- All multibyte integers are little-endian.
- Use explicit unsigned reads/writes (`readUInt16LE`, `readUInt32LE`, `readBigUInt64LE`) and reject values above safe implementation limits.
- Convert offsets to `bigint` until bounds are proven safe for Buffer indexing.
- Reject negative or overflowing values.

## 12.2 64-byte fixed header

| Offset | Size | Field | Rule |
|---:|---:|---|---|
| 0 | 8 | Magic | ASCII `KXOBH1\r\n` |
| 8 | 2 | Format major | `1` |
| 10 | 2 | Format minor | `0` |
| 12 | 4 | Header size | `64` for v1.0 |
| 16 | 4 | Flags | Bit 0 signed; other bits zero in v1.0 |
| 20 | 2 | Section count | `1..16` |
| 22 | 2 | Reserved | Must be zero |
| 24 | 16 | Package ID | Random bytes from CSPRNG |
| 40 | 2 | VM ABI major | `1` |
| 42 | 2 | VM ABI minor | `0` |
| 44 | 2 | Minimum Node major | Explicit target value |
| 46 | 2 | Maximum Node major | Explicit target value; `0` only if policy defines open-ended support |
| 48 | 4 | Directory offset | `64` |
| 52 | 4 | Directory length | `sectionCount * 32` |
| 56 | 8 | Total package length | Includes optional signature footer |

A version mismatch must produce a clear typed error. Do not assume an unknown minor version is compatible without an explicit compatibility rule.

## 12.3 32-byte section directory entry

| Offset within entry | Size | Field | Rule |
|---:|---:|---|---|
| 0 | 2 | Section type | Unique section type ID |
| 2 | 2 | Flags | Unknown flags rejected |
| 4 | 1 | Compression | `0 = none`, `1 = Brotli` |
| 5 | 1 | Encryption | `1 = AES-256-GCM` in v1.0 |
| 6 | 2 | Reserved | Must be zero |
| 8 | 8 | Section offset | Absolute package offset |
| 16 | 8 | Stored length | Includes 12-byte nonce + ciphertext + 16-byte tag |
| 24 | 8 | Plain length | Decompressed section length |

Section data layout:

```text
nonce[12] || ciphertext[variable] || authTag[16]
```

The ciphertext is the compressed section bytes when compression is Brotli. `plainLength` is the size before compression. For no compression, ciphertext length must equal `plainLength`.

## 12.4 Section types

| ID | Name | Required | Content |
|---:|---|---|---|
| `0x0001` | `VM_CODE` | Yes | Instruction streams for all compiled functions |
| `0x0002` | `CONSTANT_POOL` | Yes | Typed constants; strings are not stored as raw source text when transformation is enabled |
| `0x0003` | `FUNCTION_TABLE` | Yes | Function ranges, parameter/local/register counts, flags, capture layouts |
| `0x0004` | `IMPORT_TABLE` | Yes | Approved capability/module references |
| `0x0005` | `EXCEPTION_TABLE` | Optional | Exception and finally ranges |
| `0x0006` | `VM_CONFIG` | Yes | Opcode mapping, feature flags, ABI-specific VM data |
| `0x0007` | `SOURCE_LOCATIONS` | No in production | Optional encrypted diagnostic mapping; excluded from production by default |
| `0x0008` | `BUILD_INFO` | Optional | Non-sensitive compiler/build metadata |

The Agent may add future section types only by updating the format specification and versioning policy. Unknown required sections must fail. Unknown optional sections may be skipped only when their flags explicitly mark them optional.

## 12.5 Signature footer

If the signed flag is set, append exactly 80 bytes:

```text
magic[8] = ASCII "KXSGv1\0\0"
keyId[8] = first 8 bytes of SHA-256(DER-SPKI public key)
signature[64] = Ed25519 signature
```

The signature input is:

```text
UTF8("KXOBH-PACKAGE-SIGNATURE-v1\0")
|| SHA256(packageBytesBeforeSignatureFooter)
```

Use Node.js Ed25519 APIs (`crypto.sign(null, data, privateKey)` and `crypto.verify(null, data, publicKey, signature)`). The private key is only used during build and must never be serialized into the output.

The output loader may embed a configured public key. Document that this public key is replaceable by an attacker who can modify the loader; it is not a hardware- or OS-pinned trust anchor.

## 12.6 Package parser safety

Before allocating or decompressing:

- Validate minimum and maximum package size.
- Validate exact header size and magic.
- Validate directory count and length.
- Validate all ranges with overflow-safe arithmetic.
- Ensure sections do not overlap the header, directory, footer, or one another.
- Ensure directory entries are sorted by offset or normalize them safely.
- Enforce maximum compressed and decompressed sizes.
- Reject duplicate required section types.
- Reject inconsistent compression/encryption flags.
- Reject trailing bytes not accounted for by the format.

Do not trust lengths from the package. Set hard maximums in runtime configuration.

---

# 13. Cryptographic and compression profile

## 13.1 Algorithms

- Hash: SHA-256 through `node:crypto`.
- Authenticated encryption: AES-256-GCM.
- KDF: HKDF-SHA-256.
- Optional release signature: Ed25519.
- Compression: Brotli through `node:zlib`.
- Random values: `crypto.randomBytes()` only; never `Math.random()`.

## 13.2 Per-build key material

At build time:

1. Generate a fresh 32-byte content-encryption master key using `crypto.randomBytes(32)`.
2. Generate a fresh 16-byte package ID.
3. Generate an independent 12-byte nonce for every encrypted section.
4. Derive a distinct 32-byte section key using HKDF-SHA-256 with:
   - IKM: per-build master key.
   - Salt: package ID.
   - Info: `KXOBH/v1/section/<section-type>` encoded as UTF-8.
5. Encrypt compressed section bytes with AES-256-GCM.
6. Use the 64-byte header and exact 32-byte directory entry as AAD, prefixed by a domain label such as `KXOBH-AEAD-v1\0`.
7. Store the nonce, ciphertext, and authentication tag.
8. Embed the master key in the final loader in a per-build transformed representation.

The transformation of the embedded key is only obfuscation. The Agent must not claim that splitting, XOR-masking, string-encoding, or scattering the key makes it secret. A static or dynamic analyst can reconstruct it.

## 13.3 GCM nonce rules

- A 96-bit nonce is required.
- A nonce must never be reused with the same derived section key.
- Use a cryptographically secure random nonce for each section.
- Generate a new master key for every build; do not reuse a key/nonce pair across builds.
- The build must fail if nonce generation fails.

## 13.4 Decryption order

Runtime order:

1. Parse and structurally validate the package.
2. Verify optional release signature according to policy.
3. Derive the section key.
4. Authenticate and decrypt the section using AES-GCM.
5. Only after successful GCM authentication, decompress with a strict output-size limit.
6. Verify resulting section length equals `plainLength`.
7. Run bytecode and metadata verification.
8. Initialize VM.

Never decompress unauthenticated ciphertext. Never execute partially decrypted or partially parsed bytecode.

## 13.5 Compression

- Brotli is the default for code and constant sections.
- `none` is allowed for tiny sections when compression increases size.
- Compression parameters must be configurable by build profile, but algorithm parameters must not change the package format.
- Enforce `plainLength` and configured maximum output bytes to prevent decompression bombs.
- Record compression mode per section.

## 13.6 No-key mode and security claims

The default product mode must work without any runtime key input. The embedded per-build key satisfies that product constraint but does not provide strong confidentiality against the output owner. AES-GCM still provides authenticated decryption and detects accidental or unsophisticated modifications when the loader/key material is unmodified.

If no build-time signing key is supplied, report `signature: unsigned`. Do not produce a fake self-signed keypair and market it as trusted authenticity. Optional self-generated per-build signing can be supported only as a consistency feature and must be labelled self-signed/untrusted.

---

# 14. Loader and runtime execution flow

The loader must be small, deterministic, and explicit. It must not contain a hidden fallback to original source.

Required order:

```text
START
  -> Verify Node.js target range
  -> Decode embedded Base64 package bytes
  -> Parse fixed header and directory
  -> Check limits and bounds
  -> Verify optional Ed25519 signature
  -> Recover embedded per-build master key
  -> Derive section keys
  -> AES-GCM authenticate/decrypt required sections
  -> Brotli decompress with limits
  -> Validate all required sections
  -> Verify bytecode
  -> Initialize capability table
  -> Initialize VM
  -> Execute CommonJS entry function
  -> Assign module.exports and return normally
```

## 14.1 Error behavior

- Any verification failure must abort before application bytecode executes.
- Report a stable error code and concise message.
- Do not set global debug flags or modify `process.env` as a punishment or trap.
- Do not run decoy application code on failure.
- Do not swallow errors silently.
- Provide optional diagnostics through a documented environment variable such as `KXOBH_DEBUG=1`, but this must only control logging and must not weaken verification.
- Do not log decryption keys, plaintext constants, or raw bytecode in production.

## 14.2 Runtime compatibility

The output must check Node major version against the package target range. Runtime APIs used by the loader must be available in all supported targets. If a capability is unavailable, fail with a typed compatibility error.

The VM ABI is designed to be V8-independent. Do not use undocumented `process.binding`, cachedData patching, private V8 APIs, or runtime bytecode headers.

---

# 15. Build profiles

Profiles must change meaningful compiler and runtime options, not merely add junk bytes.

| Feature | Balanced | Advanced | Maximum |
|---|---|---|---|
| AST validation | On | On | On |
| Bytecode virtualization | All supported functions | All supported functions | All supported functions |
| Opcode mapping | Per build | Per build | Per build |
| Constant transformation | On | On | On |
| Lazy string decode | On | On | On |
| Safe optimization | Standard | Aggressive but semantics-safe | Aggressive but semantics-safe |
| Instruction fusion | Common patterns | More patterns | More patterns after benchmark |
| Metadata stripping | Production | Production | Production |
| Brotli | On | On | On |
| AES-GCM | On | On | On |
| Signing | Optional | Optional | Optional |
| Anti-debug traps | Off | Off | Off |

Profile rules:

- Balanced is the default.
- Advanced and Maximum must pass the same correctness suite.
- Maximum must not add opaque predicates or junk instructions that make correctness or resource usage unpredictable.
- Profiles must publish approximate output-size and runtime-overhead measurements from benchmarks.

---

# 16. CLI behavior and user experience

## 16.1 Example commands

```bash
# Build a CommonJS entry point
kxobh build ./src/index.js --out ./dist/index.protected.js --profile balanced

# Declare built-in modules used by the application
kxobh build ./src/index.js --out ./dist/index.protected.js \
  --allow-builtin node:fs --allow-builtin node:path --allow-builtin node:crypto

# Build with a locally managed Ed25519 release key
kxobh build ./src/index.js --out ./dist/index.protected.js \
  --signing-key ./keys/release-private.pem --require-signature

# Validate without executing application bytecode
kxobh verify ./dist/index.protected.js

# Inspect package metadata only
kxobh inspect ./dist/index.protected.js

# Check local runtime compatibility
kxobh doctor
```

## 16.2 Reports

A build report should include:

- Input file basename (avoid absolute paths by default).
- Compiler version.
- Package format version.
- VM ABI version.
- Node target matrix.
- Number of compiled functions.
- Number of bytecode instructions.
- Count of constants and imports.
- Per-section raw/compressed/encrypted sizes.
- Build duration.
- Signature state.
- Unsupported syntax count (must be zero on successful build).
- Source leakage scan result.

Do not print the embedded key or secret material.

## 16.3 Exit codes

Define stable exit codes, for example:

- `0`: success.
- `2`: command usage/configuration error.
- `10`: parse/compile error.
- `11`: unsupported syntax.
- `20`: package format/integrity error.
- `21`: signature verification error.
- `22`: crypto/decompression error.
- `30`: runtime/Node compatibility error.
- `40`: internal tool error.

Document all exit codes and keep them stable within major format versions.

---

# 17. Diagnostics and observability

- Compiler errors must include source file, line, column, feature name, and a suggested action.
- Runtime errors must include stable KX-OBH code, VM function ID, bytecode PC, and original source location only if an encrypted diagnostic map is intentionally included.
- Production output must not include original source maps by default.
- Diagnostic mode must never disable package verification or execute less-validated bytecode.
- No secrets, embedded key fragments, or decrypted constant values may appear in logs.
- A panic in the VM must be converted to a controlled runtime error where possible; do not leave partially mutated global state in the loader.

---

# 18. Security and threat model

## 18.1 Protected against

KX-OBH aims to increase effort against:

- Casual source browsing.
- Simple pretty-printing and identifier renaming reversal.
- Search-based extraction of obvious source strings.
- Accidental package corruption.
- Unsophisticated modification of encrypted sections while leaving loader/verifier untouched.
- Malformed package structures that attempt to trigger parser bounds errors.

## 18.2 Not protected against

KX-OBH does not guarantee protection against:

- An analyst who controls the runtime process and can instrument built-in APIs.
- Extraction of embedded key material.
- Patching the JavaScript loader or VM implementation.
- Re-implementing the documented/custom VM and disassembling bytecode.
- Observing strings and values after the VM decodes them in memory.
- Observing application inputs, outputs, network requests, and side effects.
- Reconstructing business logic from bytecode, behavior, or repeated runtime observation.
- A compromised operating system or privileged debugger.

## 18.3 Controls

- Keep the most valuable business rules and secrets server-side where practical.
- Never embed production database passwords, API secrets, private signing keys, or long-lived bearer tokens in protected client-side JavaScript.
- Restrict VM host capabilities.
- Validate package before execution.
- Keep cryptographic implementation in Node.js built-ins.
- Keep release signing private keys outside the generated artifact and out of source control.
- Sign release artifacts when a trusted local release key is configured.
- Log verification failure without destructive side effects.
- Maintain a clean-room implementation of the VM and package format; do not copy decoder tables, keys, or proprietary implementation code from third-party samples without authorization.

## 18.4 Anti-tamper policy

Permitted:

- Hash checks.
- AEAD authentication.
- Signature verification.
- Bounds checks.
- Runtime version checks.
- Bytecode verifier.
- Controlled failure and diagnostic logging.

Prohibited:

- Changing environment variables to poison debugging.
- Killing or sabotaging debugging tools.
- Deleting files or altering user data when tampering is detected.
- Covert persistence or process injection.
- Security-tool evasion.
- Misleading decoy behavior that hides the true error from legitimate operators.

---

# 19. Testing strategy and acceptance criteria

A production release is blocked until all mandatory tests pass.

## 19.1 Differential semantic tests

For each supported feature:

1. Run the original source directly under each supported Node major.
2. Compile and execute it through KX-OBH.
3. Compare output, return values, thrown errors, observable side effects, and module exports.
4. Repeat with optimization disabled and enabled.
5. Include edge cases such as `NaN`, `-0`, `undefined`, `null`, shadowed variables, TDZ, getter side effects, and nested closures.

## 19.2 Compiler tests

- Parser acceptance/rejection.
- Scope resolution.
- Hoisting and TDZ.
- Closure capture.
- Control-flow generation.
- Register allocation and spilling.
- Exception table construction.
- Async suspension/resumption.
- Source location diagnostics.
- Unsupported syntax must never be passed through as plaintext.

## 19.3 VM tests

- Every canonical opcode has a unit test.
- Invalid register, constant, function, import, and jump indexes are rejected.
- Branches cannot jump into the middle of an instruction.
- Invalid opcode/flags are rejected.
- Closure mutation is preserved.
- Host errors are propagated correctly.
- Async rejection enters the correct catch/finally block.
- Frame and instruction limits are enforced.

## 19.4 Package and crypto tests

- Round-trip package creation/read for each section type.
- AES-GCM valid decrypt.
- Wrong key, wrong nonce, wrong tag, and altered AAD fail.
- Alter every header/directory/footer field and assert rejection where required.
- Truncate at every structural boundary and assert safe rejection.
- Overlap sections and overflow offsets and assert safe rejection.
- Invalid compression and decompression bombs are rejected within configured limits.
- Signed package verifies with expected public key.
- Wrong public key and changed signature fail.
- Unsigned package is clearly identified as unsigned.
- No signing private key bytes are present in output.

## 19.5 Source-leakage tests

After building, scan the output and decoded package for:

- Exact source snippets and unique sentinel strings that should not exist in metadata.
- Original comments and source maps.
- Original file paths and developer usernames.
- Source fallback markers.
- Build-time private key material.

Use test fixtures with unique strings and comments so leakage detection is deterministic. A source string used as a runtime constant may legitimately exist in transformed or encrypted form; the test must check plaintext leakage, not falsely require every runtime string to disappear from memory forever.

## 19.6 Fuzz testing

Fuzz:

- Package parser.
- Section directory parser.
- Bytecode verifier.
- Constant pool decoder.
- Function/exception table decoder.
- Opcode mapping loader.

The expected result for malformed input is a controlled error, not process termination, hang, unbounded memory allocation, or arbitrary host API invocation.

## 19.7 Performance benchmarks

Benchmark at least:

- Build time.
- Output size.
- Process startup overhead.
- Runtime throughput on representative loops/calls/object access.
- Memory use.
- Async workload overhead.

Compare native Node execution with KX-OBH execution. Publish results per target Node major and profile. Do not claim a performance target until measured. Establish regression gates after the first stable baseline; a suggested initial CI gate is to block unexplained regressions greater than 20% against the previous release for the same environment.

## 19.8 Mandatory acceptance criteria

The build is accepted only when:

- It emits one `.js` artifact.
- That artifact runs without external decryption keys or separate KX-OBH payload files.
- No original JavaScript fallback is present.
- Every accepted source construct is compiled into VM bytecode.
- Unsupported syntax fails at build time with actionable diagnostics.
- Runtime validates structure, signature policy, AEAD tags, and bytecode before execution.
- The differential test suite passes on every declared Node target.
- No invalid bytecode can cause an unbounded allocation or out-of-range access.
- No external private key or plaintext source is embedded in the artifact.
- Security documentation states the embedded-key and reverse-engineering limitations.
- `kxobh verify` succeeds on valid output and safely rejects tampered fixtures.

---

# 20. Implementation phases and milestones

The Agent must work in small, verifiable phases. Do not attempt to implement all components in one giant file.

## Phase 0 — Repository and contract setup

Deliver:
- Repository skeleton.
- TypeScript configuration and lint/test scripts.
- Parser adapter.
- Node target config.
- Error code catalog.
- This specification stored as `SPEC.md`.

Gate: project installs from lockfile and a minimal CI test passes.

## Phase 1 — Parser, AST validator, and syntax diagnostics

Deliver:
- Parser integration.
- AST normalization.
- Scope analysis.
- Supported-syntax validator.
- Clear unsupported-feature diagnostics.

Gate: fixtures are classified correctly; no code generation yet.

## Phase 2 — Bytecode ABI and VM skeleton

Deliver:
- Canonical opcode catalog.
- 12-byte instruction encoder/decoder.
- Function and constant table formats.
- VM frame model.
- Bytecode verifier.
- Unit tests for every opcode implemented.

Gate: hand-authored bytecode programs execute correctly.

## Phase 3 — Compiler subset

Deliver:
- Literals and variable declarations.
- Expressions and operators.
- Functions, closures, calls, and returns.
- Branches and loops.
- Arrays and objects.
- Exceptions.

Gate: differential tests pass for the implemented subset.

## Phase 4 — Async and CommonJS host bridge

Deliver:
- Async/await state machine.
- Promise error propagation.
- CommonJS module wrapper semantics.
- Capability/import table.
- Built-in and package allowlist.

Gate: async and module integration fixtures pass.

## Phase 5 — Binary package and crypto

Deliver:
- Header and section directory implementation.
- Brotli section compression.
- AES-GCM per-section encryption.
- Embedded per-build key handling.
- Optional Ed25519 signing.
- Non-executing package verification.

Gate: tamper and parser-boundary tests pass.

## Phase 6 — Single-file runtime loader

Deliver:
- Runtime template.
- Embedded package generator.
- Loader verification/decryption/decompression.
- VM startup and CommonJS export forwarding.
- Post-build verify step.

Gate: protected artifact runs in a clean test directory without source or separate key files.

## Phase 7 — Diversification and profiles

Deliver:
- Per-build opcode remapping.
- Constant/string transforms.
- Lazy constant decoding.
- Safe instruction fusion.
- Balanced/Advanced/Maximum profiles.

Gate: all profiles pass the same semantic and integrity tests.

## Phase 8 — Hardening, fuzzing, and release

Deliver:
- Fuzz harnesses.
- Compatibility matrix.
- Performance benchmarks.
- Dependency/license inventory.
- Security limitations documentation.
- Example project and complete README.

Gate: all mandatory acceptance criteria pass.

---

# 21. Agent execution instructions

The following is the direct instruction set for the implementation Agent. The Agent must follow it as a project contract.

## 21.1 Required working style

1. Read this entire specification before coding.
2. Inspect the existing repository before modifying anything. Preserve existing working functionality unless a change is required and explained.
3. Build a requirement traceability checklist mapping every MUST requirement to code modules and tests.
4. Implement in the phases above. Do not skip tests to accelerate development.
5. After each phase, run unit tests, integration tests relevant to that phase, type checks, lint, and build checks.
6. Keep compiler, VM, package format, crypto, loader, and CLI modules separate.
7. Use strict types and explicit error classes. Avoid `any` except at parser boundaries, with conversion to normalized types immediately.
8. Do not use regular expressions as a JavaScript parser.
9. Do not use homemade cryptography. Use Node.js `crypto` for SHA-256, HKDF, AES-GCM, Ed25519, and secure randomness.
10. Do not use `Math.random()` for keys, IDs, or nonces.
11. Do not leave TODOs, placeholder implementations, fake passing tests, or unhandled opcode stubs in a release build.
12. Do not claim full JavaScript compatibility. Publish the exact supported syntax matrix.
13. Do not add plaintext fallback or an alternate path that executes original source.
14. Do not include source, source maps, comments, private keys, or secret values in a production package.
15. Do not implement anti-debugging sabotage, stealth, process injection, persistence, or security-tool evasion.
16. If a feature is not implemented, reject it clearly and add a test proving it is rejected.
17. If a requirement is ambiguous, document the assumption in `DECISIONS.md`; ask for clarification only when proceeding would risk an irreversible architecture decision.
18. Run the full test suite on every declared Node target before reporting completion.
19. Produce an implementation report listing completed requirements, known limitations, test commands, test results, and benchmark results.
20. Do not report a phase as complete solely because files were generated; it is complete only when its tests pass.

## 21.2 Required final report from Agent

The Agent's final response must contain:

- Repository tree.
- Installation and build commands.
- Example source and generated output path.
- Exact supported JavaScript syntax.
- Exact tested Node.js versions.
- VM ABI version and opcode count/catalog location.
- Package format version and section table.
- Whether signing is enabled and which trust model is used.
- Confirmation that no runtime external key is required.
- Confirmation that no plaintext source fallback exists.
- Test summary, including fuzz tests.
- Performance and output-size benchmarks.
- Known limitations and unsupported features.
- Security limitations, especially embedded-key recoverability.

The Agent must not claim “unbreakable”, “impossible to reverse”, or “100% secure”.

---

# 22. Architecture decisions that must not be changed silently

| Decision | v1.0 requirement | Change policy |
|---|---|---|
| Output format | One self-contained `.js` file | Requires explicit approval |
| Runtime key | No external runtime key | Requires explicit approval |
| Application execution | Custom KX-OBH VM | Requires explicit approval |
| Plaintext fallback | Prohibited | Must remain prohibited |
| Primary runtime | Node.js | Requires explicit approval |
| Module system | CommonJS v1.0 | ESM is a separately versioned feature |
| Bytecode instruction | Fixed 12-byte record | Requires VM ABI version change |
| Package header | 64-byte v1.0 header | Requires package format version change |
| Encryption | AES-256-GCM | Requires format/spec change |
| Compression | Brotli or none per section | Requires format/spec change |
| Integrity | SHA-256 metadata + AEAD | Must not be weakened |
| Signature | Optional local Ed25519 release signature | Trust policy must be documented |
| External native modules | Not automatically inlined | Explicit dependency policy required |

---

# 23. Open decisions to resolve before implementation

The following values depend on the deployment environment and must be confirmed or placed in configuration by the Agent. Do not invent them:

1. Exact Node.js major versions supported in production.
2. Maximum accepted input source size and maximum output package size.
3. Whether application external dependencies are installed separately, bundled, or both.
4. The default allowlist of Node built-in modules.
5. Whether local Ed25519 release signing is enabled in the user's workflow.
6. Performance budget for startup, throughput, and memory overhead.
7. Whether TypeScript source input is required in v1.0 or JavaScript-only is acceptable. The default v1.0 specification is JavaScript input only.
8. Whether Windows, Linux, and macOS are all required build hosts. The generated artifact should be tested on each declared target platform.

The Agent should create `DECISIONS.md` with defaults, rationale, owner, and date for every resolved item.

---

# 24. Final product definition

KX-OBH v1.0 is complete when it behaves as a reliable compiler and packager, not merely a source mangler:

- The compiler converts the documented JavaScript subset into custom bytecode.
- The VM executes that bytecode correctly and consistently.
- The package is structured, versioned, authenticated, and bounds-checked.
- The runtime does not need an external decryption key.
- The output is one JavaScript file.
- There is no plaintext source fallback.
- Unsupported syntax fails clearly at build time.
- Security and reverse-engineering limits are honestly documented.
- Every feature is covered by automated tests and reproducible evidence.

**The quality target is correctness first, security engineering second, obfuscation strength third, and performance optimization continuously measured.** A broken or semantically incorrect protected application is not an acceptable security product, regardless of how difficult its output is to read.

---

# Appendix A — Suggested error catalog

| Code | Meaning |
|---|---|
| `KXOBH-E-PARSE` | Source parse failure |
| `KXOBH-E-COMPILER-UNSUPPORTED` | Unsupported syntax |
| `KXOBH-E-COMPILER-SEMANTICS` | Semantic construct cannot be represented safely |
| `KXOBH-E-IMPORT-DENIED` | Import/capability is not allowed |
| `KXOBH-E-PACKAGE-MAGIC` | Invalid package magic |
| `KXOBH-E-PACKAGE-VERSION` | Unsupported package version |
| `KXOBH-E-PACKAGE-BOUNDS` | Invalid or overflowing offset/length |
| `KXOBH-E-PACKAGE-SECTION` | Missing, duplicate, or invalid section |
| `KXOBH-E-SIGNATURE` | Signature missing or invalid under required policy |
| `KXOBH-E-AEAD` | AES-GCM authentication failed |
| `KXOBH-E-COMPRESSION` | Decompression failed or limit exceeded |
| `KXOBH-E-BYTECODE` | Bytecode verification failed |
| `KXOBH-E-ABI` | Unsupported VM ABI |
| `KXOBH-E-NODE-VERSION` | Unsupported Node.js runtime |
| `KXOBH-E-CAPABILITY` | Host capability unavailable or denied |
| `KXOBH-E-VM-LIMIT` | VM execution/resource limit exceeded |
| `KXOBH-E-INTERNAL` | Unexpected internal error |

# Appendix B — Minimum example fixture suite

Create a fixture for every supported feature, including:

1. Arithmetic precedence and coercion.
2. `var` hoisting and function scope.
3. `let`/`const` TDZ and block scope.
4. Nested and mutable closures.
5. Arrow versus regular function `this`.
6. Method receiver preservation.
7. Constructor return-object behavior.
8. Arrays, sparse arrays, and object properties.
9. Getters/setters and computed keys.
10. Short-circuit logical operators.
11. `switch`, nested loops, `break`, and `continue`.
12. Nested `try/catch/finally`, including `return` from `finally`.
13. Promise fulfillment and rejection.
14. `async/await` with nested catch/finally.
15. CommonJS exports, cache behavior, and approved imports.
16. Regex literals and template strings.
17. Source syntax intentionally unsupported, proving build-time rejection.
18. Tampered package, wrong signature, wrong tag, truncated header, overlapping sections, invalid branch, invalid register, and decompression-limit overflow.

# Appendix C — Release checklist

- [ ] Requirement traceability matrix complete.
- [ ] Supported-syntax documentation matches compiler behavior.
- [ ] Compiler unit tests pass.
- [ ] Every implemented opcode has tests.
- [ ] Bytecode verifier tests pass.
- [ ] Package parser fuzz tests pass.
- [ ] AES-GCM and Ed25519 tests pass.
- [ ] No external runtime key is required.
- [ ] No private signing key is in the output.
- [ ] No plaintext source fallback is present.
- [ ] Source-leakage scan passes.
- [ ] Tampered packages fail before VM execution.
- [ ] Node target matrix passes.
- [ ] Performance benchmarks recorded.
- [ ] Dependency/license inventory complete.
- [ ] README and security limitations complete.
- [ ] Final single-file artifact verified and executed in a clean test environment.
