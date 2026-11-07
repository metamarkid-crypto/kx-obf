# COMPILER SUPPORT MATRIX — Phase 3 reconciliation

Source of truth: `SPEC.md` §"Phase 3 — Compiler subset" (lines 1181–1193) and §9 (VM ABI).
Evidence: `src/compiler/*.ts`, `src/bytecode/opcodes.ts`, `src/vm/dispatch.ts`, `test/`.

Status vocabulary (fixed by the audit directive): `IMPLEMENTED_AND_VERIFIED`, `IMPLEMENTED_NOT_VERIFIED`, `PARTIALLY_IMPLEMENTED`, `NOT_IMPLEMENTED`.

## 1. Entry-point shape constraint (affects every row)

`src/compiler/index.ts:83` `singleFunctionOf()` rejects any program that is not **exactly one** top-level `FunctionDeclaration`/`FunctionExpression`:

```ts
// src/compiler/index.ts:88
if (body.length !== 1) throw errors.unsupported(
  `the Phase 3 emitter compiles exactly one function declaration per file ...`)
```

`emitFunction` then requires the body to end in `return <expression>`, accepts only `ExpressionStatement` and `VariableDeclaration` before it, and rejects parameters (`emitter.test.js` — "parameters are rejected until the scope prologue exists").

Consequence: the compiler is a **numeric-expression slice**, not a Phase 3 compiler. Every row below is bounded by that fact.

## 2. Matrix

| # | Spec requirement (Phase 3) | AST node | Parser accepts | Scope analysis | Compiler lowering | Emitted opcode | VM dispatch | Runtime | Unit test | Differential test | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Literals — Number | `Literal` (number) | yes | n/a | `emitter.ts:529-531` int32 → `LOAD_NUMBER`, else pool | `LOAD_NUMBER` / `LOAD_CONST` | yes (`dispatch.ts` case 5/6) | correct, incl. `-0` via pool | `emitter.test.js` (6 tests) | 80 numeric fixtures | **IMPLEMENTED_AND_VERIFIED** |
| 2 | Literals — `null` | `Literal` (null) | yes | n/a | `emitter.ts:838` | `LOAD_UNDEFINED`/`LOAD_NULL` path | yes (case 2/3) | correct | partial | none | **PARTIALLY_IMPLEMENTED** |
| 3 | Literals — String / Boolean / BigInt / RegExp | `Literal` | yes | — | rejected by `unsupported()` | — | opcode exists but unreachable from source | n/a | `emitter.test.js` "a string literal is rejected" | none | **NOT_IMPLEMENTED** |
| 4 | Variable declarations (`var`) | `VariableDeclaration` | yes | `scope.ts` hoists to function scope | `emitDeclaration` `emitter.ts:766+` | `STORE_LOCAL` | yes (case 11) | correct, eager init order preserved | `scope.test.js`, `emitter.test.js` | indirect (`declarations before the return…`) | **IMPLEMENTED_AND_VERIFIED** |
| 5 | Variable declarations (`let`/`const`) | `VariableDeclaration` | yes | block scope + TDZ flags | `emitDeclaration` + TDZ checks | `STORE_LOCAL` | yes | TDZ/const-write raise positioned build errors | `emitter.test.js` (TDZ, redeclaration) | indirect | **IMPLEMENTED_AND_VERIFIED** |
| 6 | Expressions — numeric binary `+ - * / % **` | `BinaryExpression` | yes | — | `emitter.ts:588` via operator table | `ADD/SUB/MUL/DIV/MOD/POW` | yes (cases 24–29) | bit-exact vs native | `emitter.test.js` | **80 fixtures** in `test/diff/arithmetic.test.js` | **IMPLEMENTED_AND_VERIFIED** |
| 7 | Expressions — numeric unary `- +` | `UnaryExpression` | yes | — | `emitter.ts:546` | `NEGATE` / `POSITIVE` | yes | `-0`, `NaN`, `Infinity` match | `emitter.test.js` | included above | **IMPLEMENTED_AND_VERIFIED** |
| 8 | Expressions — logical `&&` `\|\|` `!` `??` | `LogicalExpression`, `UnaryExpression` | yes | — | **rejected** by `unsupported()` | — | opcodes exist | n/a | rejection test only | none | **NOT_IMPLEMENTED** |
| 9 | Expressions — comparison / equality | `BinaryExpression` | yes | — | **rejected** (operator table is arithmetic-only) | — | opcodes exist + tested at opcode level | n/a | rejection test | none | **NOT_IMPLEMENTED** |
| 10 | Expressions — bitwise / shift | `BinaryExpression` | yes | — | **rejected** | — | opcodes exist | n/a | none | none | **NOT_IMPLEMENTED** |
| 11 | Expressions — conditional `?:`, sequence | `ConditionalExpression`, `SequenceExpression` | yes | — | **rejected** | — | — | n/a | none | none | **NOT_IMPLEMENTED** |
| 12 | Expressions — member / index access | `MemberExpression` | yes | — | **rejected** | — | `GET_PROPERTY` exists | n/a | none | none | **NOT_IMPLEMENTED** |
| 13 | Assignment / compound assignment | `AssignmentExpression` | yes | resolves to declared binding | `emitter.ts:409` | `STORE_LOCAL` (+ arith) | yes | correct | `emitter.test.js` "assignment and compound assignment…" | indirect | **IMPLEMENTED_AND_VERIFIED** |
| 14 | Prefix/postfix `++` `--` | `UpdateExpression` | yes | resolves binding | `emitter.ts:469` | `LOAD_LOCAL`,`LOAD_NUMBER`,`ADD`/`SUB`,`STORE_LOCAL` | yes | correct | `emitter.test.js` | none | **IMPLEMENTED_NOT_VERIFIED** (only prefix tested) |
| 15 | **Functions** (params, bodies) | `FunctionDeclaration` | yes | `scope.ts` declares params/hoists | **params rejected**; single body only | — | `CREATE_CLOSURE` implemented & tested at opcode level | n/a from source | rejection test | none | **NOT_IMPLEMENTED** |
| 16 | **Function expressions / arrow functions** | `FunctionExpression`, `ArrowFunctionExpression` | yes | arrow creates boundary scope (`scope.test.js`) | **rejected** at top level unless sole declaration; no arrow lowering | — | — | n/a | `scope.test.js` only | none | **NOT_IMPLEMENTED** |
| 17 | **Function calls** | `CallExpression` | yes | — | **rejected** | — | `CALL` implemented & tested at opcode level | n/a from source | none | none | **NOT_IMPLEMENTED** |
| 18 | **Closures / capture** | `Identifier` (free) | yes | free identifiers reported | **rejected** (`emitter.test.js`: "an identifier is rejected rather than emitted as an unresolved read") | `LOAD_CAPTURE`/`STORE_CAPTURE` exist and are opcode-tested | yes | cell sharing verified at opcode level | `opcodes.test.js` | none | **NOT_IMPLEMENTED** (compiler side) |
| 19 | **Returns** | `ReturnStatement` | yes | — | single terminal return; bare `return;` rejected (`emitter.ts:662`) | `RETURN` | yes | correct | `emitter.test.js` | yes | **PARTIALLY_IMPLEMENTED** |
| 20 | **Branches** (`if`/`switch`/ternary) | `IfStatement`, `SwitchStatement` | yes | — | **rejected** | — | `JUMP_IF_*` tested at opcode level; `SWITCH_DISPATCH` reserved | n/a from source | none | none | **NOT_IMPLEMENTED** |
| 21 | **Loops** (`for`/`while`/`do`) | `ForStatement`, `WhileStatement`, `DoWhileStatement` | yes | — | **rejected** (`emitter.ts:697` "… statements before the return") | — | back-edge bounding tested (`operators.test.js`) | n/a from source | rejection only | none | **NOT_IMPLEMENTED** |
| 22 | **Arrays** | `ArrayExpression` | yes | — | **rejected** | — | `CREATE_ARRAY` tested at opcode level | n/a from source | none | none | **NOT_IMPLEMENTED** |
| 23 | **Objects** | `ObjectExpression` | yes | — | **rejected** | — | `CREATE_OBJECT` etc. tested at opcode level | n/a from source | none | none | **NOT_IMPLEMENTED** |
| 24 | **Exceptions** (`try`/`catch`/`finally`/`throw`) | `TryStatement`, `ThrowStatement` | yes | `scope.ts` handles catch scope | **rejected** | — | `TRY_BEGIN`/`CATCH_BIND`/`FINALLY_RESUME` tested at opcode level | n/a from source | `operators.test.js` (hand-built) | none | **NOT_IMPLEMENTED** |
| 25 | Unsupported-syntax diagnostics | any | yes | — | `support.ts` + `unsupported()` | — | — | positioned, actionable | `support.test.js` (6), `emitter.test.js` | yes | **IMPLEMENTED_AND_VERIFIED** |

## 3. Opcode reachability

Catalog: **78** opcodes (`opcodes.ts`, ids 1–78, contiguous). Reserved/non-executable: **4** (`59 SWITCH_DISPATCH`, `68 AWAIT`, `69 RESOLVE_ASYNC`, `70 REJECT_ASYNC`). So 74 executable opcodes, all executed by `test/vm/opcodes.test.js` ("every non-reserved catalogued opcode was executed by this file").

Opcodes the **compiler** can emit — 14 of 78:

```
LOAD_UNDEFINED, LOAD_NUMBER, LOAD_CONST, LOAD_LOCAL, STORE_LOCAL,
ADD, SUB, MUL, DIV, MOD, POW, NEGATE, POSITIVE, RETURN
```

The remaining 64 executable opcodes are reachable only from hand-authored bytecode. That is a legitimate ABI property (Phase 2 delivered the VM), but it is **not** Phase 3 delivery: the spec's Phase 3 gate is "differential tests pass for the implemented subset", and 6 of 6 required feature groups are unreachable from source.

## 4. Phase attribution — explicit rejection of the prior report

The prior report is quoted by the CTO as assigning function declarations, closures, object literals and exceptions to Phase 4. That assignment is **wrong** and I do not endorse it:

- `SPEC.md:1183-1191` lists "Functions, closures, calls, and returns", "Branches and loops", "Arrays and objects", "Exceptions" as **Phase 3** deliverables.
- `SPEC.md:1196-1202` reserves Phase 4 for async/await state machine and CommonJS/host capability bridge only.

Correct attribution: those features are **overdue Phase 3 work**, not deferred Phase 4 work.

## 5. Gate 2 verdict

**FAIL.** Four of six required Phase 3 groups are `NOT_IMPLEMENTED`; returns are partial; differential coverage exists for one group (numeric arithmetic). Gate 2 cannot be marked conditional: the spec requires the features, not progress toward them.
