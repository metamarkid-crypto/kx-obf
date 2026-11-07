/**
 * Register allocator (Spec §9.1).
 *
 * The VM frame has a fixed working register file whose size is an implementation
 * detail, so the compiler cannot assume registers are unlimited. This allocator
 * hands out registers for expression temporaries and, when the file is
 * exhausted, spills the value to a frame slot instead. It must never silently
 * reuse a live register: doing so would overwrite a value the caller still needs,
 * which is exactly the aliasing bug §9.1 forbids.
 *
 * Allocation is scoped rather than free-list based: callers take a mark, allocate
 * as many temporaries as they need, then release back to the mark. That shape
 * guarantees every temporary is released by construction and makes the peak
 * register pressure trivially auditable in tests.
 */

/** Maximum registers the ABI can address in one field (dst/a/b are u16). */
export const REGISTER_FIELD_MAX = 0xfffe;

export interface AllocatorLimits {
  /** Registers the function's frame declares. Must be >= 1. */
  readonly registerCount: number;
  /** Frame slots reserved for spilled values. Going beyond it is a compile error. */
  readonly spillCapacity: number;
}

export interface RegisterAllocation {
  readonly kind: 'register';
  readonly reg: number;
}

export interface SpillAllocation {
  readonly kind: 'spill';
  /** Frame slot index used as the temporary's home. */
  readonly slot: number;
}

export type Allocation = RegisterAllocation | SpillAllocation;

/** Thrown when the function cannot be compiled within the configured budget. */
export class RegisterPressureError extends RangeError {
  readonly registerCount: number;
  readonly spillCapacity: number;

  constructor(message: string, limits: AllocatorLimits) {
    super(message);
    this.name = 'RegisterPressureError';
    this.registerCount = limits.registerCount;
    this.spillCapacity = limits.spillCapacity;
  }
}

export class RegisterAllocator {
  private readonly limits: AllocatorLimits;
  /** Next free register index. */
  private top = 0;
  /** Spill slots live right now; reclaimed by `release` like registers. */
  private spillTop = 0;
  /** Spill high-water mark, so the frame is sized for the worst expression. */
  private spillPeak = 0;
  /** Highest value `top` ever reached, reported as peak pressure. */
  private peak = 0;

  constructor(limits: AllocatorLimits) {
    if (!Number.isInteger(limits.registerCount) || limits.registerCount < 1) {
      throw new RangeError(`registerCount must be a positive integer, got ${limits.registerCount}`);
    }
    if (limits.registerCount > REGISTER_FIELD_MAX) {
      throw new RangeError(
        `registerCount ${limits.registerCount} exceeds the ${REGISTER_FIELD_MAX} addressable by a 16-bit operand field`,
      );
    }
    if (!Number.isInteger(limits.spillCapacity) || limits.spillCapacity < 0) {
      throw new RangeError(`spillCapacity must be a non-negative integer, got ${limits.spillCapacity}`);
    }
    this.limits = limits;
  }

  /**
   * Marks an allocation as genuinely live.
   *
   * `allocate()` already advances `top`, so on its own it is enough for the
   * scoped mark/release protocol. `commit` exists for the point where a caller
   * *reads* a register it may have allocated earlier and parked: nothing else
   * distinguishes "handed out and still holds a value" from "handed out and then
   * released", so a read must say so explicitly. It is idempotent and a no-op for
   * spill slots, whose lifetime is bounded by the same mark.
   */
  commit(allocation: Allocation): void {
    if (allocation.kind !== 'register') return;
    const live = allocation.reg + 1;
    if (live > this.top) {
      this.top = live;
      if (this.top > this.peak) this.peak = this.top;
    }
  }

  /** Current allocation mark; `release` returns the allocator to this state. */
  mark(): number {
    return this.depth();
  }

  /**
   * Releases every allocation made after `mark`, registers and spill slots alike.
   *
   * `mark` must be a value previously returned by `mark()`. Releasing to a mark
   * above the current top would hand out the same register twice, so it is a
   * programming error rather than something to clamp silently.
   *
   * Spilled temporaries are as dead as register temporaries once the scope that
   * requested them is released, so their slots must be reclaimed too. Without
   * that the allocator would report every temporary in the function as a live
   * spill, exhaust `spillCapacity` on the second sibling expression and reject a
   * function that only ever needs one spill slot at a time.
   *
   * A mark is stored as a depth, not as a register index: `mark()` records how
   * many allocations are outstanding, and `release()` replays that many
   * allocations' worth of registers-then-spills. The two counters therefore
   * always move together and no side table is needed, while a mark stays valid
   * after an inner release rewinds past it.
   */
  release(mark: number): void {
    if (!Number.isInteger(mark) || mark < 0 || mark > this.depth()) {
      throw new RangeError(`cannot release to mark ${mark}: current allocation depth is ${this.depth()}`);
    }
    const registers = Math.min(mark, this.limits.registerCount);
    this.top = registers;
    this.spillTop = mark > this.limits.registerCount ? mark - this.limits.registerCount : 0;
  }

  /** Allocations outstanding right now: registers plus spill slots. */
  private depth(): number {
    return this.top + this.spillTop;
  }

  /** Number of registers currently held. */
  get inUse(): number {
    return this.top;
  }

  /** Highest simultaneous register count observed so far. */
  get peakInUse(): number {
    return this.peak;
  }

  /**
   * Spill slots the frame must reserve: the worst simultaneous spill pressure,
   * not the number currently held, because a frame is allocated once for the
   * whole function. The compiler adds this to `localCount`.
   */
  get spillSlotsUsed(): number {
    return this.spillPeak;
  }

  /**
   * Allocates one temporary. A register is preferred because a spilled temporary
   * costs two extra memory instructions; spilling only starts once the register
   * file is full. Running out of spill slots as well is a hard compile error:
   * emitting code that aliases registers instead would be silently wrong.
   */
  allocate(): Allocation {
    if (this.top < this.limits.registerCount) {
      const reg = this.top;
      this.top += 1;
      if (this.top > this.peak) this.peak = this.top;
      return { kind: 'register', reg };
    }
    // Spill slots are frame slots numbered immediately after the temporary
    // registers the allocator owns (0 .. registerCount-1). They start at
    // registerCount itself — not at registerCount plus the spills already handed
    // out — so the first spill is slot `registerCount` and the nth is
    // `registerCount + n`. Adding the spill count as well would double-count and
    // leave gaps, wasting frame slots and hiding the real pressure.
    if (this.spillTop < this.limits.spillCapacity) {
      const slot = this.limits.registerCount + this.spillTop;
      this.spillTop += 1;
      if (this.spillTop > this.spillPeak) this.spillPeak = this.spillTop;
      if (this.top > this.peak) this.peak = this.top;
      // Spill slots live past the registers; they are frame slots, so the
      // function's slot count is registerCount + spillSlotsUsed.
      return { kind: 'spill', slot };
    }
    throw new RegisterPressureError(
      `expression needs more than ${this.limits.registerCount} registers and ${this.limits.spillCapacity} spill slots`,
      this.limits,
    );
  }

  /** Allocates `count` temporaries at once and returns them in allocation order. */
  allocateMany(count: number): Allocation[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`allocateMany count must be a non-negative integer, got ${count}`);
    }
    const out: Allocation[] = [];
    for (let i = 0; i < count; i++) out.push(this.allocate());
    return out;
  }

  /** Total frame slots the function needs: registers plus spill slots. */
  slotCount(): number {
    return this.limits.registerCount + this.spillPeak;
  }
}
