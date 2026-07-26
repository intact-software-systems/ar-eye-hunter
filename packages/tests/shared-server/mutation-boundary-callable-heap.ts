import {
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';
import type { CapabilityFlowAccess } from './mutation-boundary-capability-closures.ts';
import type { CallableAliasWrite } from './mutation-boundary-callable-resolution.ts';
import { appendCallableAlias } from './mutation-boundary-callable-storage.ts';

export interface CallableHeapContext {
  readonly access: CapabilityFlowAccess;
  readonly aliases: Map<string, CallableAliasWrite[]>;
  readonly heapRoots: Map<string, string>;
}

export function unionStoredAliases(
  target: AstNode | undefined,
  source: AstNode | undefined,
  context: CallableHeapContext,
): boolean {
  const left = unwrap(target);
  if (!left) return false;
  if (left.type === 'AssignmentPattern') {
    return unionStoredAliases(unwrap(left.left), source ?? unwrap(left.right), context);
  }
  if (left.type === 'RestElement') {
    return unionStoredAliases(unwrap(left.argument), source, context);
  }
  if (left.type === 'ObjectPattern') {
    return unionObjectPattern(left, source, context);
  }
  if (left.type === 'ArrayPattern') {
    return unionArrayPattern(left, source, context);
  }
  if (left.type !== 'Identifier') return false;
  const targetKey = context.access.expressionKey(left);
  const sourceKey = resolveStoredReference(source, context);
  return setHeapRoot(targetKey, sourceKey, context.heapRoots);
}

export function appendInvocationAlias(
  context: CallableHeapContext,
  key: string,
  write: CallableAliasWrite,
): void {
  appendCallableAlias(
    context.aliases,
    canonicalStorageKey(key, context.heapRoots),
    write,
  );
}

export function canonicalStorageKey(
  key: string,
  roots: ReadonlyMap<string, string>,
): string {
  let current = key;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const root = [...roots.keys()]
      .filter(
        (candidate) => current === candidate || current.startsWith(`${candidate}.`),
      )
      .toSorted((left, right) => right.length - left.length)[0];
    if (!root) break;
    const replacement = roots.get(root);
    if (!replacement) break;
    current = `${replacement}${current.slice(root.length)}`;
  }
  return current;
}

function unionObjectPattern(
  pattern: AstNode,
  source: AstNode | undefined,
  context: CallableHeapContext,
): boolean {
  const sourceKey = resolveStoredReference(source, context);
  if (!sourceKey) return false;
  let changed = false;
  const properties = Array.isArray(pattern.properties) ? pattern.properties : [];
  for (const rawProperty of properties) {
    const property = unwrap(rawProperty as AstNode);
    if (property?.type !== 'ObjectProperty') continue;
    const name = context.access.propertyName(property.key, property.computed === true);
    if (!name) continue;
    changed = unionStoredAliases(
      unwrap(property.value),
      referenceNode(`${sourceKey}.${name}`),
      context,
    ) || changed;
  }
  return changed;
}

function unionArrayPattern(
  pattern: AstNode,
  source: AstNode | undefined,
  context: CallableHeapContext,
): boolean {
  const sourceKey = resolveStoredReference(source, context);
  if (!sourceKey) return false;
  let changed = false;
  const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
  for (const [index, rawElement] of elements.entries()) {
    const element = unwrap(rawElement as AstNode);
    if (!element) continue;
    changed = unionStoredAliases(
      element,
      referenceNode(`${sourceKey}.${index}`),
      context,
    ) || changed;
  }
  return changed;
}

function resolveStoredReference(
  value: AstNode | undefined,
  context: CallableHeapContext,
): string {
  const node = unwrap(value);
  if (!node) return '';
  if (node.type === 'ConditionalExpression') {
    const truth = context.access.staticTruth(node.test);
    if (truth !== undefined) {
      return resolveStoredReference(
        unwrap(truth ? node.consequent : node.alternate),
        context,
      );
    }
    const consequent = resolveStoredReference(unwrap(node.consequent), context);
    const alternate = resolveStoredReference(unwrap(node.alternate), context);
    return consequent && consequent === alternate ? consequent : '';
  }
  if (node.type === 'SequenceExpression') {
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    return resolveStoredReference(unwrap(expressions.at(-1) as AstNode), context);
  }
  const syntheticKey = typeof node.syntheticKey === 'string' ? node.syntheticKey : '';
  const key = syntheticKey || context.access.expressionKey(node);
  return canonicalStorageKey(key, context.heapRoots);
}

function setHeapRoot(
  targetKey: string,
  sourceKey: string,
  roots: Map<string, string>,
): boolean {
  if (!targetKey || !sourceKey) return false;
  const canonicalTarget = canonicalStorageKey(targetKey, roots);
  if (canonicalTarget === sourceKey) return true;
  if (roots.get(targetKey) === sourceKey) return true;
  roots.set(targetKey, sourceKey);
  return true;
}

function referenceNode(key: string): AstNode {
  return { type: 'HeapReference', syntheticKey: key };
}
