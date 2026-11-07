/**
 * Node target configuration loader (Spec §4.4, Phase 0).
 *
 * The declared support matrix is data, not a hard-coded claim. This module makes
 * the difference between "declared" and "actually tested" impossible to blur.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { errors } from '../diagnostics/errors';

export interface NodeTargetConfig {
  /** Majors the project intends to support. */
  readonly declared: readonly number[];
  /** Majors the test suite has actually run on. */
  readonly testedOnHost: readonly number[];
  /** Informational: version string of the machine that ran the tests. */
  readonly hostNodeVersion: string;
}

const DEFAULT_PATH = resolve(__dirname, '../../config/node-targets.json');

function isPositiveIntArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 18)
  );
}

/** Parses and validates a raw config object. Throws KxobhError on any defect. */
export function parseNodeTargets(raw: unknown, source = 'node-targets.json'): NodeTargetConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw errors.config(`${source}: expected a JSON object`, { source });
  }
  const record = raw as Record<string, unknown>;
  const declared = record['declared'];
  const tested = record['testedOnHost'];

  if (!isPositiveIntArray(declared)) {
    throw errors.config(`${source}: "declared" must be a non-empty array of integer majors >= 18`, {
      source,
    });
  }
  if (!Array.isArray(tested) || !tested.every((n) => typeof n === 'number' && Number.isInteger(n))) {
    throw errors.config(`${source}: "testedOnHost" must be an array of integer majors`, { source });
  }

  // A tested major that was never declared is a configuration bug: it would let
  // the project claim support for something outside its own matrix.
  const declaredSet = new Set(declared);
  for (const major of tested) {
    if (!declaredSet.has(major)) {
      throw errors.config(
        `${source}: "testedOnHost" contains ${major}, which is not present in "declared"`,
        { source, declared, tested },
      );
    }
  }

  const hostNodeVersion = typeof record['hostNodeVersion'] === 'string' ? record['hostNodeVersion'] : 'unknown';

  return Object.freeze({
    declared: Object.freeze([...declared].sort((a, b) => a - b)),
    testedOnHost: Object.freeze([...tested].sort((a, b) => a - b)),
    hostNodeVersion,
  });
}

/** Loads the target config from disk. */
export function loadNodeTargets(path: string = DEFAULT_PATH): NodeTargetConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw errors.io(`Cannot read node target config at ${path}`, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw errors.config(`node target config is not valid JSON: ${path}`, { path });
  }
  return parseNodeTargets(parsed, path);
}

/** True when the given major was actually exercised by the test suite. */
export function isTestedMajor(config: NodeTargetConfig, major: number): boolean {
  return config.testedOnHost.includes(major);
}

/**
 * Majors that are declared but never tested. These must not be advertised as
 * supported in the README or release notes.
 */
export function untestedDeclaredMajors(config: NodeTargetConfig): readonly number[] {
  return config.declared.filter((major) => !config.testedOnHost.includes(major));
}

/** The Node major of the running process, or null when it cannot be determined. */
export function currentNodeMajor(): number | null {
  const parsed = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  return Number.isInteger(parsed) ? parsed : null;
}
