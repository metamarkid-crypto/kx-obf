# VM ABI AUDIT — canonical 12-byte ABI v1.0

Scope: verify the ten items the CTO directive lists. Files inspected: `src/bytecode/{instruction,opcodes,constants,functions,exceptions,verifier}.ts`, `src/vm/{frame,interpreter,dispatch,program,limits,operations}.ts`, `src/compiler/{index,emitter,regalloc,build}.ts`.

## 1. Instruction size = exactly 12 bytes — CONFIRMED

`src/bytecode/instruction.ts:21` `export const INSTRUCTION_SIZE = 12;`

`encodeInstruction` writes exactly 12 bytes and refuses otherwise (`instruction.ts:74-79`):

```ts
if (offset < 0 || offset + INSTRUCTION_SIZE > target.length) {
  throw errors.internal(`instruction encode: offset ${offset} does not fit ${INSTRUCTION_SIZE} bytes ...`);
}
```

`decodeInstructions` rejects a stream whose length is not a multiple of 12. Test: `test/bytecode/instruction.test.js` — "an instruction is exactly 12 bytes", "a stream whose length is not a multiple of 12 is rejected", "an empty stream decodes to an empty list".

## 2. Little-endian integers — CONFIRMED

`instruction.ts:108-113`:

| Offset | Size | Field | Method | Endianness |
|---:|---:|---|---|---|
| 0 | 1 | `opcode` | `writeUInt8` | n/a |
| 1 | 1 | `flags` | `writeUInt8` | n/a |
| 2 | 2 | `dst` | `writeUInt16LE` | LE |
| 4 | 2 | `a` | `writeUInt16LE` | LE |
| 6 | 2 | `b` | `writeUInt16LE` | LE |
| 8 | 4 | `imm32` | `writeInt32LE` | LE, signed |

Test: "field offsets and little-endian order are fixed"; "a negative immediate round-trips as a signed 32-bit value".

## 3. Opcode identifiers match the canonical catalog — CONFIRMED

`src/bytecode/opcodes.ts:78+` — 78 `spec(id, name, category, operandKind, opts)` entries, ids **1..78, contiguous** (test: "opcode ids are contiguous from 1 so the append-only rule cannot drift"). Ids and mnemonics unique (test: "opcode ids are unique and mnemonics are unique").

Reserved, non-executable (`opcodes.ts:210`): `59 SWITCH_DISPATCH`, `68 AWAIT`, `69 RESOLVE_ASYNC`, `70 REJECT_ASYNC`. The verifier rejects these instead of dispatching (test: "SWITCH_DISPATCH is rejected as reserved rather than dispatched to a runtime throw").

`decodeInstruction` returns the *stored* opcode byte; the program carries an `opmap` (opcode remapping, spec §9.3) applied before verification/dispatch. **Not audited as complete**: the remapping *section* validation (VM_CONFIG parsing, permutation uniqueness, bijectivity) belongs to the package/Phase 7 work and does not exist, so a malformed opmap can only be caught by the verifier's reserved/unknown-id checks, not by a package-level permutation proof. Documented as a limitation, not a pass.

## 4. Compiler operand placement matches VM interpretation — CONFIRMED for the 14 emitted opcodes

Each emitted opcode's operand contract is asserted by `test/vm/opcodes.test.js` and by the differential suite. Spot checks:

| Opcode | Compiler emits (`emitter.ts`) | VM reads (`dispatch.ts`) | Match |
|---|---|---|---|
| `LOAD_NUMBER` | `dst=reg, imm32=n` (line 529) | `case 5: writeReg(dst, imm32)` | yes |
| `LOAD_CONST` | `dst=reg, imm32=poolIndex` (531) | `case 6: pool[imm32]` | yes |
| `LOAD_LOCAL` | `dst=reg, imm32=slot` (373/445/487) | `case 10: writeReg(dst, frame.slots[imm32])` | yes |
| `STORE_LOCAL` | `a=reg, imm32=slot` (436/451/497) | `case 11: frame.slots[imm32] = readReg(a)` | yes |
| `ADD`…`POW` | `dst=a=left, b=right` (588) | `case 24+: dst = a <op> b` | yes |
| `NEGATE`/`POSITIVE` | `dst=reg, a=reg` (546) | unary over `a` | yes |
| `RETURN` | `a=resultReg` (727) | returns `readReg(a)` | yes |

The compiler **accumulates into the left register** and keeps peak pressure at 2 live values (test: "binary arithmetic accumulates into the left register and keeps peak pressure at 2"). Evaluation order is left-first (test: "evaluation order is preserved: the left operand is emitted first").

This is a *placement* confirmation, not a completeness claim: 64 executable opcodes have no compiler path (see `docs/COMPILER_SUPPORT_MATRIX.md` §3).

## 5. Register indexes validated — CONFIRMED

The verifier validates every addressed register against **the function's own** register file, not just the global `maxRegisters` (`verifier.ts:594-600`):

> "Every addressed register must exist in this function's register file. The global limit is not enough: a window that fits `maxRegisters` but …"

Plus call-window validation (`verifier.ts:658`) and argument-count bounding (`MAX_ARGUMENTS = 240`). Tests: "malformed input: a call window that runs past the function register file is rejected", "malformed input: an uninitialized register operand is rejected", "malformed input: an unbounded argument count is rejected".

`ABSENT = 0xffff` is distinct from register 0 (`formatInstruction` test: "renders absent registers distinctly from register 0"), and operand-kind rules reject stray operands ("malformed input: operands on a no-operand opcode are rejected").

## 6. Flags validated — CONFIRMED (and strict by design)

`instruction.ts:34-39`:

```ts
export function allowedFlags(_canonical: number): number { return 0; }
```

`verifier.ts:126-128` rejects any non-zero `flags` byte. ABI v1.0 defines no per-opcode flags, so a zero mask is the correct reading; the code comment states that per-operation flags would need a documented append-only amendment plus a Technical Change Proposal. Test: "flags must fit one byte" path is exercised.

## 7. Immediate signed/unsigned consistency — CONFIRMED

- `imm32` is written/read as **signed** int32 (`writeInt32LE`/`readInt32LE`).
- `LOAD_NUMBER` is the documented exception: it carries a signed int32 *value*; every other immediate is an unsigned index/slot/offset. The verifier rejects an out-of-range or misused immediate per operand kind (`verifier.ts:257` "unary imm32 must be zero"; `:273-277` "LOAD_NUMBER carries a signed 32-bit value … every other …"). Tests: "imm32 must fit signed 32-bit and is not silently truncated", "operands that do not fit their field are refused, not wrapped".

## 8. Branch targets land on instruction boundaries — CONFIRMED

`verifier.ts:574-590`: branch offsets are relative to the branch instruction, in **instructions** (not bytes); the target must stay inside the branch's own function span; a target must be a valid instruction boundary (byte offsets in the function table are snapped to 12-byte multiples — `verifier.ts:517`). Tests:

- "malformed input: a backward branch past the function start is rejected"
- "malformed input: an unconditional branch may target itself"
- "malformed input: a conditional branch may not re-test the same instruction"
- "malformed input: a branch leaving its own function is rejected"
- "malformed input: a branch offset is relative to the branch, not the function"

A self-branch loop is bounded by the instruction budget, never a hang (`test/vm/operators.test.js`).

## 9. Verifier rejects malformed bytecode — CONFIRMED (46 rejection sites)

`verifier.ts:739 export function verifyBytecode(...)`. 46 distinct `throw errors.bytecodeVerify/abi(...)` sites cover: instruction length/alignment, unknown & reserved opcodes, flags, operand kinds, uninitialized registers, pool index bounds, import index bounds, function-index bounds, capture window shape, exception record consistency (function membership, handler pc inside the owning body, catch slot inside the frame, protected range within a function), overlapping function ranges, superlinear/negative lengths, and branch rules.

Verification runs **before** execution: `compileSource` → `buildSections` → program assembly verifies → only a verified program reaches the VM (`src/vm/program.ts`, `interpreter.ts`). Test: "a compiled program is accepted by the same verifier every package faces".

## 10. No second dispatch implementation — CONFIRMED

`src/vm/interpreter.ts:400-407`:

```ts
let dispatchImpl: DispatchFn = () => {
  throw errors.internal('VM dispatch was used before dispatch.ts was loaded');
};
export function installDispatch(fn: DispatchFn): void { dispatchImpl = fn; }
```

`dispatch.ts` installs itself once; `interpreter.ts:268` calls `dispatchImpl(...)`. There is **one** switch over opcodes in the codebase (`src/vm/dispatch.ts`, ~519 lines) and **no** duplicate `switch (instruction.opcode)` anywhere else. The default arm is a trap, so a missing case fails loudly rather than silently.

`dispatch.ts` compiles to `dist/vm/dispatch.js` (446 lines) — checked to ensure the built artifact matches the source surface, not a stale copy.

## Verdict

**Gate 1 — CONDITIONAL PASS.**

Passed: fixed 12-byte encoding, LE, contiguous canonical catalog, verifier-before-execute, single dispatch, register/flag/immediate/branch validation, 74 executable opcodes each executed by a test.

Not a full pass: the opcode-remapping (`opmap`) section has no package-level permutation/bijectivity validation because the package layer does not exist; 4 opcodes are catalogued-but-reserved (correct, but they are not "implemented opcodes"); and 64 of the 74 executable opcodes have no compiler front-end path.

Explicitly **not** claimed: that round-trip encoding proves execution correctness. Round-trip proves serialization consistency only. Execution correctness for implemented opcodes is established separately by `test/vm/opcodes.test.js` (direct dispatch assertions) and `test/diff/arithmetic.test.js` (native-vs-VM comparison), which is a stronger claim than round-trip and is the only basis for the PASS above.
