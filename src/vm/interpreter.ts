/**
 * KX-OBH bytecode interpreter (Spec §9).
 *
 * The interpreter is deliberately a plain function-per-opcode dispatch loop over
 * a verified instruction stream. There is no dependency on V8 internals, no
 * cachedData, and no `eval`: the VM is the only thing that executes application
 * logic.
 *
 * Operand roles are fixed by the ABI (see DECODE_ROLES in the ABI document):
 *
 *  - `reg`:     dst is a register, a/b absent, imm32 zero.
 *  - `unary`:   dst <- op(a); b absent, imm32 zero.
 *  - `reg_reg`: dst <- operation(dst-or-a, a, b) exactly as each opcode documents.
 *  - `reg_imm`: dst is a register, imm32 is an index or immediate.
 *  - `branch`: imm32 is a signed instruction offset.
 *  - `cond_branch`: dst is the tested register, imm32 is a signed offset.
 */
import { errors } from '../diagnostics/errors';
import { type Instruction } from '../bytecode/instruction';
import { type Constant } from '../bytecode/constants';
import { EXCEPTION_KIND, type FunctionExceptionTable } from '../bytecode/exceptions';
import { FUNCTION_FLAGS, hasFlag, type FunctionRecord } from '../bytecode/functions';
import {
  createFrame,
  createCell,
  isEnvironmentCell,
  isVmFunction,
  makeVmFunction,
  type Closure,
  type EnvironmentCell,
  type Frame,
} from './frame';
import { type VmLimits } from './limits';

/** A capability the VM may call; the host supplies the implementation. */
export interface Capability {
  readonly name: string;
  readonly async: boolean;
  readonly fn: (...args: unknown[]) => unknown;
}

export interface VmProgram {
  readonly functions: readonly FunctionRecord[];
  /** Decoded instructions per function, from the verifier. */
  readonly functionInstructions: readonly (readonly Instruction[])[];
  /** Materialized constant values, index-aligned with the constant pool. */
  readonly constants: readonly unknown[];
  /**
   * Exception records grouped per function, with program counters already offset
   * into section coordinates.
   *
   * Indexed by function id, so `unwind` reads exactly the records of the frame it
   * is unwinding. A flat list would let a range that merely overlaps this frame's
   * pc span (a neighbouring function's `try`, or a record whose relative pcs were
   * written as absolute ones) capture a throw from the wrong frame. Because the
   * The records are converted back to *function-relative* coordinates here, so
   * `unwind` compares them against the frame's own `pc` directly. Grouping already
   * makes a record unreachable from any other function, so the section base is no
   * longer carrying an origin check; adding it in `unwind` as well would shift
   * every frame that is not the first (base 0) past its own handlers.
   */
  readonly exceptions: readonly FunctionExceptionTable[];
  /** Capabilities by index; the import table maps capability ids to these. */
  readonly capabilities: readonly Capability[];
  readonly globalThisValue: unknown;
  readonly limits: VmLimits;
  /**
   * Maps a stored opcode byte to its canonical id. Resolved once by the verifier;
   * the interpreter never re-derives it per instruction.
   */
  readonly opmap: readonly number[];
}

/** Result of a VM call: either a value or a converted throw completion. */
export type VmCompletion =
  | { readonly kind: 'return'; readonly value: unknown }
  | { readonly kind: 'throw'; readonly error: unknown };

/** Control-flow signal used internally by the dispatch loop. */
export const Signal = {
  Continue: 0,
  Return: 1,
  Throw: 2,
} as const;

export type Signal = (typeof Signal)[keyof typeof Signal];

export interface CallRequest {
  readonly functionId: number;
  readonly closure: Closure;
  readonly args: readonly unknown[];
  readonly thisValue: unknown;
  /**
   * Optional hook to preload the new frame's registers before the first
   * instruction runs.
   *
   * The compiler reaches a function's capture window through `CREATE_CLOSURE`,
   * which reads cells out of the *declaring* frame's registers; nothing in the
   * bytecode seeds the declaring frame, because in a real package the cells are
   * produced by the scope prologue. Hosts and tests that start execution at an
   * arbitrary function (the entry closure, a closure-building fixture) need a way
   * to place those cells, and inventing a `LOAD_CELL`-style opcode for that would
   * add ABI surface the compiler never emits. The hook is host-only: it runs once,
   * before instruction 0, and cannot observe or alter execution afterwards.
   */
  readonly seedRegisters?: (registers: unknown[]) => void;
}

/** Materializes a constant into its runtime value. */
export function materializeConstant(constant: Constant): unknown {
  switch (constant.kind) {
    case 'number':
      return constant.value;
    case 'string':
      return constant.value;
    case 'boolean':
      return constant.value;
    case 'regexp':
      // Constructed per materialization site by the caller when identity matters.
      return { __kxobhRegExp: true, source: constant.source, flags: constant.flags };
    case 'bigint':
      return constant.value;
  }
}

export class Interpreter {
  /** Public so dispatch.ts can read constants, capabilities, and the opcode map. */
  readonly program: VmProgram;
  private depth = 0;
  private executedInstructions = 0;
  private readonly budget: number;

  constructor(program: VmProgram) {
    this.program = program;
    this.budget = program.limits.instructionBudget;
  }

  /** Executes a VM function and converts any thrown value to a completion. */
  call(request: CallRequest): VmCompletion {
    try {
      return { kind: 'return', value: this.execute(request) };
    } catch (error) {
      if (error instanceof VmThrow) return { kind: 'throw', error: error.value };
      // Anything else is a host-level failure (limit, verifier, internal). Those
      // must not be converted into an application-visible throw: they indicate the
      // VM or package is wrong, not the application.
      throw error;
    }
  }

  private execute(request: CallRequest): unknown {
    const { program } = this;
    if (this.depth >= program.limits.maxFrameDepth) {
      throw errors.vmLimit(`frame depth ${this.depth} exceeds limit ${program.limits.maxFrameDepth}`);
    }
    const fn = program.functions[request.functionId];
    if (fn === undefined) {
      throw errors.bytecodeVerify(`function ${request.functionId} does not exist`);
    }
    const instructions = program.functionInstructions[request.functionId];
    if (instructions === undefined) {
      throw errors.bytecodeVerify(`function ${request.functionId} has no verified instruction stream`);
    }

    const frame = createFrame(
      request.functionId,
      request.closure,
      Math.max(fn.registerCount, 1),
      fn.paramCount + fn.localCount,
      request.thisValue,
    );
    for (let i = 0; i < fn.paramCount; i++) {
      frame.slots[i] = request.args[i];
    }
    // Hosts that begin execution inside a function whose capture window has no
    // producer (see `CallRequest.seedRegisters`) seed it here, before any
    // instruction runs, so the seed cannot be mistaken for application state.
    request.seedRegisters?.(frame.registers);
    // JS semantics: `arguments` is a real array-like of the passed values.
    frame.argumentsValue = request.closure.argumentsValue ?? rawArguments(request.args);

    this.depth += 1;
    try {
      return this.run(frame, instructions);
    } finally {
      this.depth -= 1;
    }
  }

  private run(frame: Frame, instructions: readonly Instruction[]): unknown {
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      if (frame.pc < 0 || frame.pc >= instructions.length) {
        // Falling off the end of a function returns undefined, as in JS.
        return undefined;
      }
      if (this.budget > 0 && ++this.executedInstructions > this.budget) {
        throw errors.vmLimit(`instruction budget ${this.budget} exceeded`);
      }
      // Remember which instruction is running so a throw can be attributed to it
      // (`unwind`) even when no handler is entered to re-anchor `enteredAt`.
      frame.enteredAt = frame.pc;
      const instruction = instructions[frame.pc] as Instruction;
      const signal = this.step(frame, instructions, instruction);
      if (signal === Signal.Return) return frame.suspension;
      if (signal === Signal.Throw) {
        if (this.unwind(frame, instructions, frame.suspension)) continue;
        throw new VmThrow(frame.suspension);
      }
    }
  }

  /**
   * Routes a throw completion into the innermost matching exception record.
   * Returns false when no record encloses the current pc, which means the throw
   * escapes this frame.
   */
  private unwind(frame: Frame, _instructions: readonly Instruction[], value: unknown): boolean {
    const table = this.program.exceptions[frame.functionId];
    if (table === undefined) return false;
    const records = table.records;
    // The throw is attributed to the instruction that raised it, not to the one
    // that would run next. They differ for every opcode that advances `pc` before
    // it can throw — notably the arithmetic operators, which do both in one case
    // — and using the incremented pc would skip a protected range that ends at
    // the throwing instruction, letting the exception escape a `try`.
    //
    // `frame.pc - 1` is right for straight-line code. A branch that skipped the
    // protected range (a handler jumping over it, a loop back-edge) records its
    // own index in `enteredAt`, which is then the instruction to blame.
    //
    // Both the pc and the records are in the frame's own coordinate space (its
    // stream starts at 0), so they are compared directly. A section-absolute
    // record, or a section-absolute pc, would make every frame except the first
    // miss its own handlers.
    const framePc = Math.max(0, frame.enteredAt);
    const pc = framePc;
    let best: (typeof records)[number] | undefined;
    for (const record of records) {
      if (pc < record.startPc || pc >= record.endPc) continue;
      // Innermost = smallest protected span covering the pc. The table is grouped
      // per function in table order, so equally sized spans keep a stable winner.
      if (best === undefined || record.endPc - record.startPc < best.endPc - best.startPc) {
        best = record;
      }
    }
    if (best === undefined) return false;
    if (best.kind === EXCEPTION_KIND.CATCH) {
      frame.slots[best.slot] = value;
      // A catch: block begins after the site that threw. A retained pc would
      // make the next `continue` in run() re-execute the throwing instruction
      // once for every handler record, looping forever.
      frame.enteredAt = framePc;
      frame.pc = best.handlerPc;
      return true;
    }
    // finally: run the handler with the throw parked in `pendingThrow`. The
    // handler ends in FINALLY_RESUME, which either re-throws the parked value
    // (normal finally) or resumes the fall-through path (no throw was pending).
    frame.pendingThrow = { value };
    frame.enteredAt = framePc;
    frame.pc = best.handlerPc;
    return true;
  }

  /** Dispatch is implemented in dispatch.ts to keep this file navigable. */
  private step(frame: Frame, instructions: readonly Instruction[], instruction: Instruction): Signal {
    return dispatchImpl(this, frame, instructions, instruction);
  }

  /** Calls a VM closure from inside the VM (CALL / CONSTRUCT / CALL_METHOD). */
  innerCall(callee: unknown, thisValue: unknown, args: readonly unknown[]): unknown {
    if (isVmFunction(callee)) {
      const completion = this.call({
        functionId: callee.closure.functionId,
        closure: callee.closure,
        args,
        thisValue: callee.closure.isArrow ? callee.closure.thisValue : thisValue,
      });
      if (completion.kind === 'throw') throw new VmThrow(completion.error);
      return completion.value;
    }
    if (typeof callee !== 'function') {
      throw new VmThrow(new TypeError(`${describeCallee(callee)} is not a function`));
    }
    // A host function: call it, converting host throws into VM throw completions.
    try {
      return (callee as (...a: unknown[]) => unknown).apply(thisValue, args as unknown[]);
    } catch (error) {
      throw new VmThrow(error);
    }
  }

  /**
   * Creates a closure value for CREATE_CLOSURE, copying a window of environment
   * cells out of the creating frame.
   *
   * The declaring function holds every captured binding as a cell in its own
   * registers (registers `[captureBase, captureBase + captureCount)` of its own
   * frame record describe that window), so `CREATE_CLOSURE` copies the cells at
   * `[windowBase, windowBase + captureCount)` *by reference*. A cell is shared, not
   * copied: two closures over the same binding, and the outer frame itself, must
   * all observe the same mutation (Spec §9.5).
   */
  makeClosureFromFrame(functionId: number, frame: Frame, windowBase: number): unknown {
    const fn = this.program.functions[functionId];
    if (fn === undefined) {
      throw errors.bytecodeVerify(`CREATE_CLOSURE references unknown function ${functionId}`);
    }
    const captures: EnvironmentCell[] = [];
    for (let i = 0; i < fn.captureCount; i++) {
      const holder = frame.registers[windowBase + i];
      if (!isEnvironmentCell(holder)) {
        throw new VmThrow(
          new TypeError(
            `closure of ${describeFunction(fn, functionId)}: capture ${i} (register ${windowBase + i}) does not hold an environment cell`,
          ),
        );
      }
      captures.push(holder);
    }
    return this.makeClosure(functionId, captures, frame.thisValue, frame.argumentsValue, describeFunction(fn, functionId));
  }

  /** Creates a closure value for CREATE_CLOSURE. */
  makeClosure(
    functionId: number,
    captures: readonly EnvironmentCell[],
    thisValue: unknown,
    argumentsValue: unknown,
    name: string,
  ): unknown {
    const fn = this.program.functions[functionId];
    if (fn === undefined) {
      throw errors.bytecodeVerify(`CREATE_CLOSURE references unknown function ${functionId}`);
    }
    const closure: Closure = Object.freeze({
      functionId,
      captures: Object.freeze([...captures]),
      thisValue,
      argumentsValue,
      strict: hasFlag(fn.flags, FUNCTION_FLAGS.STRICT),
      isAsync: hasFlag(fn.flags, FUNCTION_FLAGS.ASYNC),
      isArrow: hasFlag(fn.flags, FUNCTION_FLAGS.ARROW),
      name,
    });
    return makeVmFunction(closure);
  }

  /** Exposed so host bridges can build cells without importing frame directly. */
  static cell(value: unknown, initialized = true): EnvironmentCell {
    return createCell(value, initialized);
  }
}

/** Internal signal carrying a JS throw through the dispatch loop. */
export class VmThrow {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

function describeFunction(_fn: FunctionRecord, functionId: number): string {
  // The display name lives in the constant pool; resolving it here would mean
  // threading the pool through closure creation for a message only. The numeric
  // id is always enough to identify the callee in a diagnostic.
  return `fn${functionId}`;
}

/** True when a register holds an environment cell, instead of a plain value. */

/**
 * Resolves the environment cell a capture-addressing instruction names.
 *
 * The verifier already rejects an index past the function's `captureCount`, but a
 * hand-built closure (a host bridge, the entry closure, a test) can still carry a
 * shorter capture list than the table claims. Turning that into a TypeError keeps
 * the failure observable to `try/catch` instead of letting the next instruction
 * read an `undefined` binding as if it were the captured value.
 */
function rawArguments(args: readonly unknown[]): unknown {
  return Object.freeze([...args]);
}

function describeCallee(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return typeof value;
}

/** Dispatch signature; implemented in dispatch.ts and installed below. */
export type DispatchFn = (
  vm: Interpreter,
  frame: Frame,
  instructions: readonly Instruction[],
  instruction: Instruction,
) => Signal;

let dispatchImpl: DispatchFn = () => {
  throw errors.internal('VM dispatch was used before dispatch.ts was loaded');
};

/** Wires the dispatch implementation (called once when dispatch.ts loads). */
export function installDispatch(fn: DispatchFn): void {
  dispatchImpl = fn;
}
