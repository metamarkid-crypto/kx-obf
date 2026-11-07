/**
 * VM frame and closure model (Spec §9.1, §9.4, §9.5).
 *
 * Values in registers are native JavaScript values. There is no custom
 * number/string representation: the VM must reproduce JavaScript coercion,
 * `-0`, `NaN`, and object identity exactly, and the only reliable way to do that
 * is to let the host engine hold the value.
 *
 * Captured bindings are boxed in `EnvironmentCell` objects so a mutation through
 * one closure is visible through every other closure over the same binding
 * (Spec §9.5). Copying values at closure creation time is explicitly wrong.
 */

/** A mutable lexical binding shared by closures. */
export interface EnvironmentCell {
  /** Brand used by `isEnvironmentCell`; never read by application code. */
  readonly __kxobhCell: true;
  value: unknown;
  /** True once the binding has been initialized (TDZ tracking). */
  initialized: boolean;
}

export function createCell(value: unknown, initialized = true): EnvironmentCell {
  return { __kxobhCell: true, value, initialized };
}

/**
 * True when a register holds an environment cell rather than an ordinary value.
 *
 * `CREATE_CLOSURE` copies cells out of the creating frame's register window; a
 * register that holds a plain value there means the compiler allocated a capture
 * window over storage it never boxed, which would silently give the closure a
 * private copy instead of the shared binding.
 */
export function isEnvironmentCell(value: unknown): value is EnvironmentCell {
  // A cell is identified by its brand marker, not by inspecting `value`/
  // `initialized`: a cell holding `undefined` would otherwise look like every
  // other object, and a plain `{value, initialized}` object written by
  // application code would be mistaken for one.
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __kxobhCell?: unknown }).__kxobhCell === true
  );
}

/** The frame used to build a closure: it provides this-value and captured this. */
export interface Closure {
  readonly functionId: number;
  /** Shared environment cells, addressed by capture index. */
  readonly captures: readonly EnvironmentCell[];
  /** Lexical `this`, already resolved for arrow functions. */
  readonly thisValue: unknown;
  /** `arguments` object, materialized lazily by the caller frame. */
  readonly argumentsValue: unknown;
  /** Strict-mode flag from the function table. */
  readonly strict: boolean;
  readonly isAsync: boolean;
  readonly isArrow: boolean;
  /** Display name for stack traces; absent names become `<anonymous>`. */
  readonly name: string;
}

/**
 * One activation record.
 *
 * `registers` is a dense array sized to the function's registerCount so an
 * out-of-range register is caught at verification time rather than silently
 * reading `undefined` from a sparse array.
 */
export interface Frame {
  readonly functionId: number;
  readonly closure: Closure;
  readonly registers: unknown[];
  readonly slots: unknown[];
  readonly thisValue: unknown;
  argumentsValue: unknown;
  /** Synthetic `arguments` object for the frame, built on first use. */
  pc: number;
  /**
   * Instruction index of the most recently *entered* instruction.
   *
   * Saved by every branch so a throw inside a handler can be attributed to the
   * handler's first instruction (PC-1) even when that instruction skipped the
   * protected range the handler came from; also lets the instruction budget
   * charge a loop that jumps to itself, where PC-1 would name its predecessor.
   */
  enteredAt: number;
  /** Completion state used by the async state machine. */
  completion: 'running' | 'returned' | 'thrown' | 'suspended';
  /** Pending value for suspended frames. */
  suspension: unknown;
  /**
   * Throw completion parked while a `finally` block runs (Spec §9.3).
   *
   * `null` means no throw is pending. A boxed object rather than a bare value so
   * that `throw undefined` is distinguishable from "nothing pending"; without
   * that distinction FINALLY_RESUME could not know whether to resume a throw.
   */
  pendingThrow: { value: unknown } | null;
}

export function createFrame(
  functionId: number,
  closure: Closure,
  registerCount: number,
  slotCount: number,
  thisValue: unknown,
): Frame {
  return {
    functionId,
    closure,
    registers: new Array<unknown>(registerCount).fill(undefined),
    slots: new Array<unknown>(slotCount).fill(undefined),
    thisValue,
    argumentsValue: closure.argumentsValue,
    pc: 0,
    enteredAt: 0,
    completion: 'running',
    suspension: undefined,
    pendingThrow: null,
  };
}

/** A VM function value as seen from JavaScript code inside the VM. */
export interface VmFunctionObject {
  readonly __kxobhVmFunction: true;
  readonly closure: Closure;
  readonly name: string;
}

export function isVmFunction(value: unknown): value is VmFunctionObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __kxobhVmFunction?: unknown }).__kxobhVmFunction === true
  );
}

/**
 * Marks a value that escaped the VM as a callable JavaScript function.
 * Used by CALL when a register holds a host function rather than a VM closure.
 */
export function makeVmFunction(closure: Closure): VmFunctionObject {
  return Object.freeze({
    __kxobhVmFunction: true as const,
    closure,
    name: closure.name,
  });
}
