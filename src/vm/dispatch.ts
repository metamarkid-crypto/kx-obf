/**
 * Opcode dispatch for the VM (Spec §9.3).
 *
 * Each case handles exactly one canonical opcode. Operand interpretation is
 * fixed by the ABI; the verifier has already proven every register constant and
 * branch target is in range, so the interpreter can trust the stream and focus
 * on semantics. Host errors are converted to VmThrow by the bridge wrappers, and
 * application throws propagate as VmThrow until unwind() parks them in a handler.
 */
import { errors } from '../diagnostics/errors';
import { ABSENT } from '../bytecode/instruction';
import { canonicalId } from '../bytecode/opcodes';
import { isVmFunction, type EnvironmentCell, type Frame } from './frame';
import {
  installDispatch,
  Signal,
  VmThrow,
  type DispatchFn,
} from './interpreter';
import {
  deleteProperty,
  getProperty,
  hasProperty,
  instanceOf,
  logicalNot,
  setProperty,
  typeOf,
} from './operations';

/** Operators that must receive a pair of operands in `a`/`b` registers. */
const BINARY: Readonly<Record<number, (a: unknown, b: unknown) => unknown>> = {
  24: (a, b) => (a as number) + (b as number), // ADD
  25: (a, b) => (a as number) - (b as number), // SUB
  26: (a, b) => (a as number) * (b as number), // MUL
  27: (a, b) => (a as number) / (b as number), // DIV
  28: (a, b) => (a as number) % (b as number), // MOD
  29: (a, b) => (a as number) ** (b as number), // POW
  34: (a, b) => a == b, // EQ (loose equality is intentional here)
  35: (a, b) => a === b, // STRICT_EQ
  36: (a, b) => a != b, // NEQ
  37: (a, b) => a !== b, // STRICT_NEQ
  38: (a, b) => (a as never) < (b as never), // LT
  39: (a, b) => (a as never) <= (b as never), // LTE
  40: (a, b) => (a as never) > (b as never), // GT
  41: (a, b) => (a as never) >= (b as never), // GTE
  42: (a, b) => (a as number) & (b as number), // BIT_AND
  43: (a, b) => (a as number) | (b as number), // BIT_OR
  44: (a, b) => (a as number) ^ (b as number), // BIT_XOR
  45: (a, b) => (a as number) << (b as number), // SHL
  46: (a, b) => (a as number) >> (b as number), // SHR
  47: (a, b) => (a as number) >>> (b as number), // USHR
  50: hasProperty, // IN
  51: instanceOf, // INSTANCEOF
};

/** Unary operators taking a single register in `a`. */
const UNARY: Readonly<Record<number, (a: unknown) => unknown>> = {
  30: (a) => -(a as number), // NEGATE
  31: (a) => +(a as number), // POSITIVE
  32: (a) => ~(a as number), // BIT_NOT
  33: logicalNot, // LOGICAL_NOT
  48: typeOf, // TYPEOF
  49: () => undefined, // VOID
};

/**
 * Applies an operator and converts a native throw into a VM throw completion.
 *
 * Operators are implemented by running the real JavaScript operator (Spec §8.3),
 * so a semantically-required exception — `1 + 2n` mixing BigInt and Number,
 * `obj.x` on `null`, `in` on a primitive — arrives as a native TypeError thrown
 * from the helper. Without this wrapper that error escapes `dispatch`, and the
 * interpreter deliberately rethrows anything that is not a VmThrow as an internal
 * failure. The application would then never see it: `try { 1 + 2n } catch (e) {}`
 * must observe a TypeError, not abort the VM.
 */
function applyOperator(
  operation: (a: unknown, b: unknown) => unknown,
  a: unknown,
  b: unknown,
  frame: Frame,
): unknown {
  try {
    return operation(a, b);
  } catch (error) {
    // The operator advanced nothing: it threw before its `frame.pc += 1`. The
    // throw must therefore be attributed to this instruction, not to the next
    // one, or a protected range ending here would let the exception escape.
    frame.enteredAt = frame.pc;
    throw new VmThrow(error);
  }
}

/**
 * Resolves the environment cell a capture-addressing instruction names.
 *
 * The verifier already rejects an index past the function's `captureCount`, but a
 * hand-built closure (a host bridge, the entry closure, a test) can still carry a
 * shorter capture list than the table claims. Turning that into a TypeError keeps
 * the failure observable to `try/catch` instead of letting the next instruction
 * read an `undefined` binding as if it were the captured value.
 */
function requireCapture(frame: Frame, index: number): EnvironmentCell {
  const cell = frame.closure.captures[index];
  if (cell === undefined) {
    throw new VmThrow(
      new TypeError(`closure of fn${frame.functionId} has no capture ${index}`),
    );
  }
  return cell;
}

function readReg(frame: Frame, reg: number): unknown {
  return frame.registers[reg];
}

function writeReg(frame: Frame, reg: number, value: unknown): void {
  frame.registers[reg] = value;
}

function branch(frame: Frame, standard: boolean, target: number): Signal {
  // The branch itself is the instruction that "entered" the target, so a throw
  // raised by the target instruction is attributed to `target`, not to the last
  // straight-line instruction (the branch itself, which may sit outside the
  // protected range). This matters for the self-branch that ends a `for (;;)`
  // body: without re-anchoring, the second iteration's throwing instruction
  // would be blamed on the branch — outside a `try` that ends at the body — and
  // the exception would escape. Both `if` and `switch` case labels are inside
  // their enclosing range, so a standard branch (pc+1) is equivalent.
  if (!standard) frame.enteredAt = target;
  frame.pc = target;
  return Signal.Continue;
}

/**
 * Runs one instruction, converting a `VmThrow` raised anywhere in it into a
 * throw completion.
 *
 * A throw is a *completion*, not a host failure: the value has to travel back to
 * `run`, which hands it to `unwind` so a `try` can observe it. Raising VmThrow
 * from inside dispatch would instead escape `step` and abort the frame (the
 * interpreter rethrows anything that is not a VmThrow and reports a VmThrow as a
 * throw completion without ever consulting the exception table). Both `applyOperator`
 * and the capability bridge raise VmThrow, so the conversion is centralized here
 * once rather than repeated at every throw site.
 */
export const dispatch: DispatchFn = (vm, frame, instructions, instruction) => {
  try {
    return execute(vm, frame, instructions, instruction);
  } catch (error) {
    if (error instanceof VmThrow) {
      // `unwind` attributes the throw to the instruction that raised it. An
      // operator or bridge that throws before advancing pc leaves pc on the
      // throwing instruction, which is exactly the pc to blame.
      frame.enteredAt = frame.pc;
      frame.suspension = error.value;
      return Signal.Throw;
    }
    throw error;
  }
};

const execute: DispatchFn = (vm, frame, _instructions, instruction) => {
  const canonical = canonicalId(instruction.opcode, vm.program.opmap);
  if (canonical === null) {
    // The verifier already rejects unknown opcodes; this is an internal guard.
    throw new VmThrow(new Error(`unknown opcode ${instruction.opcode}`));
  }

  switch (canonical) {
    case 1: // NOP
      frame.pc += 1;
      return Signal.Continue;

    case 2: // LOAD_UNDEFINED
      writeReg(frame, instruction.dst, undefined);
      frame.pc += 1;
      return Signal.Continue;

    case 3: // LOAD_NULL
      writeReg(frame, instruction.dst, null);
      frame.pc += 1;
      return Signal.Continue;

    case 4: // LOAD_BOOL (imm32 0/1)
      writeReg(frame, instruction.dst, instruction.imm32 !== 0);
      frame.pc += 1;
      return Signal.Continue;

    case 5: // LOAD_NUMBER (imm32)
      writeReg(frame, instruction.dst, instruction.imm32);
      frame.pc += 1;
      return Signal.Continue;

    case 6: // LOAD_CONST
      writeReg(frame, instruction.dst, vm.program.constants[instruction.imm32]);
      frame.pc += 1;
      return Signal.Continue;

    case 7: // MOVE
      writeReg(frame, instruction.dst, readReg(frame, instruction.a));
      frame.pc += 1;
      return Signal.Continue;

    case 8: // LOAD_THIS
      writeReg(frame, instruction.dst, frame.thisValue);
      frame.pc += 1;
      return Signal.Continue;

    case 9: // LOAD_ARGUMENTS
      writeReg(frame, instruction.dst, frame.argumentsValue);
      frame.pc += 1;
      return Signal.Continue;

    case 10: // LOAD_LOCAL
      writeReg(frame, instruction.dst, frame.slots[instruction.imm32]);
      frame.pc += 1;
      return Signal.Continue;

    case 11: // STORE_LOCAL
      frame.slots[instruction.imm32] = readReg(frame, instruction.a);
      frame.pc += 1;
      return Signal.Continue;

    case 12: // LOAD_CAPTURE
      writeReg(frame, instruction.dst, requireCapture(frame, instruction.imm32).value);
      frame.pc += 1;
      return Signal.Continue;

    case 13: // STORE_CAPTURE
      requireCapture(frame, instruction.imm32).value = readReg(frame, instruction.a);
      frame.pc += 1;
      return Signal.Continue;

    case 14: // LOAD_GLOBAL_CAPABILITY
      writeReg(frame, instruction.dst, vm.program.capabilities[instruction.imm32]?.fn);
      frame.pc += 1;
      return Signal.Continue;

    case 15: // DECLARE_BINDING (no-op for now; TDZ handled at load/store)
      frame.pc += 1;
      return Signal.Continue;

    case 16: // GET_PROPERTY
      writeReg(frame, instruction.dst, getProperty(readReg(frame, instruction.a), readReg(frame, instruction.b)));
      frame.pc += 1;
      return Signal.Continue;

    case 17: // SET_PROPERTY
      setProperty(readReg(frame, instruction.a), readReg(frame, instruction.b), readReg(frame, instruction.dst));
      frame.pc += 1;
      return Signal.Continue;

    case 18: // DELETE_PROPERTY
      writeReg(frame, instruction.dst, deleteProperty(readReg(frame, instruction.a), readReg(frame, instruction.b)));
      frame.pc += 1;
      return Signal.Continue;

    case 19: // HAS_PROPERTY
      writeReg(frame, instruction.dst, hasProperty(readReg(frame, instruction.a), readReg(frame, instruction.b)));
      frame.pc += 1;
      return Signal.Continue;

    case 20: // CREATE_OBJECT
      writeReg(frame, instruction.dst, {});
      frame.pc += 1;
      return Signal.Continue;

    case 21: // CREATE_ARRAY
      writeReg(frame, instruction.dst, []);
      frame.pc += 1;
      return Signal.Continue;

    case 22: // DEFINE_DATA_PROPERTY
      Object.defineProperty(readReg(frame, instruction.a), readReg(frame, instruction.b) as string, {
        value: readReg(frame, instruction.dst),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      frame.pc += 1;
      return Signal.Continue;

    case 23: // CREATE_REGEXP
      writeReg(frame, instruction.dst, new RegExp(
        (vm.program.constants[instruction.imm32] as { source?: string }).source ?? '',
        (vm.program.constants[instruction.imm32] as { flags?: string }).flags ?? '',
      ));
      frame.pc += 1;
      return Signal.Continue;

    case 60: // CREATE_CLOSURE (dst, window base in b, function index in imm32)
      // The capture window is a slice of this frame's registers that holds
      // environment cells; `makeClosureFromFrame` copies them by reference, so the
      // closure and the declaring frame share one binding (Spec §9.5).
      writeReg(
        frame,
        instruction.dst,
        vm.makeClosureFromFrame(instruction.imm32, frame, instruction.b === ABSENT ? 0 : instruction.b),
      );
      frame.pc += 1;
      return Signal.Continue;

    case 61: // CALL
      {
        const callee = readReg(frame, instruction.a);
        const argc = instruction.imm32;
        const args: unknown[] = [];
        // Argument window: caller must have packed args; we accept the register
        // window convention where the first arg is in the register after `a`.
        for (let i = 0; i < argc; i++) args.push(readReg(frame, instruction.a + 1 + i));
        const value = vm.innerCall(callee, frame.thisValue, args);
        writeReg(frame, instruction.dst, value);
        frame.pc += 1;
        return Signal.Continue;
      }

    case 62: // CALL_METHOD
      {
        const receiver = readReg(frame, instruction.a);
        const callee = getProperty(receiver, readReg(frame, instruction.b));
        if (isVmFunction(callee) || typeof callee === 'function') {
          const argc = instruction.imm32;
          if (argc === 0xffff) {
            writeReg(frame, instruction.dst, vm.innerCall(callee, receiver, []));
          } else {
            const args: unknown[] = [];
            for (let i = 0; i < argc; i++) args.push(readReg(frame, instruction.a + 1 + i));
            writeReg(frame, instruction.dst, vm.innerCall(callee, receiver, args));
          }
        } else {
          throw new VmThrow(new TypeError(`${typeof callee} is not a function`));
        }
        frame.pc += 1;
        return Signal.Continue;
      }

    case 63: // CONSTRUCT
      {
        const ctor = readReg(frame, instruction.a);
        const argc = instruction.imm32;
        const args: unknown[] = [];
        for (let i = 0; i < argc; i++) args.push(readReg(frame, instruction.a + 1 + i));
        if (typeof ctor === 'function') {
          const instance = new (ctor as new (...a: unknown[]) => unknown)(...args);
          writeReg(frame, instruction.dst, instance);
        } else {
          throw new VmThrow(new TypeError('CONSTRUCT requires a constructor'));
        }
        frame.pc += 1;
        return Signal.Continue;
      }

    case 52: // JUMP
      return branch(frame, false, frame.pc + instruction.imm32);

    case 53: // JUMP_IF_TRUE
      if (readReg(frame, instruction.dst)) return branch(frame, false, frame.pc + instruction.imm32);
      return branch(frame, true, frame.pc + 1);

    case 54: // JUMP_IF_FALSE
      if (!readReg(frame, instruction.dst)) return branch(frame, false, frame.pc + instruction.imm32);
      return branch(frame, true, frame.pc + 1);

    case 55: // JUMP_IF_NULLISH
      {
        const value = readReg(frame, instruction.dst);
        if (value === null || value === undefined) return branch(frame, false, frame.pc + instruction.imm32);
        return branch(frame, true, frame.pc + 1);
      }

    case 56: // RETURN
      frame.suspension = readReg(frame, instruction.a);
      return Signal.Return;

    case 57: // RETURN_UNDEFINED
      frame.suspension = undefined;
      return Signal.Return;

    case 58: // THROW
      // The value travels in suspension: `run` hands `frame.suspension` to
      // unwind(), which either binds it into a catch slot or parks it for a
      // finally block. It must not be cleared here.
      frame.suspension = readReg(frame, instruction.a);
      return Signal.Throw;

    case 59: // SWITCH_DISPATCH
      // Reserved in the ABI (opcodes.ts RESERVED_OPCODE_IDS), so the verifier
      // rejects a package that contains it before execution. This case only
      // exists so the id is total in the switch; reaching it would mean the
      // verifier let a reserved opcode through, which is a VM bug rather than an
      // application error, so it is reported as an internal failure.
      throw errors.internal(
        'SWITCH_DISPATCH (59) is reserved: `switch` is lowered to comparisons and jumps',
      );

    case 64: // TRY_BEGIN
      // Marker emitted by the compiler; exception dispatch runs entirely off the
      // exception table in the interpreter's unwind(), so the marker is a no-op.
      frame.pc += 1;
      return Signal.Continue;

    case 65: // TRY_END
      frame.pc += 1;
      return Signal.Continue;

    case 66: // CATCH_BIND (imm32 = frame slot receiving the caught value)
      // A catch: handler is entered after a throw, and the thrown value was
      // already written into the handler's frame slot by the interpreter's
      // unwind() before control transferred here. The opcode therefore only has
      // to respect the layout (the slot exists — the verifier proved it).
      //
      // It deliberately does not copy `frame.suspension` into the slot: dispatch
      // clears `suspension` on the throw path, so a copy made here would overwrite
      // the bound exception with `undefined` for exactly the host-raised errors
      // (mixing a BigInt with a Number, property reads on null) that must reach
      // `catch (e)` intact.
      frame.pc += 1;
      return Signal.Continue;

    case 67: // FINALLY_RESUME
      {
        const pending = frame.pendingThrow;
        // A finally block always ends here. If a throw is pending, re-throw it;
        // otherwise continue the fall-through path after the try/finally.
        if (pending !== null) {
          frame.pendingThrow = null;
          frame.suspension = pending.value;
          return Signal.Throw;
        }
        frame.pc += 1;
        return Signal.Continue;
      }

    case 72: // CALL_CAPABILITY
      {
        const cap = vm.program.capabilities[instruction.a];
        if (!cap) throw new VmThrow(new Error('capability unavailable'));
        const argc = instruction.imm32;
        const args: unknown[] = [];
        for (let i = 0; i < argc; i++) args.push(readReg(frame, instruction.b + 1 + i));
        try {
          // A plain call: `cap.fn(...)` would bind `this` to the internal
          // capability record, leaking a VM implementation detail into app code.
          const value = cap.fn.call(undefined, ...args);
          if (value && typeof (value as Promise<unknown>).then === 'function') {
            throw new VmThrow(new Error('async capability not supported yet'));
          }
          writeReg(frame, instruction.dst, value);
        } catch (error) {
          throw new VmThrow(error);
        }
        frame.pc += 1;
        return Signal.Continue;
      }

    case 71: // IMPORT_CAPABILITY
      writeReg(frame, instruction.dst, vm.program.capabilities[instruction.imm32]?.fn);
      frame.pc += 1;
      return Signal.Continue;

    case 73: // PACK_ARGS
      frame.pc += 1;
      return Signal.Continue;

    case 74: // LOAD_PARAM
      writeReg(frame, instruction.dst, frame.slots[instruction.imm32]);
      frame.pc += 1;
      return Signal.Continue;

    case 75: // STORE_PARAM
      frame.slots[instruction.imm32] = readReg(frame, instruction.a);
      frame.pc += 1;
      return Signal.Continue;

    // LOAD_UPVALUE / STORE_UPVALUE are the same environment access as the capture
    // pair, kept because the ABI catalogued both spellings. Sharing one helper
    // means a frame whose closure is missing a cell fails the same way either way,
    // instead of one opcode silently reading `undefined` and the other throwing.
    case 76: // LOAD_UPVALUE
      writeReg(frame, instruction.dst, requireCapture(frame, instruction.imm32).value);
      frame.pc += 1;
      return Signal.Continue;

    case 77: // STORE_UPVALUE
      requireCapture(frame, instruction.imm32).value = readReg(frame, instruction.a);
      frame.pc += 1;
      return Signal.Continue;

    case 78: // DEBUG_MARK
      frame.pc += 1;
      return Signal.Continue;

    default: {
      // Binary and unary operators are handled here to keep the switch compact.
      const bin = BINARY[canonical];
      if (bin) {
        writeReg(
          frame,
          instruction.dst,
          applyOperator(bin, readReg(frame, instruction.a), readReg(frame, instruction.b), frame),
        );
        frame.pc += 1;
        return Signal.Continue;
      }
      const un = UNARY[canonical];
      if (un) {
        writeReg(frame, instruction.dst, applyOperator(un, readReg(frame, instruction.a), undefined, frame));
        frame.pc += 1;
        return Signal.Continue;
      }
      throw new VmThrow(new Error(`unhandled opcode ${canonical}`));
    }
  }
};


// Register this module's dispatch with the interpreter at load time.
installDispatch(dispatch);
