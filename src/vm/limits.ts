/**
 * VM resource limits (Spec §9.7).
 *
 * Limits exist for reliability and resource control, not anti-debugging. Every
 * exceeded limit throws a typed KXOBH-E-VM-LIMIT, never an unbounded allocation
 * or a process crash. Defaults are generous enough for ordinary applications and
 * are documented in README.
 */
import { errors } from '../diagnostics/errors';

export interface VmLimits {
  /** Maximum decoded package size in bytes. */
  readonly maxPackageBytes: number;
  /** Maximum decompressed size of any single section. */
  readonly maxSectionBytes: number;
  /** Maximum number of functions in the function table. */
  readonly maxFunctions: number;
  /** Maximum instructions in one function body. */
  readonly maxInstructionsPerFunction: number;
  /** Maximum constants in the pool. */
  readonly maxConstants: number;
  /** Maximum byte length of a single constant payload. */
  readonly maxConstantBytes: number;
  /** Maximum VM call depth (frames on the stack). */
  readonly maxFrameDepth: number;
  /** Maximum frame slots (params + locals) per frame. */
  readonly maxFrameSlots: number;
  /** Working register file size per frame. */
  readonly maxRegisters: number;
  /** Maximum entries in the exception table. */
  readonly maxExceptionRecords: number;
  /** Optional instruction budget; 0 disables it. */
  readonly instructionBudget: number;
}

export const DEFAULT_VM_LIMITS: VmLimits = Object.freeze({
  maxPackageBytes: 64 * 1024 * 1024,
  maxSectionBytes: 64 * 1024 * 1024,
  maxFunctions: 65536,
  maxInstructionsPerFunction: 1_048_576,
  maxConstants: 1_048_576,
  maxConstantBytes: 16 * 1024 * 1024,
  maxFrameDepth: 512,
  maxFrameSlots: 65536,
  maxRegisters: 256,
  maxExceptionRecords: 65536,
  instructionBudget: 0,
});

/** Overlays caller overrides on the defaults, rejecting negative or non-finite values. */
export function resolveLimits(overrides: Partial<VmLimits> = {}): VmLimits {
  const merged: Record<string, number> = { ...DEFAULT_VM_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    // An unknown key is a caller bug: silently accepting it would leave the
    // documented default in force while the caller believes it was tightened.
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_VM_LIMITS, key)) {
      throw errors.config(`unknown VM limit ${key}`);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw errors.config(`limit ${key} must be a non-negative safe integer, got ${String(value)}`);
    }
    merged[key] = value;
  }
  if (merged.maxRegisters < 1) {
    throw errors.config('limit maxRegisters must be at least 1');
  }
  // Register operands are u16, so a larger register file could not be addressed
  // by an instruction. 0xffff itself stays legal: valid indexes are
  // 0 .. maxRegisters-1, which leaves the ABSENT sentinel out of range.
  if (merged.maxRegisters > 0xffff) {
    throw errors.config(
      `limit maxRegisters must be at most 65535, got ${merged.maxRegisters}: register operands are 16-bit and 65535 is the ABSENT sentinel`,
    );
  }
  return Object.freeze(merged as unknown as VmLimits);
}

/** Throws when `actual` exceeds the named limit. */
export function enforceLimit(name: keyof VmLimits, actual: number, limits: VmLimits): void {
  const limit = limits[name];
  if (limit > 0 && actual > limit) {
    throw errors.vmLimit(`${name} ${actual} exceeds limit ${limit}`, { limit: name, actual, maximum: limit });
  }
}
