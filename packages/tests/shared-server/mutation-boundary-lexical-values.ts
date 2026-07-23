import {
  createMutationBoundaryLexicalBindings,
  type MutationBoundaryLexicalBindings,
} from './mutation-boundary-lexical-bindings.ts';

type AstNode = { readonly type: string; readonly [key: string]: unknown };

interface LexicalWrite {
  readonly position: number;
  readonly value?: AstNode;
  readonly conditional: boolean;
}

export interface LexicalImportBinding {
  readonly imported: string;
  readonly source: string;
  readonly namespace: boolean;
}

export interface LexicalValueResolution {
  readonly values: readonly AstNode[];
  readonly unknown: boolean;
}

export interface MutationBoundaryLexicalValues {
  readonly bindings: MutationBoundaryLexicalBindings;
  resolveIdentifier(value: unknown, position?: number): LexicalValueResolution;
  importBinding(value: unknown): LexicalImportBinding | undefined;
}

export function createMutationBoundaryLexicalValues(
  program: AstNode,
): MutationBoundaryLexicalValues {
  const bindings = createMutationBoundaryLexicalBindings(program);
  const programFunctionKey = bindings.functionKey(program);
  const writes = new Map<string, LexicalWrite[]>();
  const imports = new Map<string, LexicalImportBinding>();

  const append = (
    target: unknown,
    value: unknown,
    position: number,
    conditional: boolean,
  ): void => {
    const key = bindings.identifierKey(target);
    if (!key) return;
    const entries = writes.get(key) ?? [];
    entries.push({ position, value: asNode(value), conditional });
    writes.set(key, entries);
  };

  const scan = (value: unknown, conditional = false): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child, conditional);
      return;
    }
    const node = value as AstNode;
    if (node.type === 'ImportDeclaration') {
      for (const specifier of asNodes(node.specifiers)) {
        const local = asNode(specifier.local);
        const key = bindings.identifierKey(local);
        if (!key) continue;
        imports.set(key, {
          imported: readName(specifier.imported) || 'default',
          source: readString(node.source),
          namespace: specifier.type === 'ImportNamespaceSpecifier',
        });
      }
    } else if (node.type === 'FunctionDeclaration') {
      append(node.id, node, Number.NEGATIVE_INFINITY, conditional);
      appendDefaultParameters(node, conditional, append);
    } else if (node.type === 'VariableDeclarator') {
      const id = asNode(node.id);
      const position = id?.type === 'Identifier' &&
          bindings.identifierFunctionKey(id) === programFunctionKey
        ? Number.NEGATIVE_INFINITY
        : positionOf(node);
      appendPattern(node.id, node.init, position, conditional, append);
    } else if (node.type === 'AssignmentExpression' && node.operator === '=') {
      appendPattern(
        node.left,
        node.right,
        positionOf(node),
        conditional,
        append,
      );
    } else if (isFunction(node)) {
      appendDefaultParameters(node, conditional, append);
    }
    for (const [name, child] of Object.entries(node)) {
      if (IGNORED_KEYS.has(name)) continue;
      const branch = conditional || isConditionalChild(node, name);
      scan(child, branch);
    }
  };
  scan(program);
  for (const entries of writes.values()) {
    entries.sort((left, right) => left.position - right.position);
  }

  return {
    bindings,
    resolveIdentifier: (value, position) => {
      const node = asNode(value);
      if (node?.type !== 'Identifier') return { values: [], unknown: true };
      const entries = writes.get(bindings.identifierKey(node)) ?? [];
      const at = position ?? positionOf(node);
      let current: readonly AstNode[] = [];
      let unknown = true;
      for (const entry of entries) {
        if (entry.position > at) break;
        if (!entry.conditional) {
          current = entry.value ? [entry.value] : [];
          unknown = !entry.value;
        } else {
          current = deduplicate(
            entry.value ? [...current, entry.value] : current,
          );
          unknown = true;
        }
      }
      return { values: current, unknown };
    },
    importBinding: (value) => {
      const node = asNode(value);
      return node?.type === 'Identifier' ? imports.get(bindings.identifierKey(node)) : undefined;
    },
  };
}

type AppendWrite = (
  target: unknown,
  value: unknown,
  position: number,
  conditional: boolean,
) => void;

function appendDefaultParameters(
  node: AstNode,
  conditional: boolean,
  append: AppendWrite,
): void {
  for (const parameter of asNodes(node.params)) {
    const actual = parameter.type === 'TSParameterProperty'
      ? asNode(parameter.parameter)
      : parameter;
    if (actual?.type === 'AssignmentPattern') {
      appendPattern(
        actual.left,
        actual.right,
        positionOf(actual),
        conditional,
        append,
      );
    }
  }
}

function appendPattern(
  pattern: unknown,
  value: unknown,
  position: number,
  conditional: boolean,
  append: AppendWrite,
): void {
  const node = asNode(pattern);
  if (!node) return;
  if (node.type === 'Identifier') append(node, value, position, conditional);
  else if (node.type === 'AssignmentPattern') {
    appendPattern(
      node.left,
      value ?? node.right,
      position,
      conditional,
      append,
    );
  }
}

function isConditionalChild(node: AstNode, name: string): boolean {
  if (node.type === 'IfStatement') {
    return name === 'consequent' || name === 'alternate';
  }
  if (node.type === 'ConditionalExpression') {
    return name === 'consequent' || name === 'alternate';
  }
  if (node.type === 'LogicalExpression') return name === 'right';
  return (
    [
      'ForStatement',
      'ForInStatement',
      'ForOfStatement',
      'WhileStatement',
      'DoWhileStatement',
    ].includes(node.type) && name === 'body'
  );
}

function isFunction(node: AstNode): boolean {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

function deduplicate(values: readonly AstNode[]): readonly AstNode[] {
  return [...new Set(values)];
}

function positionOf(value: unknown): number {
  const node = asNode(value);
  return node && typeof node.start === 'number' ? node.start : Number.POSITIVE_INFINITY;
}

function readName(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.name === 'string' ? node.name : '';
}

function readString(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.value === 'string' ? node.value : '';
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}

const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
