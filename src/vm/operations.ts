/**
 * Value operations for the VM (Spec §8.3).
 *
 * Each helper performs the real JavaScript operation. Nothing here reimplements
 * coercion: `-0`, `NaN`, `Symbol.toPrimitive`, getter side effects and BigInt
 * mixing must behave exactly as they do natively, so the operator itself is the
 * implementation. The helpers exist so the interpreter's dispatch stays readable
 * and so each semantic rule has a single place to be tested.
 */

export type BinOp = (a: unknown, b: unknown) => unknown;

/** `in` requires an object right operand; anything else throws TypeError natively. */
export function hasProperty(value: unknown, key: unknown): boolean {
  return (key as PropertyKey) in (value as object);
}

/**
 * `typeof`. The operand is a register value that the compiler already resolved,
 * so the operator itself is the faithful implementation — including `typeof` on a
 * Symbol, which answers `'symbol'` just as natively as on a function.
 */
export function typeOf(value: unknown): string {
  return typeof value;
}

/** Fallback for an operand the compiler could not resolve to a value. */
const UNRESOLVED_TYPE = 'undefined';

/**
 * `typeof <unresolved name>` (Spec §8.3): `typeof missingIdentifier` answers
 * `'undefined'` without throwing, while `missingIdentifier` alone throws a
 * ReferenceError. The compiler emits this form only when the operand came from
 * an identifier that resolves to no binding.
 */
export function typeOfUnresolved(): typeof UNRESOLVED_TYPE {
  return UNRESOLVED_TYPE;
}

/** ReferenceError text used when an unresolved identifier is read as a value. */
export function unresolvedReferenceError(name: string): ReferenceError {
  return new ReferenceError(`${name} is not defined`);
}

/** `instanceof` with native TypeError for non-callable right operands. */
export function instanceOf(value: unknown, ctor: unknown): boolean {
  return value instanceof (ctor as Function);
}

/** Property read including private engine errors for null/undefined bases. */
export function getProperty(base: unknown, key: unknown): unknown {
  if (base === null || base === undefined) {
    throw new TypeError(`Cannot read properties of ${base} (reading '${String(key)}')`);
  }
  return (base as Record<PropertyKey, unknown>)[key as PropertyKey];
}

/** Property write; assignment semantics (not defineProperty). */
export function setProperty(base: unknown, key: unknown, value: unknown): unknown {
  if (base === null || base === undefined) {
    throw new TypeError(`Cannot set properties of ${base} (setting '${String(key)}')`);
  }
  (base as Record<PropertyKey, unknown>)[key as PropertyKey] = value;
  return value;
}

/** `delete obj[key]`; returns the boolean the operator produces. */
export function deleteProperty(base: unknown, key: unknown): boolean {
  if (base === null || base === undefined) {
    throw new TypeError(`Cannot convert ${base} to object`);
  }
  return delete (base as Record<PropertyKey, unknown>)[key as PropertyKey];
}

/** Logical NOT, kept separate so the register is read exactly once. */
export function logicalNot(value: unknown): boolean {
  return !value;
}

/** Nullish test used by `??` lowering: only null and undefined are nullish. */
export function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}
