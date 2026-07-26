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
  const right = unwrap(source);
  if (left?.type !== 'Identifier' || right?.type !== 'Identifier') return false;
  const targetKey = context.access.expressionKey(left);
  const sourceKey = canonicalStorageKey(
    context.access.expressionKey(right),
    context.heapRoots,
  );
  if (targetKey && sourceKey && targetKey !== sourceKey) {
    context.heapRoots.set(targetKey, sourceKey);
    return true;
  }
  return false;
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
