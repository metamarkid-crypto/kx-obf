/**
 * KX-OBH stable error catalog (Spec Appendix A, §16.3).
 *
 * Every failure in the toolchain maps to exactly one stable code. Codes are part
 * of the public contract for the current major format version and MUST NOT be
 * renumbered without a version bump.
 */

export const ERROR_CODES = {
  PARSE: 'KXOBH-E-PARSE',
  COMPILER_UNSUPPORTED: 'KXOBH-E-COMPILER-UNSUPPORTED',
  COMPILER_SEMANTICS: 'KXOBH-E-COMPILER-SEMANTICS',
  IMPORT_DENIED: 'KXOBH-E-IMPORT-DENIED',
  PACKAGE_MAGIC: 'KXOBH-E-PACKAGE-MAGIC',
  PACKAGE_VERSION: 'KXOBH-E-PACKAGE-VERSION',
  PACKAGE_BOUNDS: 'KXOBH-E-PACKAGE-BOUNDS',
  PACKAGE_SECTION: 'KXOBH-E-PACKAGE-SECTION',
  SIGNATURE: 'KXOBH-E-SIGNATURE',
  AEAD: 'KXOBH-E-AEAD',
  COMPRESSION: 'KXOBH-E-COMPRESSION',
  BYTECODE: 'KXOBH-E-BYTECODE',
  ABI: 'KXOBH-E-ABI',
  NODE_VERSION: 'KXOBH-E-NODE-VERSION',
  CAPABILITY: 'KXOBH-E-CAPABILITY',
  VM_LIMIT: 'KXOBH-E-VM-LIMIT',
  CONFIG: 'KXOBH-E-CONFIG',
  IO: 'KXOBH-E-IO',
  INTERNAL: 'KXOBH-E-INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Process exit codes (Spec §16.3). Stable within a major format version.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  USAGE: 2,
  COMPILE: 10,
  UNSUPPORTED: 11,
  PACKAGE: 20,
  SIGNATURE: 21,
  CRYPTO: 22,
  NODE_COMPAT: 30,
  INTERNAL: 40,
} as const;

export type ExitCode = 0 | 2 | 10 | 11 | 20 | 21 | 22 | 30 | 40;

const CODE_TO_EXIT: Readonly<Record<ErrorCode, ExitCode>> = {
  [ERROR_CODES.PARSE]: EXIT_CODES.COMPILE,
  [ERROR_CODES.COMPILER_UNSUPPORTED]: EXIT_CODES.UNSUPPORTED,
  [ERROR_CODES.COMPILER_SEMANTICS]: EXIT_CODES.UNSUPPORTED,
  [ERROR_CODES.IMPORT_DENIED]: EXIT_CODES.COMPILE,
  [ERROR_CODES.PACKAGE_MAGIC]: EXIT_CODES.PACKAGE,
  [ERROR_CODES.PACKAGE_VERSION]: EXIT_CODES.PACKAGE,
  [ERROR_CODES.PACKAGE_BOUNDS]: EXIT_CODES.PACKAGE,
  [ERROR_CODES.PACKAGE_SECTION]: EXIT_CODES.PACKAGE,
  [ERROR_CODES.SIGNATURE]: EXIT_CODES.SIGNATURE,
  [ERROR_CODES.AEAD]: EXIT_CODES.CRYPTO,
  [ERROR_CODES.COMPRESSION]: EXIT_CODES.CRYPTO,
  [ERROR_CODES.BYTECODE]: EXIT_CODES.PACKAGE,
  [ERROR_CODES.ABI]: EXIT_CODES.PACKAGE,
  [ERROR_CODES.NODE_VERSION]: EXIT_CODES.NODE_COMPAT,
  [ERROR_CODES.CAPABILITY]: EXIT_CODES.COMPILE,
  [ERROR_CODES.VM_LIMIT]: EXIT_CODES.INTERNAL,
  [ERROR_CODES.CONFIG]: EXIT_CODES.USAGE,
  [ERROR_CODES.IO]: EXIT_CODES.USAGE,
  [ERROR_CODES.INTERNAL]: EXIT_CODES.INTERNAL,
};

/** A precise source position, 1-based line and 0-based column (ESTree convention). */
export interface SourcePosition {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** Optional remediation guidance shown to the operator. */
export interface ErrorHint {
  /** Human name of the offending feature, e.g. "class private fields". */
  readonly feature?: string;
  /** Concrete action the user can take. */
  readonly action?: string;
}

/**
 * Base class for every controlled KX-OBH failure.
 *
 * `message` is safe to display: it never contains decrypted constants, key
 * material, or source text.
 */
export class KxobhError extends Error {
  readonly code: ErrorCode;
  readonly position: SourcePosition | undefined;
  readonly hint: ErrorHint | undefined;
  /** Extra structured context; must stay free of secrets and source text. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      position?: SourcePosition;
      hint?: ErrorHint;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KxobhError';
    this.code = code;
    this.position = options.position;
    this.hint = options.hint;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }

  /** Exit code associated with this failure (Spec §16.3). */
  get exitCode(): ExitCode {
    return CODE_TO_EXIT[this.code] ?? EXIT_CODES.INTERNAL;
  }

  /** Multi-line diagnostic in the format required by Spec §17. */
  format(): string {
    const lines: string[] = [this.code];
    if (this.position) {
      lines.push(`${this.position.file}:${this.position.line}:${this.position.column}`);
    }
    lines.push(this.message);
    if (this.hint?.feature) lines.push(`Feature: ${this.hint.feature}`);
    if (this.hint?.action) lines.push(`Action: ${this.hint.action}`);
    return lines.join('\n');
  }

  /** JSON-safe projection for `--report`. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      position: this.position ?? null,
      hint: this.hint ?? null,
      details: this.details,
    };
  }
}

/** Convenience constructors, one per family of failure. */
export const errors = {
  parse: (message: string, position?: SourcePosition, hint?: ErrorHint) =>
    new KxobhError(ERROR_CODES.PARSE, message, { position, hint }),

  unsupported: (message: string, position: SourcePosition, hint: ErrorHint) =>
    new KxobhError(ERROR_CODES.COMPILER_UNSUPPORTED, message, { position, hint }),

  semantics: (message: string, position?: SourcePosition, hint?: ErrorHint) =>
    new KxobhError(ERROR_CODES.COMPILER_SEMANTICS, message, { position, hint }),

  importDenied: (message: string, position?: SourcePosition, hint?: ErrorHint) =>
    new KxobhError(ERROR_CODES.IMPORT_DENIED, message, { position, hint }),

  config: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.CONFIG, message, { details }),

  io: (message: string, cause?: unknown) =>
    new KxobhError(ERROR_CODES.IO, message, { cause }),

  nodeVersion: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.NODE_VERSION, message, { details }),

  internal: (message: string, cause?: unknown) =>
    new KxobhError(ERROR_CODES.INTERNAL, message, { cause }),

  bytecodeRead: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.BYTECODE, message, { details }),

  bytecodeVerify: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.BYTECODE, message, { details }),

  abi: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.ABI, message, { details }),

  vmLimit: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.VM_LIMIT, message, { details }),

  capability: (message: string, position?: SourcePosition, hint?: ErrorHint) =>
    new KxobhError(ERROR_CODES.CAPABILITY, message, { position, hint }),

  package: (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    new KxobhError(code, message, { details }),

  aead: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.AEAD, message, { details }),

  compression: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.COMPRESSION, message, { details }),

  signature: (message: string, details?: Record<string, unknown>) =>
    new KxobhError(ERROR_CODES.SIGNATURE, message, { details }),
};

/**
 * Normalizes an arbitrary thrown value into a KxobhError.
 * Never swallows the original: it is preserved as `cause`.
 */
export function toKxobhError(value: unknown, fallbackMessage = 'Unexpected internal error'): KxobhError {
  if (value instanceof KxobhError) return value;
  let message = '';
  if (value instanceof Error) {
    message = value.message;
  } else if (typeof value === 'string') {
    message = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    message = String(value);
  }
  // A thrown object with no readable text would stringify to `[object Object]`,
  // which is not a diagnostic. Report the stable fallback instead.
  return errors.internal(message || fallbackMessage, value);
}
