/**
 * Supported-syntax validator (Spec §8.1, §8.2 — Phase 1).
 *
 * Decides, per AST node, whether the v1.0 compiler can represent it. Parsing
 * acceptance never implies compiler support: this module is the single source of
 * truth for the published syntax matrix, and every rejection carries a stable
 * code, a real source position, the feature name, and an actionable hint.
 */
import type { Node, Program } from 'estree';
import { errors } from '../diagnostics/errors';
import type { SourcePosition } from '../diagnostics/errors';

/** Thin view over an ESTree node that still keeps the discriminated `type`. */
export type RawNode = Node & { readonly [key: string]: unknown };

export interface SyntaxRule {
  /** Stable machine name used in reports. */
  readonly id: string;
  /** Human feature name shown in diagnostics. */
  readonly feature: string;
  /** Remediation text shown as `Action:`. */
  readonly action: string;
  /** True when this node violates the rule. */
  readonly matches: (node: RawNode) => boolean;
}

const flag = (node: RawNode, key: string): boolean => node[key] === true;
const isType = (node: RawNode, ...types: readonly string[]): boolean => types.includes(node.type);

function calleeName(node: RawNode): string | null {
  const callee = node['callee'] as RawNode | undefined;
  if (!callee) return null;
  if (callee.type === 'Identifier') return String(callee['name']);
  return null;
}

/**
 * Every rule here corresponds to an entry in Spec §8.2. Adding support for a
 * construct means deleting its rule *and* adding differential tests, never just
 * deleting the rule.
 */
export const UNSUPPORTED_RULES: readonly SyntaxRule[] = [
  {
    id: 'generator-function',
    feature: 'generator functions / yield',
    action: 'rewrite the generator as a function returning an array or an explicit state machine',
    matches: (n) => isType(n, 'FunctionDeclaration', 'FunctionExpression') && flag(n, 'generator'),
  },
  {
    id: 'for-await-of',
    feature: 'for await...of',
    action: 'collect the async iterable with an explicit await loop',
    matches: (n) => n.type === 'ForOfStatement' && flag(n, 'await'),
  },
  {
    id: 'top-level-await',
    feature: 'top-level await',
    action: 'move the await into an async function and call it from the module body',
    matches: () => false, // resolved by the pass, which knows the function depth
  },
  {
    id: 'esm-import',
    feature: 'ES module import/export',
    action: 'convert the module to CommonJS (require / module.exports) before packaging',
    matches: (n) => isType(n, 'ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration'),
  },
  {
    id: 'dynamic-import',
    feature: 'dynamic import()',
    action: 'replace the dynamic import with a static require of an approved module',
    matches: (n) => n.type === 'ImportExpression',
  },
  {
    id: 'eval',
    feature: 'eval()',
    action: 'remove runtime source evaluation; do not depend on generated code',
    matches: (n) => n.type === 'CallExpression' && calleeName(n) === 'eval',
  },
  {
    id: 'new-function',
    feature: 'new Function() source generation',
    action: 'declare the function statically so the compiler can emit bytecode for it',
    matches: (n) => n.type === 'NewExpression' && calleeName(n) === 'Function',
  },
  {
    id: 'class-private-field',
    feature: 'class private fields and private methods',
    action: 'use a naming convention or a WeakMap instead of # private members',
    matches: (n) => {
      if (!isType(n, 'PropertyDefinition', 'MethodDefinition')) return false;
      const key = n['key'] as RawNode | undefined;
      return key?.type === 'PrivateIdentifier';
    },
  },
  {
    id: 'class',
    feature: 'class declarations and expressions',
    action: 'rewrite the class as a constructor function with prototype methods',
    matches: (n) => isType(n, 'ClassDeclaration', 'ClassExpression'),
  },
  {
    id: 'super',
    feature: 'super calls and member access',
    action: 'call the parent prototype method explicitly',
    matches: (n) => n.type === 'Super',
  },
  {
    id: 'destructuring',
    feature: 'destructuring patterns',
    action: 'assign from the object or array with explicit member access',
    matches: (n) => isType(n, 'ObjectPattern', 'ArrayPattern', 'AssignmentPattern'),
  },
  {
    id: 'spread-rest',
    feature: 'spread and rest syntax',
    action: 'build the array or object with explicit element/property assignments',
    matches: (n) => isType(n, 'SpreadElement', 'RestElement'),
  },
  {
    id: 'decorator',
    feature: 'decorators',
    action: 'remove the decorator and apply the behaviour explicitly',
    matches: (n) => Array.isArray(n['decorators']) && (n['decorators'] as unknown[]).length > 0,
  },
  {
    id: 'labeled-statement',
    feature: 'labeled statements and labeled break/continue',
    action: 'extract the labeled block into a function and return early',
    matches: (n) => isType(n, 'LabeledStatement', 'BreakStatement', 'ContinueStatement') && Boolean(n['label']),
  },
  {
    id: 'with-statement',
    feature: 'with statement',
    action: 'replace the with block with explicit property access',
    matches: (n) => n.type === 'WithStatement',
  },
  {
    id: 'jsx',
    feature: 'JSX',
    action: 'compile JSX to plain calls before packaging',
    matches: (n) => typeof n.type === 'string' && /^JSX/.test(n.type),
  },
  {
    id: 'regex-unicode-sets',
    feature: 'regex v flag (unicodeSets)',
    action: 'use the u flag instead of v',
    matches: (n) =>
      n.type === 'Literal' &&
      typeof n['regex'] === 'object' &&
      n['regex'] !== null &&
      String((n['regex'] as Record<string, unknown>)['flags'] ?? '').includes('v'),
  },
];

export interface SyntaxViolation {
  readonly id: string;
  readonly feature: string;
  readonly action: string;
  readonly position: SourcePosition;
}

export interface SyntaxReport {
  readonly ok: boolean;
  readonly violations: readonly SyntaxViolation[];
  /** Feature ids actually exercised by this program, for the fixture matrix. */
  readonly usedFeatures: readonly string[];
}

export interface ValidateOptions {
  readonly filename: string;
}

/** Walks the AST once, collecting every violation instead of failing on the first. */
export function validateSyntax(program: Program, options: ValidateOptions): SyntaxReport {
  const violations: SyntaxViolation[] = [];
  const usedFeatures = new Set<string>();
  const root = program as unknown as RawNode;

  // Iterative walk: a deeply nested input must not blow the JS stack.
  const stack: { node: RawNode; functionDepth: number }[] = [{ node: root, functionDepth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop() as { node: RawNode; functionDepth: number };
    const { node } = frame;
    if (typeof node.type !== 'string') continue;

    let depth = frame.functionDepth;
    if (
      isType(node, 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression')
    ) {
      depth += 1;
      usedFeatures.add('function');
    }

    if (node.type === 'AwaitExpression' && depth === 0) {
      violations.push({
        id: 'top-level-await',
        feature: 'top-level await',
        action: 'move the await into an async function and call it from the module body',
        position: positionOf(node, options.filename),
      });
    }

    for (const rule of UNSUPPORTED_RULES) {
      if (rule.id === 'top-level-await') continue;
      if (rule.matches(node)) {
        violations.push({
          id: rule.id,
          feature: rule.feature,
          action: rule.action,
          position: positionOf(node, options.filename),
        });
      }
    }

    for (const child of childNodes(node)) {
      stack.push({ node: child, functionDepth: depth });
    }
  }

  violations.sort(
    (a, b) =>
      a.position.line - b.position.line ||
      a.position.column - b.position.column ||
      a.id.localeCompare(b.id),
  );

  return {
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    usedFeatures: Object.freeze([...usedFeatures].sort()),
  };
}

/** Throws the first violation as a stable, actionable diagnostic. */
export function assertSupported(program: Program, options: ValidateOptions): SyntaxReport {
  const report = validateSyntax(program, options);
  const first = report.violations[0];
  if (first) {
    throw errors.unsupported(
      `Unsupported syntax: ${first.feature}`,
      first.position,
      { feature: first.feature, action: first.action },
    );
  }
  return report;
}

function positionOf(node: RawNode, filename: string): SourcePosition {
  const loc = node['loc'] as { start?: { line?: number; column?: number } } | undefined;
  return {
    file: filename,
    line: loc?.start?.line ?? 1,
    column: loc?.start?.column ?? 0,
  };
}

/** Enumerates direct child nodes without relying on per-type key tables. */
function childNodes(node: RawNode): RawNode[] {
  const children: RawNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof (item as RawNode).type === 'string') {
          children.push(item as RawNode);
        }
      }
    } else if (value && typeof value === 'object' && typeof (value as RawNode).type === 'string') {
      children.push(value as RawNode);
    }
  }
  return children;
}
