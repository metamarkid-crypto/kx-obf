/**
 * Canonical opcode catalog (Spec §9.3 — VM ABI v1.0).
 *
 * These numeric IDs are the *canonical* ABI. A build may remap them per package
 * (Phase 7), but every stored opcode must map back to exactly one entry here, and
 * the mapping is validated before execution.
 *
 * IDs are append-only within ABI 1.x. Never renumber an existing opcode: the
 * change policy in Spec §22 requires a VM ABI version change.
 */

export const OPERAND_KIND = {
  /** No operands; dst/a/b must be 0xFFFF and imm32 0. */
  NONE: 'none',
  /** dst <- value from imm32 or a register pair. */
  REG: 'reg',
  /** dst <- a OP b, all registers. */
  REG_REG: 'reg_reg',
  /** dst <- unary(a); b is absent and imm32 is zero. */
  UNARY: 'unary',
  /** dst <- operation over registers plus an immediate/index. */
  REG_IMM: 'reg_imm',
  /** dst <- a; b is absent and imm32 is zero (register move). */
  MOVE: 'move',
  /** Value is read from `a`; dst and b are absent and imm32 is zero. */
  SRC_REG: 'src_reg',
  /** Operation stores `a` into the slot/binding named by imm32. */
  IMM_SRC: 'imm_src',
  /** Only imm32 is used (a slot, binding or table index); dst/a/b are absent. */
  IMM: 'imm',
  /** dst <- call(a, args at a+1..a+imm32). */
  CALL: 'call',
  /** dst <- a.b(args at a+1..) with explicit receiver; imm32 is the arg count. */
  CALL_METHOD: 'call_method',
  /** dst <- capability[a](args at b+1..); imm32 is the argument count. */
  CALL_CAPABILITY: 'call_capability',
  /** imm32 is a signed branch offset (unconditional). */
  BRANCH: 'branch',
  /** dst is the tested register; imm32 is a signed branch offset. */
  COND_BRANCH: 'cond_branch',
} as const;

export type OperandKind = (typeof OPERAND_KIND)[keyof typeof OPERAND_KIND];

export interface OpcodeSpec {
  /** Stable canonical id, unique within ABI 1.x. */
  readonly id: number;
  /** Mnemonic, stable and used in disassembly and tests. */
  readonly name: string;
  /** Operand shape, drives the verifier and the encoder. */
  readonly operands: OperandKind;
  /** Family, for documentation and coverage reporting. */
  readonly family: string;
  /** True when the instruction changes the program counter non-linearly. */
  readonly transfer?: boolean;
  /** True when the instruction can throw a JavaScript exception. */
  readonly mayThrow?: boolean;
  /** True when the instruction ends a basic block. */
  readonly terminator?: boolean;
}

const spec = (
  id: number,
  name: string,
  family: string,
  operands: OperandKind,
  flags: { transfer?: boolean; mayThrow?: boolean; terminator?: boolean } = {},
): OpcodeSpec => Object.freeze({ id, name, family, operands, ...flags });

/**
 * The complete v1.0 catalog. Families follow Spec §9.3 group by group.
 *
 * 78 catalogued operations. 74 are implemented by the VM today and covered by a
 * per-opcode test; the remaining four are declared in the append-only ABI but
 * reserved (see RESERVED_OPCODE_IDS) and rejected by the verifier until their
 * phase lands, so no unimplemented operation can reach a release artifact.
 */
export const OPCODES: readonly OpcodeSpec[] = Object.freeze([
  // ---- data movement and constants ----
  spec(1, 'NOP', 'data', OPERAND_KIND.NONE),
  spec(2, 'LOAD_UNDEFINED', 'data', OPERAND_KIND.REG),
  spec(3, 'LOAD_NULL', 'data', OPERAND_KIND.REG),
  spec(4, 'LOAD_BOOL', 'data', OPERAND_KIND.REG_IMM),
  spec(5, 'LOAD_NUMBER', 'data', OPERAND_KIND.REG_IMM),
  spec(6, 'LOAD_CONST', 'data', OPERAND_KIND.REG_IMM),
  spec(7, 'MOVE', 'data', OPERAND_KIND.MOVE),
  spec(8, 'LOAD_THIS', 'data', OPERAND_KIND.REG),
  spec(9, 'LOAD_ARGUMENTS', 'data', OPERAND_KIND.REG),

  // ---- variables and scope ----
  spec(10, 'LOAD_LOCAL', 'scope', OPERAND_KIND.REG_IMM, { mayThrow: true }),
  spec(11, 'STORE_LOCAL', 'scope', OPERAND_KIND.IMM_SRC),
  spec(12, 'LOAD_CAPTURE', 'scope', OPERAND_KIND.REG_IMM, { mayThrow: true }),
  spec(13, 'STORE_CAPTURE', 'scope', OPERAND_KIND.IMM_SRC),
  spec(14, 'LOAD_GLOBAL_CAPABILITY', 'scope', OPERAND_KIND.REG_IMM, { mayThrow: true }),
  spec(15, 'DECLARE_BINDING', 'scope', OPERAND_KIND.IMM),

  // ---- property and object operations ----
  spec(16, 'GET_PROPERTY', 'object', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(17, 'SET_PROPERTY', 'object', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(18, 'DELETE_PROPERTY', 'object', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(19, 'HAS_PROPERTY', 'object', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(20, 'CREATE_OBJECT', 'object', OPERAND_KIND.REG),
  spec(21, 'CREATE_ARRAY', 'object', OPERAND_KIND.REG_IMM, { mayThrow: true }),
  spec(22, 'DEFINE_DATA_PROPERTY', 'object', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(23, 'CREATE_REGEXP', 'object', OPERAND_KIND.REG_IMM, { mayThrow: true }),

  // ---- arithmetic ----
  spec(24, 'ADD', 'arithmetic', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(25, 'SUB', 'arithmetic', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(26, 'MUL', 'arithmetic', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(27, 'DIV', 'arithmetic', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(28, 'MOD', 'arithmetic', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(29, 'POW', 'arithmetic', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(30, 'NEGATE', 'arithmetic', OPERAND_KIND.UNARY, { mayThrow: true }),
  spec(31, 'POSITIVE', 'arithmetic', OPERAND_KIND.UNARY, { mayThrow: true }),
  spec(32, 'BIT_NOT', 'arithmetic', OPERAND_KIND.UNARY, { mayThrow: true }),
  spec(33, 'LOGICAL_NOT', 'arithmetic', OPERAND_KIND.UNARY, { mayThrow: true }),

  // ---- comparison and bitwise ----
  spec(34, 'EQ', 'comparison', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(35, 'STRICT_EQ', 'comparison', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(36, 'NEQ', 'comparison', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(37, 'STRICT_NEQ', 'comparison', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(38, 'LT', 'comparison', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(39, 'LTE', 'comparison', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(40, 'GT', 'comparison', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(41, 'GTE', 'comparison', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(42, 'BIT_AND', 'bitwise', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(43, 'BIT_OR', 'bitwise', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(44, 'BIT_XOR', 'bitwise', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(45, 'SHL', 'bitwise', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(46, 'SHR', 'bitwise', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(47, 'USHR', 'bitwise', OPERAND_KIND.REG_REG, { mayThrow: true }),

  // ---- unary operators ----
  spec(48, 'TYPEOF', 'unary', OPERAND_KIND.UNARY),
  spec(49, 'VOID', 'unary', OPERAND_KIND.UNARY),
  spec(50, 'IN', 'unary', OPERAND_KIND.REG_REG, { mayThrow: true }),
  spec(51, 'INSTANCEOF', 'unary', OPERAND_KIND.REG_REG, { mayThrow: true }),

  // ---- control flow ----
  spec(52, 'JUMP', 'control', OPERAND_KIND.BRANCH, { transfer: true, terminator: true }),
  spec(53, 'JUMP_IF_TRUE', 'control', OPERAND_KIND.COND_BRANCH, { transfer: true, terminator: true }),
  spec(54, 'JUMP_IF_FALSE', 'control', OPERAND_KIND.COND_BRANCH, { transfer: true, terminator: true }),
  spec(55, 'JUMP_IF_NULLISH', 'control', OPERAND_KIND.COND_BRANCH, { transfer: true, terminator: true }),
  spec(56, 'RETURN', 'control', OPERAND_KIND.SRC_REG, { transfer: true, terminator: true }),
  spec(57, 'RETURN_UNDEFINED', 'control', OPERAND_KIND.NONE, { transfer: true, terminator: true }),
  spec(58, 'THROW', 'control', OPERAND_KIND.SRC_REG, { transfer: true, terminator: true }),
  spec(59, 'SWITCH_DISPATCH', 'control', OPERAND_KIND.IMM, { transfer: true, terminator: true }),

  // ---- functions and calls ----
  spec(60, 'CREATE_CLOSURE', 'function', OPERAND_KIND.REG_IMM, { mayThrow: true }),
  spec(61, 'CALL', 'function', OPERAND_KIND.CALL, { mayThrow: true }),
  spec(62, 'CALL_METHOD', 'function', OPERAND_KIND.CALL_METHOD, { mayThrow: true }),
  spec(63, 'CONSTRUCT', 'function', OPERAND_KIND.CALL, { mayThrow: true }),

  // ---- exceptions ----
  spec(64, 'TRY_BEGIN', 'exception', OPERAND_KIND.NONE),
  spec(65, 'TRY_END', 'exception', OPERAND_KIND.NONE),
  spec(66, 'CATCH_BIND', 'exception', OPERAND_KIND.IMM),
  spec(67, 'FINALLY_RESUME', 'exception', OPERAND_KIND.NONE, { transfer: true }),

  // ---- async ----
  spec(68, 'AWAIT', 'async', OPERAND_KIND.UNARY, { mayThrow: true }),
  spec(69, 'RESOLVE_ASYNC', 'async', OPERAND_KIND.SRC_REG),
  spec(70, 'REJECT_ASYNC', 'async', OPERAND_KIND.SRC_REG),

  // ---- host bridge ----
  spec(71, 'IMPORT_CAPABILITY', 'host', OPERAND_KIND.REG_IMM, { mayThrow: true }),
  spec(72, 'CALL_CAPABILITY', 'host', OPERAND_KIND.CALL_CAPABILITY, { mayThrow: true }),

  // ---- operand-window helpers (v1.0 additions, append-only) ----
  spec(73, 'PACK_ARGS', 'data', OPERAND_KIND.REG_IMM, { mayThrow: true }),
  spec(74, 'LOAD_PARAM', 'scope', OPERAND_KIND.REG_IMM),
  spec(75, 'STORE_PARAM', 'scope', OPERAND_KIND.IMM_SRC),
  spec(76, 'LOAD_UPVALUE', 'scope', OPERAND_KIND.REG_IMM, { mayThrow: true }),
  spec(77, 'STORE_UPVALUE', 'scope', OPERAND_KIND.IMM_SRC, { mayThrow: true }),
  spec(78, 'DEBUG_MARK', 'data', OPERAND_KIND.IMM),
]);

/**
 * Capture window of `CREATE_CLOSURE` (ABI v1.1 amendment, appended only).
 *
 * `CREATE_CLOSURE` encodes two numbers and the 12-byte instruction has room for
 * only one 32-bit immediate, so the second number reuses the `b` operand field:
 *
 *   dst    register receiving the closure value
 *   a      must be ABSENT
 *   b      first register of the capture window, or ABSENT for a closure that
 *          captures nothing
 *   imm32  index into the function table
 *
 * The window is `[b, b + captureCount)`, where `captureCount` comes from the
 * function table record of the *callee*: the declaring function holds those
 * variables as environment cells in its own registers and the instruction copies
 * them into the new closure by reference. The verifier rejects a window that is
 * short, out of range, or given for a function that captures nothing.
 */
export const CREATE_CLOSURE_CAPTURE_FIELD = 'b' as const;

/**
 * Catalogued but not yet executed by this VM build.
 *
 * These ids are part of the append-only ABI so the numbering never shifts, but
 * their semantics are not implemented. The verifier rejects a package that uses
 * one, which is the only honest alternative to executing a half-implemented
 * operation. Each id is removed from this set in the phase that implements it.
 */
export const RESERVED_OPCODE_IDS: ReadonlySet<number> = Object.freeze(
  new Set<number>([
    // SWITCH_DISPATCH (59) stays reserved: `switch` is lowered to a verified
    // sequence of comparisons and jumps (see compiler/analysis lowering plan),
    // which needs no table-driven dispatch opcode. It is listed here, not merely
    // documented as unlifted, because an id the catalog advertises as executable
    // but the VM cannot run is exactly what this set exists to prevent: the
    // verifier must reject it instead of dispatching to a case that throws
    // `SWITCH_DISPATCH not lowered` at runtime, which would be a package that
    // verified but could not have been produced by this compiler.
    59, // SWITCH_DISPATCH — lowered by the compiler, never executed as an opcode
    68, // AWAIT           — async state machine (Phase 4)
    69, // RESOLVE_ASYNC   — async state machine (Phase 4)
    70, // REJECT_ASYNC    — async state machine (Phase 4)
  ]),
);

/** True when the canonical id is declared but not executable in this build. */
export function isReservedOpcode(id: number): boolean {
  return RESERVED_OPCODE_IDS.has(id);
}

/** Lookup by canonical id. */
export const OPCODE_BY_ID: ReadonlyMap<number, OpcodeSpec> = new Map(
  OPCODES.map((op) => [op.id, op]),
);
/** Lookup by mnemonic. */
export const OPCODE_BY_NAME: ReadonlyMap<string, OpcodeSpec> = new Map(
  OPCODES.map((op) => [op.name, op]),
);

/** Identity opcode remapping used when a build disables diversification. */
export const IDENTITY_OPMAP: readonly number[] = Object.freeze(
  Array.from({ length: 256 }, (_, i) => i),
);

/** A one-byte opcode value that the identity map resolves to a canonical id. */
export function canonicalId(storedOpcode: number, opmap: readonly number[]): number | null {
  const canonical = opmap[storedOpcode];
  if (canonical === undefined) return null;
  return OPCODE_BY_ID.has(canonical) ? canonical : null;
}

/** Mnemonic for a stored opcode under a given mapping, or null when unknown. */
export function mnemonicOf(storedOpcode: number, opmap: readonly number[] = IDENTITY_OPMAP): string | null {
  const canonical = canonicalId(storedOpcode, opmap);
  if (canonical === null) return null;
  return OPCODE_BY_ID.get(canonical)?.name ?? null;
}
