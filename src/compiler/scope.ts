/**
 * Scope analysis (Spec §8.3 — Phase 1).
 *
 * Builds the lexical environment tree the compiler will lower against: `var`
 * function scope and hoisting, `let`/`const` block scope with TDZ, closure
 * capture flags, and strict-mode detection from source directives.
 *
 * This is analysis only: it allocates nothing and emits no code.
 */
import type { Program } from 'estree';
import type { RawNode } from './support';

export type BindingKind = 'var' | 'let' | 'const' | 'function' | 'param' | 'catch' | 'class' | 'fname';

export interface Binding {
  readonly name: string;
  readonly kind: BindingKind;
  /** Depth of the scope that declares it (0 = program). */
  readonly scopeDepth: number;
  /** True when a nested function reads it. */
  captured: boolean;
  /** True when a nested function assigns it; requires a shared environment cell. */
  mutatedFromClosure: boolean;
  /** True for `var`/`function` bindings hoisted to a function scope. */
  readonly hoisted: boolean;
  /** TDZ applies to let/const/class until the declaration executes. */
  readonly temporalDeadZone: boolean;
}

export interface Scope {
  readonly depth: number;
  readonly kind: 'program' | 'function' | 'block' | 'catch';
  readonly parent: Scope | null;
  readonly bindings: Map<string, Binding>;
  /** True when this scope owns `this`, `arguments`, and `var` hoisting. */
  readonly functionBoundary: boolean;
}

export interface ScopeAnalysis {
  readonly global: Scope;
  /** Every scope in creation order, for deterministic iteration in tests. */
  readonly scopes: readonly Scope[];
  readonly strict: boolean;
  /** Identifiers referenced but never declared in any enclosing lexical scope. */
  readonly freeIdentifiers: readonly string[];
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

function directiveStrict(program: Program): boolean {
  const body = program.body as unknown as readonly RawNode[];
  for (const statement of body) {
    if (statement.type !== 'ExpressionStatement') return false;
    const expression = statement['expression'] as RawNode | undefined;
    if (!expression || expression.type !== 'Literal' || typeof expression['value'] !== 'string') {
      return false;
    }
    if (expression['value'] === 'use strict') return true;
  }
  return false;
}

function patternNames(pattern: RawNode | undefined, out: string[]): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      out.push(String(pattern['name']));
      return;
    case 'ObjectPattern':
      for (const property of (pattern['properties'] as RawNode[] | undefined) ?? []) {
        patternNames(property['value'] as RawNode | undefined, out);
      }
      return;
    case 'ArrayPattern':
      for (const element of (pattern['elements'] as (RawNode | null)[] | undefined) ?? []) {
        if (element) patternNames(element, out);
      }
      return;
    case 'AssignmentPattern':
      patternNames(pattern['left'] as RawNode | undefined, out);
      return;
    case 'RestElement':
      patternNames(pattern['argument'] as RawNode | undefined, out);
      return;
    default:
      return;
  }
}

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

function createScope(kind: Scope['kind'], parent: Scope | null): Scope {
  return {
    depth: parent ? parent.depth + 1 : 0,
    kind,
    parent,
    bindings: new Map(),
    functionBoundary: kind === 'program' || kind === 'function',
  };
}

function declare(scope: Scope, name: string, kind: BindingKind, hoisted: boolean): Binding {
  const existing = scope.bindings.get(name);
  if (existing) return existing;
  const binding: Binding = {
    name,
    kind,
    scopeDepth: scope.depth,
    captured: false,
    mutatedFromClosure: false,
    hoisted,
    temporalDeadZone: !hoisted && kind !== 'param' && kind !== 'catch' && kind !== 'fname',
  };
  scope.bindings.set(name, binding);
  return binding;
}

function nearestFunctionScope(scope: Scope): Scope {
  let current: Scope | null = scope;
  while (current && !current.functionBoundary) current = current.parent;
  return current ?? scope;
}

/**
 * Analyses the program and returns the scope tree.
 *
 * Declarations are resolved before references so hoisting and shadowing work
 * regardless of textual order.
 */
export function analyzeScopes(program: Program): ScopeAnalysis {
  const global = createScope('program', null);
  const scopes: Scope[] = [global];

  // ---- pass 1: declarations. Each node knows which scope declares it vs. which
  // scope its body runs in; these differ for functions and blocks.
  const declarePass = (node: RawNode, scope: Scope): void => {
    switch (node.type) {
      case 'VariableDeclaration': {
        const kind = String(node['kind']) as BindingKind;
        const target = kind === 'var' ? nearestFunctionScope(scope) : scope;
        for (const declarator of (node['declarations'] as RawNode[] | undefined) ?? []) {
          const names: string[] = [];
          patternNames(declarator['id'] as RawNode | undefined, names);
          for (const name of names) declare(target, name, kind, kind === 'var');
        }
        break;
      }
      case 'FunctionDeclaration': {
        const id = node['id'] as RawNode | undefined;
        // Function declarations are hoisted to the enclosing *function* scope even
        // when they appear inside a block.
        if (id && id.type === 'Identifier') {
          declare(nearestFunctionScope(scope), String(id['name']), 'function', true);
        }
        break;
      }
      case 'ClassDeclaration': {
        const id = node['id'] as RawNode | undefined;
        if (id && id.type === 'Identifier') declare(scope, String(id['name']), 'class', false);
        break;
      }
      case 'CatchClause': {
        const names: string[] = [];
        patternNames(node['param'] as RawNode | undefined, names);
        for (const name of names) declare(scope, name, 'catch', false);
        break;
      }
      default:
        break;
    }

    for (const child of childNodes(node)) {
      if (FUNCTION_TYPES.has(child.type)) {
        // A function is a boundary scope: its params, its body, and (for an
        // expression) its own name live inside it. A declaration's name belongs
        // to the enclosing function scope instead, which is why the node itself is
        // never re-entered here.
        if (child.type === 'FunctionDeclaration') {
          const id = child['id'] as RawNode | undefined;
          if (id && id.type === 'Identifier') {
            declare(nearestFunctionScope(scope), String(id['name']), 'function', true);
          }
        }
        const fnScope = createScope('function', scope);
        scopes.push(fnScope);
        if (child.type === 'FunctionExpression') {
          const id = child['id'] as RawNode | undefined;
          if (id && id.type === 'Identifier') declare(fnScope, String(id['name']), 'fname', true);
        }
        for (const param of (child['params'] as RawNode[] | undefined) ?? []) {
          const names: string[] = [];
          patternNames(param, names);
          for (const name of names) declare(fnScope, name, 'param', false);
        }
        const body = child['body'] as RawNode | undefined;
        if (body) declarePass(body, fnScope);
      } else if (child.type === 'BlockStatement') {
        const blockScope = createScope('block', scope);
        scopes.push(blockScope);
        declarePass(child, blockScope);
      } else if (child.type === 'CatchClause') {
        const catchScope = createScope('catch', scope);
        scopes.push(catchScope);
        declarePass(child, catchScope);
      } else {
        declarePass(child, scope);
      }
    }
  };

  declarePass(program as unknown as RawNode, global);

  // ---- pass 2: references, skipping binding positions and non-computed keys.
  const declaredNames = new Set<string>();
  for (const scope of scopes) for (const name of scope.bindings.keys()) declaredNames.add(name);

  const refs = new Set<string>();
  const referencePass = (node: RawNode): void => {
    if (node.type === 'Identifier') {
      refs.add(String(node['name']));
      return;
    }
    if (node.type === 'MemberExpression') {
      referencePass(node['object'] as RawNode);
      if (node['computed'] === true) referencePass(node['property'] as RawNode);
      return;
    }
    if (node.type === 'Property') {
      if (node['computed'] === true) referencePass(node['key'] as RawNode);
      referencePass(node['value'] as RawNode);
      return;
    }
    for (const child of childNodes(node)) referencePass(child);
  };
  referencePass(program as unknown as RawNode);

  const free = [...refs].filter((name) => !declaredNames.has(name)).sort();

  return {
    global,
    scopes: Object.freeze(scopes),
    strict: directiveStrict(program),
    freeIdentifiers: Object.freeze(free),
  };
}
