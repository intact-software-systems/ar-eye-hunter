import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';
import type { CapabilityFlowAccess } from './mutation-boundary-capability-closures.ts';
import type { LocalCallableDefinition } from './mutation-boundary-callable-resolution.ts';

export function discoverLocalCallables(
  program: AstNode,
  programKey: string,
  access: CapabilityFlowAccess,
): readonly LocalCallableDefinition[] {
  const definitions = new Map<string, LocalCallableDefinition>();
  const scan = (value: unknown, parentFunctionKey: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child, parentFunctionKey);
      return;
    }
    const node = value as AstNode;
    if (node.type === 'VariableDeclarator') {
      const reference = access.expressionKey(node.id);
      const init = unwrap(asNode(node.init));
      if (init && isFunction(init)) {
        recordFunction(init, reference, readPosition(node), parentFunctionKey, definitions, access);
      } else if (init?.type === 'ObjectExpression') {
        recordObjectFunctions(
          init,
          reference,
          readPosition(node),
          parentFunctionKey,
          definitions,
          access,
        );
      }
    }
    if (isFunction(node)) {
      const functionKey = access.functionKey(node);
      const reference = node.type === 'FunctionDeclaration'
        ? access.expressionKey(node.id)
        : access.definitionKey(node);
      recordFunction(
        node,
        reference,
        node.type === 'FunctionDeclaration' ? Number.NEGATIVE_INFINITY : readPosition(node),
        parentFunctionKey,
        definitions,
        access,
      );
      for (const [key, child] of Object.entries(node)) {
        if (!IGNORED_KEYS.has(key)) scan(child, functionKey);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!IGNORED_KEYS.has(key)) scan(child, parentFunctionKey);
    }
  };
  scan(program, programKey);
  return [...definitions.values()];
}

export function indexCallableReferences(
  definitions: readonly LocalCallableDefinition[],
): ReadonlyMap<string, readonly LocalCallableDefinition[]> {
  const references = new Map<string, LocalCallableDefinition[]>();
  for (const definition of definitions) {
    for (const reference of definition.references.keys()) {
      const candidates = references.get(reference) ?? [];
      candidates.push(definition);
      references.set(reference, candidates);
    }
  }
  return references;
}

function recordObjectFunctions(
  object: AstNode,
  reference: string,
  availableAt: number,
  parentFunctionKey: string,
  definitions: Map<string, LocalCallableDefinition>,
  access: CapabilityFlowAccess,
): void {
  if (!reference) return;
  for (const property of asNodes(object.properties)) {
    const name = access.propertyName(property.key, property.computed === true);
    const value = property.type === 'ObjectMethod' ? property : unwrap(asNode(property.value));
    if (!name || !value || !isFunction(value)) continue;
    recordFunction(
      value,
      `${reference}.${name}`,
      availableAt,
      parentFunctionKey,
      definitions,
      access,
    );
  }
}

function recordFunction(
  node: AstNode,
  reference: string,
  availableAt: number,
  parentFunctionKey: string,
  definitions: Map<string, LocalCallableDefinition>,
  access: CapabilityFlowAccess,
): void {
  const functionKey = access.functionKey(node);
  const current = definitions.get(functionKey);
  const references = new Map(current?.references);
  if (reference) {
    references.set(reference, Math.min(references.get(reference) ?? availableAt, availableAt));
  }
  definitions.set(functionKey, {
    functionKey,
    node,
    parentFunctionKey: current?.parentFunctionKey ?? parentFunctionKey,
    references,
  });
}

function isFunction(node: AstNode | undefined): boolean {
  return !!node && [
    'ArrowFunctionExpression',
    'FunctionDeclaration',
    'FunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

function readPosition(node: AstNode): number {
  return typeof node.start === 'number' ? node.start : Number.MAX_SAFE_INTEGER;
}

const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
