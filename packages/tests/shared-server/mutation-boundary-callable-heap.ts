import type { CallableAliasWrite } from './mutation-boundary-callable-resolution.ts';
import { appendCallableAlias } from './mutation-boundary-callable-storage.ts';
import {
    asCapabilityNode as asNode,
    unwrapCapabilityExpression as unwrap,
    type MutationBoundaryCapabilityAstNode as AstNode
} from './mutation-boundary-capability-ast.ts';
import type { CapabilityFlowAccess } from './mutation-boundary-capability-closures.ts';
import type { ExecutionBranch } from './mutation-boundary-execution-walk.ts';
import { executionWriteScenarios } from './mutation-execution-branches.ts';

export interface CallableHeapAliasWrite {
    readonly branches?: readonly ExecutionBranch[];
    readonly conditional: boolean;
    readonly position: number;
    readonly sourceKeys: ReadonlySet<string>;
}

export interface CallableHeapContext {
    readonly access: CapabilityFlowAccess;
    readonly aliases: Map<string, CallableAliasWrite[]>;
    readonly heapRoots: Map<string, CallableHeapAliasWrite[]>;
}

export function unionStoredAliases(
    target: AstNode | undefined,
    source: AstNode | undefined,
    context: CallableHeapContext,
    write: Omit<CallableHeapAliasWrite, 'sourceKeys'>
): boolean {
    const left = unwrap(target);
    if (!left) {
        return false;
    }
    if (left.type === 'AssignmentPattern') {
        return unionStoredAliases(
            unwrap(asNode(left.left)),
            source ?? unwrap(asNode(left.right)),
            context,
            write
        );
    }
    if (left.type === 'RestElement') {
        return unionStoredAliases(unwrap(asNode(left.argument)), source, context, write);
    }
    if (left.type === 'ObjectPattern') {
        return unionObjectPattern(left, source, context, write);
    }
    if (left.type === 'ArrayPattern') {
        return unionArrayPattern(left, source, context, write);
    }
    if (left.type !== 'Identifier') {
        return false;
    }
    const targetKey = context.access.expressionKey(left);
    const sourceKeys = resolveStoredReferences(source, context, write.position);
    return appendHeapAlias(targetKey, sourceKeys, write, context.heapRoots);
}

export function appendInvocationAlias(
    context: CallableHeapContext,
    key: string,
    write: CallableAliasWrite
): void {
    const storedKeys = key.includes('.')
        ? canonicalStorageKeys(key, context.heapRoots, write.position)
        : new Set([key]);
    for (const storedKey of storedKeys) {
        appendCallableAlias(context.aliases, storedKey, write);
    }
}

export function canonicalStorageKey(
    key: string,
    roots: ReadonlyMap<string, readonly CallableHeapAliasWrite[]>,
    position: number
): string {
    const keys = canonicalStorageKeys(key, roots, position);
    return keys.size === 1 ? [...keys][0] : key;
}

export function canonicalStorageKeys(
    key: string,
    roots: ReadonlyMap<string, readonly CallableHeapAliasWrite[]>,
    position: number
): ReadonlySet<string> {
    const root = [...roots.keys()]
        .filter(
            (candidate) => key === candidate || key.startsWith(`${candidate}.`)
        )
        .toSorted((left, right) => right.length - left.length)[0];
    if (!root) {
        return new Set([key]);
    }
    const writes = [...roots.get(root) ?? []]
        .filter((write) => write.position < position)
        .toSorted((left, right) => left.position - right.position);
    const replacements = new Set<string>();
    for (const scenario of executionWriteScenarios(writes)) {
        let state = new Set([root]);
        for (const write of scenario) {
            const conditionWithoutBranch = write.conditional && !write.branches?.length;
            state = conditionWithoutBranch
                ? new Set([...state, ...write.sourceKeys])
                : new Set(write.sourceKeys);
        }
        for (const replacement of state) {
            replacements.add(replacement);
        }
    }
    return new Set([...replacements].map((replacement) => `${replacement}${key.slice(root.length)}`));
}

function unionObjectPattern(
    pattern: AstNode,
    source: AstNode | undefined,
    context: CallableHeapContext,
    write: Omit<CallableHeapAliasWrite, 'sourceKeys'>
): boolean {
    const sourceKeys = resolveStoredReferences(source, context, write.position);
    if (sourceKeys.size !== 1) {
        return false;
    }
    const sourceKey = [...sourceKeys][0];
    let changed = false;
    const properties = Array.isArray(pattern.properties) ? pattern.properties : [];
    for (const rawProperty of properties) {
        const property = unwrap(rawProperty as AstNode);
        if (property?.type !== 'ObjectProperty') {
            continue;
        }
        const name = context.access.propertyName(property.key, property.computed === true);
        if (!name) {
            continue;
        }
        changed = unionStoredAliases(
            unwrap(asNode(property.value)),
            referenceNode(`${sourceKey}.${name}`),
            context,
            write
        ) || changed;
    }
    return changed;
}

function unionArrayPattern(
    pattern: AstNode,
    source: AstNode | undefined,
    context: CallableHeapContext,
    write: Omit<CallableHeapAliasWrite, 'sourceKeys'>
): boolean {
    const sourceKeys = resolveStoredReferences(source, context, write.position);
    if (sourceKeys.size !== 1) {
        return false;
    }
    const sourceKey = [...sourceKeys][0];
    let changed = false;
    const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
    for (const [index, rawElement] of elements.entries()) {
        const element = unwrap(rawElement as AstNode);
        if (!element) {
            continue;
        }
        changed = unionStoredAliases(
            element,
            referenceNode(`${sourceKey}.${index}`),
            context,
            write
        ) || changed;
    }
    return changed;
}

function resolveStoredReferences(
    value: AstNode | undefined,
    context: CallableHeapContext,
    position: number
): ReadonlySet<string> {
    const node = unwrap(value);
    if (!node) {
        return new Set();
    }
    if (node.type === 'ConditionalExpression') {
        const truth = context.access.staticTruth(node.test);
        if (truth !== undefined) {
            return resolveStoredReferences(
                unwrap(asNode(truth ? node.consequent : node.alternate)),
                context,
                position
            );
        }
        return new Set([
            ...resolveStoredReferences(unwrap(asNode(node.consequent)), context, position),
            ...resolveStoredReferences(unwrap(asNode(node.alternate)), context, position)
        ]);
    }
    if (node.type === 'SequenceExpression') {
        const expressions = Array.isArray(node.expressions) ? node.expressions : [];
        return resolveStoredReferences(
            unwrap(expressions.at(-1) as AstNode),
            context,
            position
        );
    }
    const syntheticKey = typeof node.syntheticKey === 'string' ? node.syntheticKey : '';
    const key = syntheticKey || context.access.expressionKey(node);
    return key ? canonicalStorageKeys(key, context.heapRoots, position) : new Set();
}

function appendHeapAlias(
    targetKey: string,
    sourceKeys: ReadonlySet<string>,
    write: Omit<CallableHeapAliasWrite, 'sourceKeys'>,
    roots: Map<string, CallableHeapAliasWrite[]>
): boolean {
    if (!targetKey || sourceKeys.size === 0) {
        return false;
    }
    const writes = roots.get(targetKey) ?? [];
    writes.push({ ...write, sourceKeys });
    roots.set(targetKey, writes);
    return true;
}

function referenceNode(key: string): AstNode {
    return { type: 'HeapReference', syntheticKey: key };
}
