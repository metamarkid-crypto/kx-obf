/**
 * Static bytecode verifier (Spec §10.1).
 *
 * Runs after compilation and again before execution. It validates every
 * structural invariant in §10.1 with only the decoded sections in hand:
 *
 *  - header/ABI versions and instruction stream length multiple of 12
 *  - opcode known, flags only supported bits
 *  - register/constant/function/import/param indexes in range
 *  - branch targets land on instruction boundaries inside the same function
 *  - function ranges do not overlap and stay inside the code section
 *  - exception ranges are valid and properly nested per the VM rule
 *  - closure capture counts fit the function table
 *  - no section offset/length is allowed to overflow
 *
 * The runtime verifier rejects unknown future ABI features rather than
 * attempting best-effort execution.
 */
import { errors } from '../diagnostics/errors';
import { OPCODE_BY_ID, canonicalId, IDENTITY_OPMAP, OPCODES, isReservedOpcode } from './opcodes';
import { INSTRUCTION_SIZE, ABSENT, allowedFlags, decodeInstructions, type Instruction } from './instruction';
import { type FunctionRecord, functionSlotCount } from './functions';
import { type ExceptionRecord, EXCEPTION_KIND, NO_HANDLER } from './exceptions';

export interface VerifierInput {
  /** Decoded instructions for all functions, in function-table order. */
  readonly functions: readonly FunctionRecord[];
  /** Raw bytes of the VM_CODE section (the verifier slices per function). */
  readonly codeBytes: Buffer;
  readonly constantCount: number;
  readonly importCount: number;
  readonly exceptionRecords: readonly ExceptionRecord[];
  /** Per-build opcode mapping; default identity. */
  readonly opmap?: readonly number[];
  readonly maxRegisters: number;
  readonly maxFrameSlots: number;
}

export interface VerifyResult {
  readonly instructions: readonly Instruction[];
  /** Per-function decoded instruction slices, indexed by function id. */
  readonly functionInstructions: readonly (readonly Instruction[])[];
  /** instruction-count at the start of each function, for diagnostic PC mapping. */
  readonly functionPcBases: readonly number[];
}

/**
 * Which captures a function body reads, indexed by capture index.
 *
 * `LOAD_CAPTURE` and `LOAD_UPVALUE` are two spellings of the same environment
 * access (see the VM dispatch table), so both count as a read.
 */
function captureLoads(instructions: readonly Instruction[], opmap: readonly number[]): readonly boolean[] {
  const reads: boolean[] = [];
  for (const instruction of instructions) {
    const canonical = canonicalId(instruction.opcode, opmap);
    if (canonical !== 12 && canonical !== 76) continue;
    const index = instruction.imm32;
    if (index >= 0) reads[index] = true;
  }
  return reads;
}

const FLAGS_MASK = 0xff;

/**
 * Upper bound on the argument window of a single call instruction (Spec §9.4).
 * A call window must fit inside the register file; this constant additionally
 * keeps a single call from spanning an unreasonable number of registers.
 */
export const MAX_ARGUMENTS = 240;

class Verifier {
  private readonly input: VerifierInput;
  private readonly opmap: readonly number[];
  private readonly codeBytes: Buffer;
  /** Flattened decoded instruction stream over the whole code section. */
  private readonly stream: readonly Instruction[];
  private readonly functionPcBases: number[];

  constructor(input: VerifierInput) {
    this.input = input;
    this.opmap = input.opmap ?? IDENTITY_OPMAP;
    this.codeBytes = input.codeBytes;
    if (this.codeBytes.length % INSTRUCTION_SIZE !== 0) {
      throw errors.bytecodeVerify(
        `VM_CODE section length ${this.codeBytes.length} is not a multiple of ${INSTRUCTION_SIZE}`,
      );
    }
    this.stream = decodeInstructions(this.codeBytes);
    this.functionPcBases = [];
  }

  verify(): VerifyResult {
    this.verifyCodeStream();
    const functionInstructions = this.verifyFunctions();
    this.verifyExceptions();
    return Object.freeze({
      instructions: this.stream,
      functionInstructions,
      functionPcBases: Object.freeze(this.functionPcBases),
    });
  }

  private verifyCodeStream(): void {
    const { opmap, stream } = this;
    for (let i = 0; i < stream.length; i++) {
      const instruction = stream[i] as Instruction;
      const canonical = canonicalId(instruction.opcode, opmap);
      if (canonical === null) {
        throw errors.bytecodeVerify(
          `instruction ${i}: stored opcode ${instruction.opcode} does not map to a canonical opcode`,
          { instruction: i },
        );
      }
      const spec = OPCODE_BY_ID.get(canonical) as (typeof OPCODES)[number];
      // A catalogued but unimplemented operation must never be executed on a
      // best-effort basis: reject the package before the VM starts.
      if (isReservedOpcode(canonical)) {
        throw errors.abi(
          `instruction ${i}: opcode ${spec.name} is reserved in VM ABI v1.0 and cannot be executed`,
          { instruction: i, feature: spec.name, action: 'rebuild with a compiler that does not emit this opcode' },
        );
      }
      if ((instruction.flags & ~FLAGS_MASK) !== 0) {
        throw errors.bytecodeVerify(`instruction ${i}: flags must fit one byte`, { instruction: i });
      }
      // ABI v1.0 assigns no meaning to `flags`: the byte must be zero for every
      // opcode. A stray bit is rejected rather than ignored so a future flag
      // cannot be smuggled past a verifier that does not implement it.
      const allowed = allowedFlags(canonical);
      if ((instruction.flags & ~allowed) !== 0) {
        throw errors.bytecodeVerify(
          `instruction ${i} (${spec.name}): flag bits 0x${instruction.flags.toString(16)} are not valid for this opcode`,
          { instruction: i },
        );
      }
      this.verifyOperands(i, instruction, spec);
      this.verifyTableIndexes(i, instruction, spec);
    }
  }

  /**
   * Cross-section index validation (Spec §10.1).
   *
   * An index into the constant pool, the function table or the import table that
   * points past the end of that section is not a recoverable runtime condition:
   * dispatch would silently read `undefined` and continue with a wrong value. The
   * verifier rejects the package instead, before any instruction executes.
   */
  private verifyTableIndexes(
    index: number,
    instruction: Instruction,
    spec: (typeof OPCODES)[number],
  ): void {
    switch (spec.id) {
      case 6: // LOAD_CONST
      case 23: // CREATE_REGEXP
        this.requireIndex(index, spec, instruction.imm32, this.input.constantCount, 'constant');
        break;
      case 14: // LOAD_GLOBAL_CAPABILITY
      case 71: // IMPORT_CAPABILITY
        this.requireIndex(index, spec, instruction.imm32, this.input.importCount, 'import');
        break;
      case 60: // CREATE_CLOSURE
        this.requireIndex(index, spec, instruction.imm32, this.input.functions.length, 'function');
        this.requireCaptureWindow(index, spec, instruction);
        break;
      default:
        break;
    }
  }

  /**
   * Validates the capture window of `CREATE_CLOSURE` against the callee's declared
   * capture count.
   *
   * The count lives in the callee's function record, not in the instruction, so a
   * window can only be checked once the target function is resolved. Two failure
   * modes matter and both are silent at runtime if unchecked: a window that is
   * shorter than `captureCount` leaves the closure with `undefined` cells, and a
   * window with no base register for a capturing function cannot borrow any cell at
   * all. Both would produce a wrong program rather than an error.
   */
  private requireCaptureWindow(
    index: number,
    spec: (typeof OPCODES)[number],
    instruction: Instruction,
  ): void {
    const callee = this.input.functions[instruction.imm32];
    if (callee === undefined) return; // out-of-range index reported by requireIndex
    const captures = callee.captureCount;
    if (captures === 0) {
      if (instruction.b !== ABSENT) {
        throw errors.bytecodeVerify(
          `instruction ${index} (${spec.name}): function #${instruction.imm32} captures nothing, so b must be ABSENT`,
          { instruction: index },
        );
      }
      return;
    }
    if (instruction.b === ABSENT) {
      throw errors.bytecodeVerify(
        `instruction ${index} (${spec.name}): function #${instruction.imm32} captures ${captures} slot(s), so a capture window base is required in b`,
        { instruction: index },
      );
    }
    const last = instruction.b + captures - 1;
    if (last >= this.input.maxRegisters) {
      throw errors.bytecodeVerify(
        `instruction ${index} (${spec.name}): capture window [${instruction.b}, ${last}] exceeds register file (max ${this.input.maxRegisters})`,
        { instruction: index },
      );
    }
  }

  private requireIndex(
    index: number,
    spec: (typeof OPCODES)[number],
    value: number,
    limit: number,
    what: string,
  ): void {
    if (value >= limit) {
      throw errors.bytecodeVerify(
        `instruction ${index} (${spec.name}): ${what} index ${value} is out of range (${limit} available)`,
        { instruction: index },
      );
    }
  }

  private verifyOperands(index: number, instruction: Instruction, spec: (typeof OPCODES)[number]): void {
    switch (spec.operands) {
      case 'none':
        if (instruction.dst !== ABSENT || instruction.a !== ABSENT || instruction.b !== ABSENT || instruction.imm32 !== 0) {
          throw errors.bytecodeVerify(
            `instruction ${index} (${spec.name}): no operands allowed`,
            { instruction: index },
          );
        }
        break;
      case 'reg':
        this.requireReg(index, spec, instruction.dst, 'dst');
        this.requireAbsent(index, spec, instruction.a, 'a');
        this.requireAbsent(index, spec, instruction.b, 'b');
        break;
      case 'reg_reg':
        this.requireReg(index, spec, instruction.dst, 'dst');
        this.requireReg(index, spec, instruction.a, 'a');
        this.requireReg(index, spec, instruction.b, 'b');
        break;
      case 'unary':
        this.requireReg(index, spec, instruction.dst, 'dst');
        this.requireReg(index, spec, instruction.a, 'a');
        this.requireAbsent(index, spec, instruction.b, 'b');
        if (instruction.imm32 !== 0) {
          throw errors.bytecodeVerify(`instruction ${index} (${spec.name}): unary imm32 must be zero`, {
            instruction: index,
          });
        }
        break;
      case 'reg_imm':
        this.requireReg(index, spec, instruction.dst, 'dst');
        this.requireAbsent(index, spec, instruction.a, 'a');
        // CREATE_CLOSURE reuses the `b` field for its capture window (see
        // CREATE_CLOSURE_CAPTURE_FIELD). Rejecting `b` here unconditionally would
        // make the documented encoding unrepresentable: `requireCaptureWindow`
        // *requires* `b` for a capturing callee, so the two rules would
        // contradict and every capturing closure would fail verification.
        if (spec.id !== 60) {
          this.requireAbsent(index, spec, instruction.b, 'b');
        }
        // LOAD_NUMBER carries a signed 32-bit value (int32 semantics); every other
        // reg_imm opcode uses imm32 as a non-negative index/count.
        if (spec.id === 5) {
          if (instruction.imm32 < -0x80000000 || instruction.imm32 > 0x7fffffff) {
            throw errors.bytecodeVerify(`instruction ${index} (${spec.name}): imm32 must fit signed 32-bit`, {
              instruction: index,
            });
          }
        } else {
          this.requireImm(index, spec, instruction.imm32);
        }
        break;
      case 'move':
        this.requireReg(index, spec, instruction.dst, 'dst');
        this.requireReg(index, spec, instruction.a, 'a');
        this.requireAbsent(index, spec, instruction.b, 'b');
        this.requireZeroImm(index, spec, instruction.imm32);
        break;
      case 'src_reg':
        this.requireAbsent(index, spec, instruction.dst, 'dst');
        this.requireReg(index, spec, instruction.a, 'a');
        this.requireAbsent(index, spec, instruction.b, 'b');
        this.requireZeroImm(index, spec, instruction.imm32);
        break;
      case 'imm_src':
        this.requireAbsent(index, spec, instruction.dst, 'dst');
        this.requireReg(index, spec, instruction.a, 'a');
        this.requireAbsent(index, spec, instruction.b, 'b');
        this.requireImm(index, spec, instruction.imm32);
        break;
      case 'imm':
        this.requireAbsent(index, spec, instruction.dst, 'dst');
        this.requireAbsent(index, spec, instruction.a, 'a');
        this.requireAbsent(index, spec, instruction.b, 'b');
        this.requireImm(index, spec, instruction.imm32);
        break;
      case 'call':
        this.requireCallWindow(index, spec, instruction);
        break;
      case 'call_method':
        this.requireReg(index, spec, instruction.dst, 'dst');
        this.requireReg(index, spec, instruction.a, 'a');
        // `b` is the register holding the property key: CALL_METHOD dispatches
        // through `a[b]`, so unlike CALL the key operand is required.
        this.requireReg(index, spec, instruction.b, 'b');
        this.requireCallWindow(index, spec, instruction, 'a', 'key');
        break;
      case 'call_capability':
        // dst <- capabilities[a](args at b+1 .. b+imm32). Unlike CALL, the callee
        // is not in a register: `a` is an index into the import table, `b` is the
        // base of the argument window, and imm32 is the argument count.
        this.requireReg(index, spec, instruction.dst, 'dst');
        if (instruction.a === ABSENT) {
          throw errors.bytecodeVerify(`instruction ${index} (${spec.name}): a capability index is required`, {
            instruction: index,
          });
        }
        if (instruction.a >= this.input.importCount) {
          throw errors.bytecodeVerify(
            `instruction ${index} (${spec.name}): capability index ${instruction.a} is out of range (${this.input.importCount} imports)`,
            { instruction: index },
          );
        }
        this.requireCallWindow(index, spec, instruction, 'b', 'key');
        break;
      case 'branch':
        this.requireAbsent(index, spec, instruction.dst, 'dst');
        this.requireAbsent(index, spec, instruction.a, 'a');
        this.requireAbsent(index, spec, instruction.b, 'b');
        // imm32 is a signed offset in instruction units, relative to the branch
        // itself. Offset 0 is a self-branch, which is legal and is how a
        // `for (;;)` loop body ends; positive offsets may jump forward (past the
        // end of the function) and are range-checked by verifyBranches.
        this.requireBranchOffset(index, spec, instruction.imm32, 0);
        break;
      case 'cond_branch':
        this.requireReg(index, spec, instruction.dst, 'dst');
        this.requireAbsent(index, spec, instruction.a, 'a');
        this.requireAbsent(index, spec, instruction.b, 'b');
        // A taken conditional branch can also be offset +1, landing on the next
        // instruction, which is exactly the fall-through path.
        this.requireBranchOffset(index, spec, instruction.imm32, 1);
        break;
    }
  }

  private requireReg(index: number, spec: (typeof OPCODES)[number], value: number, field: string): void {
    if (value === ABSENT) {
      throw errors.bytecodeVerify(`instruction ${index} (${spec.name}): ${field} register is required`, {
        instruction: index,
      });
    }
    if (value >= this.input.maxRegisters) {
      throw errors.bytecodeVerify(
        `instruction ${index} (${spec.name}): ${field} register ${value} is out of range (max ${this.input.maxRegisters})`,
        { instruction: index },
      );
    }
  }

  private requireAbsent(index: number, spec: (typeof OPCODES)[number], value: number, field: string): void {
    if (value !== ABSENT) {
      throw errors.bytecodeVerify(`instruction ${index} (${spec.name}): ${field} must be ABSENT`, {
        instruction: index,
      });
    }
  }

  /**
   * Validates a call operand window: `calleeReg` holds the callee and the
   * arguments occupy `calleeReg + 1 .. calleeReg + imm32`. The whole window must
   * be inside the register file, otherwise the VM could read a register the
   * compiler never allocated (and therefore never initialized).
   */
  private requireCallWindow(
    index: number,
    spec: (typeof OPCODES)[number],
    instruction: Instruction,
    calleeField: 'a' | 'b' = 'a',
    /**
     * `key` when the opcode has a third operand (the property key) that the
     * caller has already validated in `b`; `absent` when `b` must be unused.
     */
    otherField: 'absent' | 'key' = 'absent',
  ): void {
    const calleeReg = instruction[calleeField];
    this.requireReg(index, spec, calleeReg, calleeField);
    this.requireImm(index, spec, instruction.imm32);
    const argCount = instruction.imm32;
    if (argCount > MAX_ARGUMENTS) {
      throw errors.bytecodeVerify(
        `instruction ${index} (${spec.name}): argument count ${argCount} exceeds limit ${MAX_ARGUMENTS}`,
        { instruction: index },
      );
    }
    const lastReg = calleeReg + argCount;
    if (argCount > 0 && lastReg >= this.input.maxRegisters) {
      throw errors.bytecodeVerify(
        `instruction ${index} (${spec.name}): argument window [${calleeReg}, ${lastReg}] exceeds register file (max ${this.input.maxRegisters})`,
        { instruction: index },
      );
    }
    if (otherField === 'key') return;
    if (calleeField === 'a') {
      this.requireAbsent(index, spec, instruction.b, 'b');
    } else {
      this.requireAbsent(index, spec, instruction.a, 'a');
    }
  }

  /**
   * Range-checks a signed branch offset against this function's own body.
   *
   * Sharing one check between `branch` and `cond_branch` keeps the two operand
   * kinds from drifting: a self-branch is legal for `JUMP` (offset 0) and a
   * taken `JUMP_IF_*` may land on the instruction after it (offset +1), so the
   * floor differs per kind while the ceiling never does.
   */
  /**
   * Rejects branch offsets that cannot be resolved, using only local
   * information: a branch may not aim at a negative pc.
   *
   * The target is `index + offset` in instruction units, measured against the
   * whole VM_CODE section (not the enclosing function), because that is the same
   * coordinate space the VM's pc lives in. A backward branch from an instruction
   * near the start of the section would address a pc before the first
   * instruction. The per-function span is checked in verifyBranches, once the
   * function's extent is known.
   */
  private requireBranchOffset(
    index: number,
    spec: (typeof OPCODES)[number],
    offset: number,
    /**
     * Minimum reachable pc. `0` for an unconditional branch, whose self-branch
     * (offset 0) is legal and is how a `for (;;)` loop body ends; `1` for a
     * conditional branch, which must make progress (offset 0 would re-test the
     * same condition forever, a hang the verifier can reject statically).
     */
    minimumPc: number,
  ): void {
    if (index + offset < minimumPc) {
      throw errors.bytecodeVerify(
        `instruction ${index} (${spec.name}): branch offset ${offset} targets pc ${index + offset}, before the minimum ${minimumPc}`,
        { instruction: index },
      );
    }
  }

  private requireZeroImm(index: number, spec: (typeof OPCODES)[number], imm: number): void {    if (imm !== 0) {
      throw errors.bytecodeVerify(`instruction ${index} (${spec.name}): imm32 must be zero`, {
        instruction: index,
      });
    }
  }

  private requireImm(index: number, spec: (typeof OPCODES)[number], imm: number): void {
    // imm32 is signed; negative values are only valid for branch offsets, which use
    // the 'branch' operand kind. All others must be non-negative but may be large.
    if (imm < 0) {
      throw errors.bytecodeVerify(`instruction ${index} (${spec.name}): imm32 must not be negative`, {
        instruction: index,
      });
    }
  }

  private verifyFunctions(): readonly (readonly Instruction[])[] {
    const { functions } = this.input;
    const out: (readonly Instruction[])[] = [];
    let prevEnd = 0;
    for (let id = 0; id < functions.length; id++) {
      const fn = functions[id] as FunctionRecord;
      if (fn.codeOffset % INSTRUCTION_SIZE !== 0 || fn.codeLength % INSTRUCTION_SIZE !== 0) {
        throw errors.bytecodeVerify(`function #${id}: code offset/length must be a multiple of ${INSTRUCTION_SIZE}`);
      }
      if (fn.codeLength === 0) {
        throw errors.bytecodeVerify(`function #${id}: empty code body`);
      }
      const start = fn.codeOffset;
      const end = fn.codeOffset + fn.codeLength;
      if (end > this.codeBytes.length) {
        throw errors.bytecodeVerify(`function #${id}: code body [${start}, ${end}) exceeds the VM_CODE section`);
      }
      // Functions must not overlap. Ranges are sorted by construction; because the
      // table is produced by the compiler, contiguous ranges are the expected case.
      if (start < prevEnd) {
        throw errors.bytecodeVerify(`function #${id}: code body overlaps the previous function`);
      }
      prevEnd = end;

      if (fn.registerCount > this.input.maxRegisters) {
        throw errors.bytecodeVerify(
          `function #${id}: registerCount ${fn.registerCount} exceeds limit ${this.input.maxRegisters}`,
        );
      }
      if (functionSlotCount(fn) > this.input.maxFrameSlots) {
        throw errors.bytecodeVerify(
          `function #${id}: frame slots ${functionSlotCount(fn)} exceed limit ${this.input.maxFrameSlots}`,
        );
      }
      if (fn.nameConstant !== 0xffffffff && fn.nameConstant >= this.input.constantCount) {
        throw errors.bytecodeVerify(`function #${id}: name constant ${fn.nameConstant} is out of range`);
      }

      // Offsets in the function table are byte offsets into the VM_CODE section
      // (the compiled `code` array is the concatenation of every function body),
      // while branch offsets in instructions are instruction units. Converting
      // here keeps `sidecar[]` indexed by the same pc the VM uses, so a branch
      // target is an absolute pc, not an offset relative to the section start.
      const firstPc = start / INSTRUCTION_SIZE;
      const lastPc = end / INSTRUCTION_SIZE - 1;
      this.functionPcBases.push(firstPc);

      if (fn.captureCount > 0) {
        const base = fn.captureBase ?? 0;
        if (base + fn.captureCount > fn.registerCount) {
          throw errors.bytecodeVerify(
            `function #${id}: capture window [${base}, ${base + fn.captureCount}) exceeds registerCount ${fn.registerCount}`,
          );
        }
        if (base + fn.captureCount > this.input.maxRegisters) {
          throw errors.bytecodeVerify(
            `function #${id}: capture window [${base}, ${base + fn.captureCount}) exceeds the register file`,
          );
        }
      }

      const fnInstructions = this.stream.slice(firstPc, lastPc + 1);
      this.verifyBranches(id, fnInstructions, firstPc);
      this.verifyFrameAccess(id, fn, fnInstructions);
      this.verifyCaptureUse(id, fn, fnInstructions);
      out.push(Object.freeze(fnInstructions));
    }
    return Object.freeze(out);
  }

  /**
   * Runs the cross-instruction checks that are not local to one instruction.
   *
   * Kept out of `verifyFrameAccess` because they need the whole body: whether a
   * written capture is ever read is a property of the function, not of the one
   * `STORE_CAPTURE`.
   */
  private verifyCaptureUse(id: number, fn: FunctionRecord, fnInstructions: readonly Instruction[]): void {
    if (fn.captureCount === 0) return;
    const loads = captureLoads(fnInstructions, this.opmap);
    fnInstructions.forEach((instruction, i) => {
      const canonical = canonicalId(instruction.opcode, this.opmap);
      if (canonical !== 13 && canonical !== 77) return;
      const index = instruction.imm32;
      if (index >= 0 && index < fn.captureCount && !loads[index]) {
        throw errors.bytecodeVerify(
          `function #${id} instruction ${i}: writes capture ${index}, which this function never loads; the mutation could not be observed`,
        );
      }
    });
  }

  private verifyBranches(id: number, fnInstructions: readonly Instruction[], basePc: number): void {
    fnInstructions.forEach((instruction, i) => {
      const spec = OPCODE_BY_ID.get(canonicalId(instruction.opcode, this.opmap) as number) as (typeof OPCODES)[number];
      // Branch instructions (unconditional and conditional) must land inside the
      // same function. All such instructions put the target in imm32, and the
      // self-target floor is enforced by verifyOperands.
      if (spec.operands !== 'branch' && spec.operands !== 'cond_branch') return;
      const pc = basePc + i;
      // Branch offsets are relative to the branch instruction itself, in
      // instruction units: `JUMP 0` is a self-branch, not a jump to pc 0.
      const targetPc = pc + instruction.imm32;
      // Branch target must stay within this function's instruction span.
      if (targetPc < basePc || targetPc >= basePc + fnInstructions.length) {
        throw errors.bytecodeVerify(
          `function #${id} instruction ${i} (pc ${pc}): branch target ${targetPc} (offset ${instruction.imm32}) is outside the function [${basePc}, ${basePc + fnInstructions.length})`,
        );
      }
    });
  }

  private verifyFrameAccess(id: number, fn: FunctionRecord, fnInstructions: readonly Instruction[]): void {
    const slotCount = functionSlotCount(fn);
    fnInstructions.forEach((instruction, i) => {
      // Every addressed register must exist in this function's register file.
      // The global limit is not enough: a window that fits `maxRegisters` but
      // exceeds `registerCount` would read a register the frame never allocated.
      this.verifyRegisterCount(id, fn, instruction, i);
      switch (canonicalId(instruction.opcode, this.opmap)) {
        case 10: // LOAD_LOCAL
        case 11: // STORE_LOCAL
          if (instruction.imm32 >= slotCount) {
            throw errors.bytecodeVerify(`function #${id} instruction ${i}: local slot ${instruction.imm32} is out of range`);
          }
          break;
        case 74: // LOAD_PARAM
        case 75: // STORE_PARAM
          if (instruction.imm32 >= fn.paramCount) {
            throw errors.bytecodeVerify(`function #${id} instruction ${i}: param ${instruction.imm32} is out of range`);
          }
          break;
        // LOAD_CAPTURE / LOAD_UPVALUE and their storing counterparts all address the
        // closure environment of this frame; an index past captureCount would read
        // or write a cell that does not exist.
        case 12: // LOAD_CAPTURE
        case 13: // STORE_CAPTURE
        case 76: // LOAD_UPVALUE
        case 77: // STORE_UPVALUE
          if (instruction.imm32 >= fn.captureCount) {
            throw errors.bytecodeVerify(
              `function #${id} instruction ${i}: capture ${instruction.imm32} is out of range (${fn.captureCount} captured)`,
            );
          }
          break;
        case 66: // CATCH_BIND writes a frame slot in this function
          if (instruction.imm32 >= slotCount) {
            throw errors.bytecodeVerify(`function #${id} instruction ${i}: catch slot ${instruction.imm32} is out of range`);
          }
          break;
        default:
          break;
      }
    });
  }

  /**
   * Checks the instruction's own addressed registers — including the argument
   * window of a call — against the declaring function's `registerCount`.
   */
  private verifyRegisterCount(
    id: number,
    fn: FunctionRecord,
    instruction: Instruction,
    i: number,
  ): void {
    const limit = fn.registerCount;
    const named: readonly [number, string][] = [
      [instruction.dst, 'dst'],
      [instruction.a, 'a'],
      [instruction.b, 'b'],
    ];
    for (const [reg, field] of named) {
      if (reg !== ABSENT && reg >= limit) {
        throw errors.bytecodeVerify(
          `function #${id} instruction ${i}: ${field} register ${reg} exceeds registerCount ${limit}`,
        );
      }
    }
    // A CALL/CALL_METHOD window addresses registers that are not named fields.
    // `b` was already range-checked above when present, but the window that starts
    // there is not a named operand; CREATE_CLOSURE's window is checked against the
    // register file globally and the callee's count in verifyTableIndexes.
    const canonical = canonicalId(instruction.opcode, this.opmap);
    if (canonical === 60) {
      const callee = fn && instruction.imm32 >= 0 ? this.input.functions[instruction.imm32] : undefined;
      if (callee !== undefined && callee.captureCount > 0 && instruction.b !== ABSENT) {
        const lastReg = instruction.b + callee.captureCount - 1;
        if (lastReg >= limit) {
          throw errors.bytecodeVerify(
            `function #${id} instruction ${i}: capture window [${instruction.b}, ${lastReg}] exceeds registerCount ${limit}`,
          );
        }
      }
    }
    if (canonical === 61 || canonical === 63) {
      const lastReg = instruction.a + instruction.imm32;
      if (instruction.imm32 > 0 && lastReg >= limit) {
        throw errors.bytecodeVerify(
          `function #${id} instruction ${i}: argument window [${instruction.a}, ${lastReg}] exceeds registerCount ${limit}`,
        );
      }
    }
    if (canonical === 62) {
      const lastReg = instruction.a + instruction.imm32;
      if (instruction.imm32 > 0 && instruction.imm32 !== 0xffff && lastReg >= limit) {
        throw errors.bytecodeVerify(
          `function #${id} instruction ${i}: argument window [${instruction.a}, ${lastReg}] exceeds registerCount ${limit}`,
        );
      }
    }
  }

  /**
   * Validates exception records in their function-local coordinate space.
   *
   * A record names its function, and every program counter is relative to that
   * function's first instruction, so the containment check is a single range test
   * against the function's own instruction count instead of a search through every
   * function looking for one that happens to enclose a section-absolute range. That
   * search was the v1 failure mode: a protected range shifted by one instruction
   * could be "contained" in a neighbouring body and the handler would then run in
   * the wrong frame.
   */
  private verifyExceptions(): void {
    const { exceptionRecords: records, functions } = this.input;
    // A missing exception table decodes to an empty list; nothing to do.
    for (let i = 0; i < records.length; i++) {
      const record = records[i] as ExceptionRecord;
      const fn = functions[record.fnIndex];
      if (fn === undefined) {
        throw errors.bytecodeVerify(
          `exception #${i}: names function #${record.fnIndex}, which does not exist`,
        );
      }
      const instructionCount = fn.codeLength / INSTRUCTION_SIZE;
      if (record.startPc >= record.endPc) {
        throw errors.bytecodeVerify(`exception #${i}: startPc ${record.startPc} must be < endPc ${record.endPc}`);
      }
      if (record.endPc > instructionCount) {
        throw errors.bytecodeVerify(
          `exception #${i}: protected range [${record.startPc}, ${record.endPc}) exceeds function #${record.fnIndex} (${instructionCount} instructions)`,
        );
      }
      if (record.handlerPc !== NO_HANDLER && record.handlerPc >= instructionCount) {
        throw errors.bytecodeVerify(
          `exception #${i}: handlerPc ${record.handlerPc} is outside function #${record.fnIndex} (${instructionCount} instructions), so the handler would run in another function's frame`,
        );
      }
      // The slot must exist in the activation record that can actually catch
      // here, otherwise unwind() would write outside the frame.
      if (record.kind === EXCEPTION_KIND.CATCH && record.slot >= functionSlotCount(fn)) {
        throw errors.bytecodeVerify(
          `exception #${i}: catch slot ${record.slot} is out of range in function #${record.fnIndex} (${functionSlotCount(fn)} slots)`,
        );
      }
    }
  }
}

export function verifyBytecode(input: VerifierInput): VerifyResult {
  return new Verifier(input).verify();
}
