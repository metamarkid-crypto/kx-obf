/**
 * KX-OBH public library surface.
 *
 * Only modules that have passed their phase gate are exported here. Anything
 * absent is not part of the v1.0 contract yet.
 */
export { TOOL_VERSION, FORMAT_VERSION, VM_ABI_VERSION } from './cli/main';
export { KxobhError, ERROR_CODES, EXIT_CODES, errors, toKxobhError } from './diagnostics/errors';
export type { ErrorCode, ExitCode, SourcePosition, ErrorHint } from './diagnostics/errors';
export { parseSource, PARSER_NAME, PARSER_VERSION, MAX_SOURCE_BYTES } from './parser/adapter';
export type { ParseRequest, ParseResult } from './parser/adapter';
export {
  loadNodeTargets,
  parseNodeTargets,
  isTestedMajor,
  untestedDeclaredMajors,
  currentNodeMajor,
} from './config/node-targets';
export type { NodeTargetConfig } from './config/node-targets';
