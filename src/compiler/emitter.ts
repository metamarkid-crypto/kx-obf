/**
 * Expression emitter (Spec §8.1, §8.3 — Phase 3, first slice).
 *
 * Lowers one parameterless function whose body is a single
 * `return <arithmetic expression>;` into VM bytecode.
 *
 * The slice is deliberately narrow. Everything outside it is rejected with a
 * stable `KXOBH-E-COMPILER-UNSUPPORTED` error carrying the real source position
 * and an action — never silently mistranslated.
 *
 * `+` is accepted only where the compiler can *prove* both operands are Numbers
 * (see `provesNumber`): then AdditiveExpression is `Number::add` and `ADD` is
 * exactly right. Where the proof does not hold, `+` is rejected rather than
 * lowered — `ADD` would concatenate on a string operand and the program would
 * still pass verification while computing the wrong value.
 *
 * Bindings live in the frame's *slot* space, not in the register file. The two are
 * separate arrays on the frame (`registers` and `slots`), so they cannot alias:
 * slots are numbered densely from 0 in declaration order and their count is
 * `localCount`, while the register file is `registerCount` wide and belongs to the
 * allocator alone. `frame.slots` is `paramCount + localCount` deep and the verifier
 * checks every `LOAD_LOCAL` / `STORE_LOCAL` index against exactly that.
 *
 * Reading a binding is `LOAD_LOCAL`; `x = v`, the compound assignments and the
 * prefix updates are `STORE_LOCAL`. A *spilled* temporary is still rejected:
 * `RegisterAllocator` numbers spill slots from `registerCount`, the frame's slot
 * array does not extend there, and reaching one would need the very
 * `LOAD_LOCAL`/`STORE_LOCAL` pair this slice reserves for bindings.
 *
 * Registers come from `RegisterAllocator`, so the emitter cannot hand two live
 * temporaries the same register (Spec §9.1). Constants that do not fit the ABI's
 * int32 immediate travel through the constant pool, owned here so the pool index
 * written into the instruction is final before any section is encoded.
 */
import type { RawNode } from './support';
import { errors, type SourcePosition } from '../diagnostics/errors';
import type { Instruction } from '../bytecode/instruction';
import { OPCODE_BY_NAME } from '../bytecode/opcodes';
import type { Constant } from '../bytecode/constants';
import { RegisterAllocator, RegisterPressureError, type Allocation } from './regalloc';

const ABSENT = 0xffff;

export interface EmitLimits {
  /** Registers the compiler may hand out for expression temporaries. */
  readonly registerCount: number;
  /** Frame slots reserved for spilled temporaries. */
  readonly spillCapacity: number;
}

/**
 * Registers the emitter may use by default.
 *
 * Kept at a quarter of the VM's default `maxRegisters` (256) on purpose: the
 * allocator issues registers by index, so a budget larger than the limit would
 * produce a function the verifier rejects — a build that fails with an
 * "internal" looking bytecode error instead of a positioned compile error.
 * `resolveEmitLimits` below makes that impossible.
 */
export const DEFAULT_EMIT_LIMITS: EmitLimits = Object.freeze({ registerCount: 16, spillCapacity: 16 });

export interface EmittedFunction {
  /** Instruction stream in execution order; pcs are function-relative. */
  readonly instructions: readonly Instruction[];
  /** Registers the frame must provide (peak pressure, at least 1). */
  readonly registerCount: number;
  /**
   * Frame slots the function declares: every bound name lives in one, numbered
   * densely from 0 in declaration order. The frame's slot array is
   * `paramCount + localCount` long, so the verifier accepts exactly these indexes.
   */
  readonly localCount: number;
  /** Constant pool this function references; indexes are already resolved. */
  readonly constants: readonly Constant[];
  /**
   * Bindings in declaration order; `slot` is where the value lives for the whole
   * call (not the register the initialiser happened to use, which is recycled).
   */
  readonly bindings: readonly EmittedBinding[];
}

export interface EmittedBinding {
  readonly name: string;
  readonly kind: 'const' | 'let' | 'var';
  /** Frame slot holding the value, an index into `frame.slots`. */
  readonly slot: number;
}

/**
 * Binds a requested budget to what the VM actually accepts.
 *
 * A caller may pass a larger `registerCount`, but a register file wider than the
 * VM limit can only ever fail verification, so the request is clamped and the
 * reason is attached. Clamping low is safe: fewer registers means earlier
 * rejection of a wide expression (a positioned unsupported error), never wrong
 * code. `spillCapacity` is untouched because this slice emits no spill slot.
 */
export function resolveEmitLimits(
  limits: EmitLimits,
  vmMaxRegisters: number,
): EmitLimits {
  if (!Number.isInteger(vmMaxRegisters) || vmMaxRegisters < 1) {
    throw errors.internal(`emitLimits: vmMaxRegisters must be a positive integer, got ${vmMaxRegisters}`);
  }
  if (limits.registerCount <= vmMaxRegisters) return limits;
  return Object.freeze({ ...limits, registerCount: vmMaxRegisters });
}

/** Canonical opcode id for a mnemonic, so the emitter never hard-codes numbers. */
function opcode(name: string): number {
  const spec = OPCODE_BY_NAME.get(name);
  if (spec === undefined) throw errors.internal(`emitter: opcode ${name} is not in the catalog`);
  return spec.id;
}

function make(opcodeName: string, fields: { dst?: number; a?: number; b?: number; imm32?: number } = {}): Instruction {
  return Object.freeze({
    opcode: opcode(opcodeName),
    flags: 0,
    dst: fields.dst ?? ABSENT,
    a: fields.a ?? ABSENT,
    b: fields.b ?? ABSENT,
    imm32: fields.imm32 ?? 0,
  });
}

function positionOf(node: RawNode, filename: string): SourcePosition {
  const loc = node['loc'] as { start?: { line?: number; column?: number } } | undefined;
  const start = loc?.start;
  if (typeof start?.line !== 'number' || typeof start.column !== 'number') {
    return { file: filename, line: 1, column: 0 };
  }
  return { file: filename, line: start.line, column: start.column };
}

/**
 * Binary arithmetic that is total on Numbers: each of these is `Number::op` for
 * *any* operand pair, because ECMAScript coerces both sides with ToNumber first.
 * `+` is deliberately absent — it is not an arithmetic operator when either
 * operand is a String or an object with a primitive-returning hook, so it is
 * admitted only through the Number proof in `emitExpr`.
 */
const BINARY_OPCODE: Readonly<Record<string, string>> = Object.freeze({
  '-': 'SUB',
  '*': 'MUL',
  '/': 'DIV',
  '%': 'MOD',
  '**': 'POW',
});

/**
 * Decides whether the compiler can prove an expression yields a primitive Number.
 *
 * Only then is `+` lowered as `ADD`. The proof is one-sided on purpose — it may
 * answer `false` for an expression that is in fact a Number (over-rejection), but
 * it must never answer `true` for anything else, because that would emit an
 * addition where JavaScript performs concatenation. The rules below are the
 * syntactic forms for which that cannot happen:
 *
 *   - a resolved binding whose declaration is `var`, `let` or `const` in
 *     declaration order: a declared name can only hold a Number if the program
 *     stored one there, and every store this compiler emits is a proven Number;
 *   - a `Literal` holding a number (`0x10`, `1.5`, `2e3`) or nothing at all
 *     (`null`, which ToNumber maps to `+0`), but not a bigint, whose `+` with a
 *     Number throws;
 *   - a numeric unary operator applied to a proven operand — note the *operand*,
 *     not the result: `undefined` is not a number but `-undefined` is NaN;
 *   - a `+` over two proven operands. ECMAScript admits that spelling only through
 *     `Number::add`, so the result is a Number and nested additions stay
 *     provable: `(1 + 2) + 3` is all Numbers, which is what makes the rule
 *     recursive instead of one level deep;
 *   - a non-`+` arithmetic binary over two proven operands.
 *
 * Parentheses are not a node — the parser does not keep them — so grouping is
 * invisible to the proof, which is exactly right: `(1 + 2)` and `1 + 2` must be
 * lowered identically. Conditionals, calls, member reads, parameters and every
 * binding are unproven: any of them can produce a String, which is exactly the
 * case that turns `+` into concatenation.
 */
function provesNumber(node: RawNode, ctx: Context): boolean {
  switch (node.type) {
    case 'Identifier':
      return ctx.scopes.has(String(node['name']));
    case 'Literal': {
      const value = node['value'];
      return typeof value === 'number' || value === null;
    }
    case 'UnaryExpression': {
      const operator = String(node['operator']);
      if (operator !== '-' && operator !== '+') return false;
      return provesNumber(node['argument'] as RawNode, ctx);
    }
    case 'BinaryExpression': {
      const operator = String(node['operator']);
      if (
        operator !== '+' &&
        operator !== '-' &&
        operator !== '*' &&
        operator !== '/' &&
        operator !== '%' &&
        operator !== '**'
      ) {
        return false;
      }
      return provesNumber(node['left'] as RawNode, ctx) && provesNumber(node['right'] as RawNode, ctx);
    }
    default:
      return false;
  }
}

const UNARY_OPCODE: Readonly<Record<string, string>> = Object.freeze({
  '-': 'NEGATE',
  '+': 'POSITIVE',
});

/**
 * Compound assignment operators, as the binary operator they apply.
 *
 * `x += v` is not `x = x + v` in this compiler: `+` still needs the Number proof,
 * so `+=` is admitted under exactly the same rule as `+` and rejected otherwise.
 */
const COMPOUND_OPERATOR: Readonly<Record<string, string>> = Object.freeze({
  '+=': '+',
  '-=': '-',
  '*=': '*',
  '/=': '/',
  '%=': '%',
  '**=': '**',
});

/** Frames are addressed by u16 slots (`localCount` on the wire), see functions.ts. */
const MAX_FRAME_SLOTS = 0xffff;

/** One bound name, as the emitter sees it. */
interface Binding {
  readonly name: string;
  readonly kind: 'const' | 'let' | 'var';
  /** Frame slot holding the value for the whole call. */
  readonly slot: number;
  /**
   * Lifecycle position in the emitted program, which is what decides whether a read
   * is a temporal-dead-zone throw natively:
   *
   *   - `declared`   — a `let`/`const` declaration has run but its initialiser has
   *                    not finished, i.e. the name is inside its own initialiser or
   *                    in a later declarator of the same statement;
   *   - `initialized`— readable.
   *
   * `var` is published as `initialized`: its hoisting initialises the binding to
   * `undefined` before the body runs, so a read inside its own initialiser is legal
   * (`var x = x` is `undefined`, not an error).
   */
  state: 'declared' | 'initialized';
}

/** Per-function emission state; one instance per function, never shared. */
interface Context {
  readonly filename: string;
  readonly regs: RegisterAllocator;
  readonly limits: EmitLimits;
  readonly out: Instruction[];
  readonly pool: Constant[];
  /** Bound names by identifier; no nested scopes exist in this slice. */
  readonly scopes: Map<string, Binding>;
  /** Slots handed out so far, which is also their count. */
  nextSlot: number;
}

/**
 * Allocates one temporary.
 *
 * Every allocation in this slice is unconditionally live once it exists, so there
 * is no bookkeeping beyond the allocator's own depth — a construct that is
 * abandoned throws out of `emitExpr` entirely and the whole function fails, so no
 * partially-allocated state is ever observed.
 */
function allocateTemporary(ctx: Context): Allocation {
  return ctx.regs.allocate();
}

/**
 * Adds a constant to the pool, returning its index.
 *
 * Reuses an identical entry so `return 1 * 1e300` does not write the same literal
 * twice. Numbers compare by their own equality, which is not enough on its own:
 * `0` and `-0` are equal under `===` but must stay distinguishable, so they get
 * separate entries.
 */
function internConstant(ctx: Context, value: number): number {
  const sameValue = (a: number, b: number): boolean =>
    a === b && (a !== 0 || Object.is(a, b));
  for (let i = 0; i < ctx.pool.length; i++) {
    const entry = ctx.pool[i] as Constant;
    if (entry.kind === 'number' && sameValue(entry.value, value)) return i;
  }
  ctx.pool.push(Object.freeze({ kind: 'number', value: value as number }));
  return ctx.pool.length - 1;
}

/**
 * A spilled temporary needs LOAD_LOCAL/STORE_LOCAL to reach, and this slice emits
 * neither. Reporting it as an unsupported construct is honest; what would be
 * dishonest is handing back a register the allocator never issued, which silently
 * aliases a live temporary.
 */
function asRegister(allocation: Allocation, position: SourcePosition, ctx: Context): number {
  if (allocation.kind === 'register') {
    // Reading a register makes it a live temporary. The allocator alone cannot
    // know that: it hands out registers, and `mark`/`release` are the only things
    // that end an allocation's life. Without this call the register stays marked
    // free, the *next* allocation hands out the same number, and the value is
    // silently overwritten — the aliasing bug Spec §9.1 forbids. `commit` is
    // idempotent, so every read site may call it rather than relying on the one
    // caller that happened to notice.
    ctx.regs.commit(allocation);
    return allocation.reg;
  }
  throw errors.unsupported(
    `the expression exceeds ${ctx.limits.registerCount} registers and would spill to frame slot ${allocation.slot}`,
    position,
    {
      feature: 'register spilling',
      action: 'raise the compiler register budget or flatten the expression',
    },
  );
}

function unsupported(node: RawNode, what: string, ctx: Context, action: string): never {
  throw errors.unsupported(`${what} is not supported by the Phase 3 emitter yet`, positionOf(node, ctx.filename), {
    feature: what,
    action,
  });
}

/**
 * Reads a binding.
 *
 * `var` is declared by a hoisting prologue and is always initialised, so the read
 * cannot throw and lowers to `LOAD_LOCAL`. `let`/`const` are in their temporal
 * dead zone until their own statement runs, and this compiler emits statements in
 * source order with no `try`, so a read before that point is a build error rather
 * than a `ReferenceError` the VM would have to raise at run time. The *value* the
 * binding holds is not the slot's business: every name this compiler declares is
 * written by a proven-Number initialiser and can only be reassigned through
 * `STORE_LOCAL` with a proven Number, which is why `provesNumber` accepts a bound
 * identifier.
 */
function emitBindingRead(node: RawNode, ctx: Context): Allocation {
  const name = String(node['name']);
  const binding = ctx.scopes.get(name);
  if (binding === undefined) {
    return unsupported(
      node,
      `reading binding ${JSON.stringify(name)}`,
      ctx,
      'declare the binding in this function before reading it; free variables need the global scope prologue',
    );
  }
  if (binding.state !== 'initialized') {
    // Natively this is a `ReferenceError` from the temporal dead zone. This compiler
    // emits no handler for it, so lowering the read would return a value where the
    // native program throws — a behavioural difference a build must refuse.
    return unsupported(
      node,
      `reading ${binding.kind} binding ${JSON.stringify(name)} before its declaration has run`,
      ctx,
      'move the read below the declaration; the temporal dead zone throws at run time and this compiler cannot yet emit the throw',
    );
  }
  const target = allocateTemporary(ctx);
  const reg = asRegister(target, positionOf(node, ctx.filename), ctx);
  ctx.out.push(make('LOAD_LOCAL', { dst: reg, imm32: binding.slot }));
  return target;
}

/** Resolves the binding an assignment or update writes. */
function writableBinding(
  node: RawNode,
  target: RawNode,
  operator: string,
  ctx: Context,
): Binding {
  if (target.type !== 'Identifier') {
    unsupported(target, `${target.type} as the target of ${operator}`, ctx, 'assign to a single declared binding: `x ${operator} <expression>`');
  }
  const name = String(target['name']);
  const binding = ctx.scopes.get(name);
  if (binding === undefined) {
    unsupported(target, `${operator} to binding ${JSON.stringify(name)}`, ctx, 'declare the binding in this function before assigning it');
  }
  if (binding.kind === 'const') {
    // Native throws a TypeError here. Emitting the store anyway would let a const
    // change value, so the assignment is rejected at build time instead.
    unsupported(node, `assignment to const binding ${JSON.stringify(name)}`, ctx, 'declare the binding with `let` or `var` if it must be reassigned');
  }
  return binding;
}

/**
 * Lowers `x = v`, `x += v`, `x -= v`, … to the value stored in the binding's slot.
 *
 * The stored value always comes from a proven-Number expression — the same proof
 * as `+` — which is what lets a later read of the binding count as a Number. The
 * value of the assignment expression itself is the computed value: it is returned
 * in its register rather than loaded back from the slot, and the two cannot
 * disagree because nothing runs between the store and the return.
 */
function emitAssignment(node: RawNode, ctx: Context): Allocation {
  const operator = String(node['operator']);
  const target = node['left'] as RawNode;
  const binding = writableBinding(node, target, operator, ctx);
  const right = node['right'] as RawNode;
  if (!provesNumber(right, ctx)) {
    return unsupported(
      right,
      `assigning a value that is not provably a Number (${operator})`,
      ctx,
      'assign an arithmetic expression; a stored value is read back as a Number later',
    );
  }

  let opcodeName: string | undefined;
  if (operator === '=') opcodeName = undefined;
  else {
    opcodeName = BINARY_OPCODE[COMPOUND_OPERATOR[operator] ?? ''];
    if (opcodeName === undefined && COMPOUND_OPERATOR[operator] === '+') opcodeName = 'ADD';
    if (opcodeName === undefined) {
      unsupported(node, `compound assignment ${operator}`, ctx, 'use = += -= *= /= %= **=');
    }
  }

  if (opcodeName === undefined) {
    const value = emitExpr(right, ctx);
    const reg = asRegister(value, positionOf(node, ctx.filename), ctx);
    ctx.out.push(make('STORE_LOCAL', { a: reg, imm32: binding.slot }));
    return value;
  }

  // Compound: the binding is read, the operator applied, the sum stored, and the
  // register the sum sits in is the expression's value.
  const accumulator = ctx.regs.mark();
  const read = allocateTemporary(ctx);
  const reg = asRegister(read, positionOf(target, ctx.filename), ctx);
  ctx.out.push(make('LOAD_LOCAL', { dst: reg, imm32: binding.slot }));
  const rightMark = ctx.regs.mark();
  const value = emitExpr(right, ctx);
  const valueReg = asRegister(value, positionOf(node, ctx.filename), ctx);
  ctx.out.push(make(opcodeName, { dst: reg, a: reg, b: valueReg }));
  ctx.regs.release(rightMark);
  ctx.out.push(make('STORE_LOCAL', { a: reg, imm32: binding.slot }));
  void accumulator;
  return read;
}

/**
 * Lowers `x++`, `x--`, `++x`, `--x`.
 *
 * The result depends on read, increment and store, which JavaScript performs as
 * one operation; nothing may observe the old value in between. Both forms reuse
 * the register that holds the old value as the accumulator (`LOAD_LOCAL`, then
 * `ADD`/`SUB` by one in place, then `STORE_LOCAL`), so the expression needs two
 * live registers and no third one shadowing the old value. Only the *released*
 * value differs, and a released prefix/postfix value is rejected: it would have
 * to be kept alive across a following store / a following statement for no
 * observable difference this compiler can currently produce. Native throws on a
 * `const` target just like an assignment, which is why the same check applies.
 */
function emitUpdate(node: RawNode, ctx: Context): Allocation {
  const operator = String(node['operator']);
  const target = node['argument'] as RawNode;
  if (operator !== '++' && operator !== '--') {
    throw errors.internal(`emitter: unexpected update operator ${operator}`);
  }
  if (node['prefix'] !== true) {
    unsupported(
      node,
      'a postfix update whose old value would have to be kept',
      ctx,
      'write the prefix form (`++x`) or `x = x + 1`',
    );
  }
  const binding = writableBinding(node, target, operator, ctx);
  // Read and increment share one register: the old value is consumed by the ADD.
  const value = allocateTemporary(ctx);
  const reg = asRegister(value, positionOf(target, ctx.filename), ctx);
  ctx.out.push(make('LOAD_LOCAL', { dst: reg, imm32: binding.slot }));
  // `1` lives in a register because the ABI has no "binary op with immediate"
  // form. It is released before the store so it copies the value, not the slot.
  const oneMark = ctx.regs.mark();
  const one = allocateTemporary(ctx);
  const oneReg = asRegister(one, positionOf(node, ctx.filename), ctx);
  ctx.out.push(make('LOAD_NUMBER', { dst: oneReg, imm32: 1 }));
  ctx.out.push(make(operator === '++' ? 'ADD' : 'SUB', { dst: reg, a: reg, b: oneReg }));
  // The constant is consumed by the ADD; only the updated value stays live.
  ctx.regs.release(oneMark);
  ctx.out.push(make('STORE_LOCAL', { a: reg, imm32: binding.slot }));
  return value;
}

function emitExpr(node: RawNode, ctx: Context): Allocation {
  switch (node.type) {
    case 'Identifier':
      return emitBindingRead(node, ctx);

    case 'AssignmentExpression':
      return emitAssignment(node, ctx);

    case 'UpdateExpression':
      return emitUpdate(node, ctx);

    case 'Literal': {
      const raw = node['value'];
      // `null` is not a Number, but ToNumber(null) is +0 and it has no `+` hook of
      // its own, so it is lowered as the number it coerces to. Every other
      // non-number literal (string, boolean, bigint, regexp) keeps its own type
      // and is rejected: a string literal is the one value that makes `+` a
      // concatenation instead of an addition.
      if (raw !== null && typeof raw !== 'number') {
        unsupported(node, `${typeof raw} literal`, ctx, 'return a numeric expression');
      }
      const number = raw === null ? 0 : (raw as number);
      const target = allocateTemporary(ctx);
      const pos = positionOf(node, ctx.filename);
      const reg = asRegister(target, pos, ctx);
      // The immediate form carries an int32. Anything else — fractions, -0, NaN,
      // magnitudes past int32 — must be bit-exact, so it goes through the pool.
      if (Number.isInteger(number) && number >= -0x80000000 && number <= 0x7fffffff && !Object.is(number, -0)) {
        ctx.out.push(make('LOAD_NUMBER', { dst: reg, imm32: number | 0 }));
      } else {
        ctx.out.push(make('LOAD_CONST', { dst: reg, imm32: internConstant(ctx, number) }));
      }
      return target;
    }

    case 'UnaryExpression': {
      const op = String(node['operator']);
      const opcodeName = UNARY_OPCODE[op];
      if (opcodeName === undefined) unsupported(node, `unary ${op}`, ctx, 'use - or + on a numeric expression');
      const operandNode = node['argument'] as RawNode;
      const operand = emitExpr(operandNode, ctx);
      const pos = positionOf(node, ctx.filename);
      const reg = asRegister(operand, pos, ctx);
      // The operand is read exactly once and never needed again, so it is its own
      // destination: a second register would only raise peak pressure.
      ctx.out.push(make(opcodeName as string, { dst: reg, a: reg }));
      return operand;
    }

    case 'BinaryExpression': {
      const op = String(node['operator']);
      let opcodeName = BINARY_OPCODE[op];
      if (opcodeName === undefined && op === '+') {
        // `+` runs AdditiveExpression, which concatenates unless both operands
        // become primitive Numbers. ADD is the faithful lowering only when that is
        // guaranteed, so the proof is required here rather than assumed. An
        // unproven `+` is rejected: emitting ADD anyway would pass verification
        // and compute the wrong value.
        if (!provesNumber(node['left'] as RawNode, ctx) || !provesNumber(node['right'] as RawNode, ctx)) {
          unsupported(
            node,
            'binary + where an operand is not provably a Number',
            ctx,
            'use - * / % **, or apply unary + / - to the operands so both sides are Numbers',
          );
        }
        opcodeName = 'ADD';
      }
      if (opcodeName === undefined) {
        unsupported(node, `binary ${op}`, ctx, 'use an arithmetic operator (- * / % **, or + on Numbers)');
      }
      // Left before right: evaluation order is observable, so operands are never
      // swapped to save a register — and an operator that throws stops before the
      // right operand runs natively, which the caller checks against operands that
      // can throw.
      const left = emitExpr(node['left'] as RawNode, ctx);
      const leftReg = asRegister(left, positionOf(node, ctx.filename), ctx);
      // Mark *after* the left operand so releasing back to it keeps `left`.
      const rightMark = ctx.regs.mark();
      const right = emitExpr(node['right'] as RawNode, ctx);
      const rightReg = asRegister(right, positionOf(node, ctx.filename), ctx);
      // Accumulate into the left register, then release the right operand *now*.
      // Its value is consumed by this instruction and the caller cannot observe
      // it, so holding it until the enclosing expression returns would make every
      // nested binary expression cost one register per level (`2*3*4` would need
      // three) for no correctness benefit. Releasing middle-of-statement is
      // exactly what the allocator's mark/release contract is for.
      ctx.out.push(make(opcodeName as string, { dst: leftReg, a: leftReg, b: rightReg }));
      ctx.regs.release(rightMark);
      return left;
    }

    default:
      return unsupported(
        node,
        node.type,
        ctx,
        'reduce the returned expression to numeric literals and arithmetic operators',
      );
  }
}

/**
 * Emits one function declaration/expression body.
 *
 * A body is `const`/`let`/`var` declarations followed by exactly one
 * `return <expression>;`.
 *
 * A declaration gives its name a frame slot, and every later read of that name is a
 * `LOAD_LOCAL` from it. A `let`/`const` read before its own initialiser has run is
 * rejected rather than lowered: natively that is a temporal-dead-zone throw, and
 * this compiler emits no exception handling yet, so lowering it would produce a
 * program that returns a value where the native one throws. Writing a `const` is
 * rejected for the same reason (native raises a `TypeError`).
 *
 * Slots are handed out as declarations are emitted, so `localCount` is known only
 * at the end of the body; nothing needs it earlier, because a slot index is what
 * instructions carry and the frame is sized once from the finished function.
 */
export function emitFunction(
  node: RawNode,
  filename = '<input>',
  limits: EmitLimits = DEFAULT_EMIT_LIMITS,
): EmittedFunction {
  const params = (node['params'] as readonly RawNode[] | undefined) ?? [];
  if (params.length !== 0) {
    throw errors.unsupported(
      `parameters are not supported by the Phase 3 emitter yet (${params.length} declared)`,
      positionOf(node, filename),
      {
        feature: 'function parameters',
        action: 'declare the function without parameters; parameter binding lands with the scope prologue',
      },
    );
  }

  const body = node['body'] as RawNode | undefined;
  if (!body || body.type !== 'BlockStatement') {
    throw errors.unsupported(
      'an expression-bodied function is not supported by the Phase 3 emitter yet',
      positionOf(node, filename),
      { feature: 'expression-bodied function', action: 'wrap the body in a block: { return <expression>; }' },
    );
  }

  const statements = (body['body'] as unknown as readonly RawNode[] | undefined) ?? [];
  if (statements.length === 0) {
    throw errors.unsupported(
      'an empty function body is not supported by the Phase 3 emitter yet',
      positionOf(body, filename),
      { feature: 'implicit return', action: 'finish the body with `return <arithmetic expression>;`' },
    );
  }
  const last = statements[statements.length - 1] as RawNode;
  if (last.type !== 'ReturnStatement') {
    throw errors.unsupported(
      `the Phase 3 emitter compiles statements followed by one return (the last statement is ${last.type})`,
      positionOf(last, filename),
      { feature: 'statement sequences', action: 'finish the function with `return <arithmetic expression>;`' },
    );
  }
  const argument = last['argument'] as RawNode | null | undefined;
  if (!argument) {
    throw errors.unsupported('a bare `return;` has no expression to lower yet', positionOf(last, filename), {
      feature: 'bare return',
      action: 'return an arithmetic expression instead',
    });
  }

  const ctx: Context = {
    filename,
    regs: new RegisterAllocator({ registerCount: limits.registerCount, spillCapacity: limits.spillCapacity }),
    limits,
    out: [],
    pool: [],
    scopes: new Map(),
    nextSlot: 0,
  };

  const bindings: EmittedBinding[] = [];
  // Every statement before the return runs for its effect. Variable declarations
  // are emitted because their initialisers are real expressions: that preserves
  // JavaScript's eager evaluation order, so an initialiser that throws does so
  // where the native program would. Skipping them as "dead" would be a
  // behavioural change the moment an initialiser has a side effect.
  //
  // A bare expression statement is emitted for the same reason (`x = 1;` and
  // `void 0;` are not dead, they compute). Statements with no expression in this
  // slice — a loop, an `if`, a nested block — are rejected with their position
  // instead of being silently dropped.
  for (const statement of statements.slice(0, -1)) {
    if (statement.type === 'ExpressionStatement') {
      const expression = statement['expression'] as RawNode | undefined;
      if (expression) emitExpr(expression, ctx);
      continue;
    }
    if (statement.type !== 'VariableDeclaration') {
      unsupported(
        statement,
        `${statement.type} statements before the return`,
        ctx,
        'use only declarations and expressions before the return; control flow is not lowered yet',
      );
    }
    emitDeclaration(statement, ctx, bindings);
  }

  let result: Allocation;
  try {
    result = emitExpr(argument, ctx);
  } catch (cause) {
    // An exhausted register file is a property of the source, so it is reported as
    // an unsupported construct at the expression that overflowed it. The typed
    // RegisterPressureError stays reachable as `cause`; what matters is that a
    // build fails with a positioned diagnostic instead of a bare RangeError.
    if (!(cause instanceof RegisterPressureError)) throw cause;
    throw errors.unsupported(
      `the expression needs more than ${limits.registerCount} registers and ${limits.spillCapacity} spill slots`,
      positionOf(argument, filename),
      {
        feature: 'register pressure',
        action: 'raise the compiler register budget or flatten the expression',
      },
    );
  }
  // `return` reads its operand in `a` and carries no destination register.
  ctx.out.push(make('RETURN', { a: asRegister(result, positionOf(body, filename), ctx) }));

  const registerCount = Math.max(1, ctx.regs.peakInUse);
  // Exactly the declared bindings: nothing else names a slot. A temporary that the
  // allocator spilled would have named one, but reaching it needs the
  // LOAD_LOCAL/STORE_LOCAL pair this slice reserves for bindings, so a spill is a
  // build failure and never widens the frame.
  const localCount = ctx.nextSlot;
  if (localCount > MAX_FRAME_SLOTS) {
    throw errors.internal(`emitter: ${localCount} frame slots exceed the ${MAX_FRAME_SLOTS} a frame record can address`);
  }

  return Object.freeze({
    instructions: Object.freeze(ctx.out),
    registerCount,
    localCount,
    constants: Object.freeze(ctx.pool),
    bindings: Object.freeze(bindings),
  });
}

/**
 * Emits a variable declaration as its scope entry plus its initialisers.
 *
 * The binding gets its frame slot *before* the initialiser is emitted, because a
 * `var` initialiser may already read the binding (`var x = x || 1`). `let`/`const`
 * stay in their temporal dead zone until the statement's *last* initialiser has
 * run natively — `let a = b, b = 1` throws — so they are published only after every
 * initialiser of the statement was emitted.
 *
 * A declarator without an initialiser gets a slot initialised by a `LOAD_UNDEFINED`
 * store rather than no code at all: the frame starts as `undefined` for a reason,
 * but a slot the caller never wrote would make the read depend on frame zeroing
 * instead of on the language's `var x;` initialisation.
 *
 * Destructuring is rejected here rather than partially handled: `const [a] = …`
 * needs iteration support that does not exist yet, and emitting only its
 * initialiser would compute a value the program appears to bind but does not.
 */
function emitDeclaration(node: RawNode, ctx: Context, bindings: EmittedBinding[]): void {
  const kind = String(node['kind']);
  if (kind !== 'const' && kind !== 'let' && kind !== 'var') {
    throw errors.internal(`emitter: unexpected declaration kind ${kind}`);
  }
  const declarators = (node['declarations'] as readonly RawNode[] | undefined) ?? [];
  if (declarators.length === 0) {
    throw errors.internal('emitter: variable declaration without declarators');
  }

  // Pass 1 — allocate every slot and publish every name before any initialiser is
  // emitted. `let a = 1, b = a` must compile, which means `a` has to be readable
  // while `b`'s initialiser runs; and `let a = b, b = 1` must fail, which means `b`
  // has to exist but stay unreadable until “its own” initialiser has run. The
  // `state` per binding carries exactly that: `var` is readable immediately (its
  // hoisting initialises it to `undefined`), `let`/`const` only become readable as
  // their own initialiser completes.
  const pending: Binding[] = [];
  for (const declarator of declarators) {
    const id = declarator['id'] as RawNode;
    if (id.type !== 'Identifier') {
      unsupported(
        id,
        `${id.type} destructuring in a declaration`,
        ctx,
        'declare one binding per identifier: `const x = <expression>;`',
      );
    }
    const name = String(id['name']);
    if (ctx.scopes.has(name)) {
      // Native throws a SyntaxError for a redeclaration. Rejecting it here keeps
      // the emitted code from silently sharing one slot between two bindings.
      unsupported(
        id,
        `redeclaring binding ${JSON.stringify(name)} in the same scope`,
        ctx,
        'rename the second binding; this slice has no nested scopes',
      );
    }
    const slot = ctx.nextSlot;
    const binding: Binding = {
      name,
      kind: kind as Binding['kind'],
      slot,
      state: kind === 'var' ? 'initialized' : 'declared',
    };
    ctx.nextSlot += 1;
    bindings.push(Object.freeze({ name, kind: kind as EmittedBinding['kind'], slot }));
    ctx.scopes.set(name, binding);
    pending.push(binding);
  }

  // Pass 2 — run the initialisers in source order, storing each result into its
  // slot and only then making the binding readable, which is the exact point
  // native's temporal dead zone lifts for that name.
  for (let i = 0; i < declarators.length; i++) {
    const declarator = declarators[i] as RawNode;
    const binding = pending[i] as Binding;
    const init = declarator['init'] as RawNode | null | undefined;
    if (!init) {
      if (kind === 'const') {
        // Unreachable through the parser (a const without an initialiser is a
        // syntax error); kept so a hand-built AST fails as a positioned
        // diagnostic rather than an internal error.
        throw errors.unsupported(
          'const declarations require an initialiser',
          positionOf(declarator, ctx.filename),
          { feature: 'const without initialiser', action: 'give the binding an initialiser' },
        );
      }
      const target = allocateTemporary(ctx);
      const reg = asRegister(target, positionOf(declarator, ctx.filename), ctx);
      ctx.out.push(make('LOAD_UNDEFINED', { dst: reg }));
      ctx.out.push(make('STORE_LOCAL', { a: reg, imm32: binding.slot }));
      binding.state = 'initialized';
      continue;
    }
    const allocation = emitExpr(init, ctx);
    const reg = asRegister(allocation, positionOf(declarator, ctx.filename), ctx);
    ctx.out.push(make('STORE_LOCAL', { a: reg, imm32: binding.slot }));
    binding.state = 'initialized';
  }
}
