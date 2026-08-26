import { walkReachableAst } from '../../execution/mutation-boundary-execution-walk.ts';
import {
    asCapabilityNode as asNode,
    unwrapCapabilityExpression as unwrap,
    type MutationBoundaryCapabilityAstNode as AstNode
} from './mutation-boundary-capability-ast.ts';
import {
    isCapturedFlowWrite,
    readFlowPatternWrites,
    type CapabilityFlowAccess,
    type FlowCapabilityMethod,
    type FlowMethodSource
} from './mutation-boundary-capability-closures.ts';
import { collectClosureExecutionWrites } from './mutation-boundary-capability-invocations.ts';

export type { FlowCapabilityMethod } from './mutation-boundary-capability-closures.ts';

interface MethodWrite {
    readonly conditional: boolean;
    readonly order: number;
    readonly position: number;
    readonly source: FlowMethodSource;
}

export function findFlowSensitiveCapabilityCalls(
    program: AstNode,
    access: CapabilityFlowAccess
): readonly FlowCapabilityMethod[] {
    const conditionalNodes = findConditionalNodes(program, access);
    const writes = new Map<string, MethodWrite[]>();
    let nextOrder = 0;
    let hasCapturedWrites = false;
    walkReachableAst(program, (node) => {
        const pattern = node.type === 'VariableDeclarator'
            ? asNode(node.id)
            : node.type === 'AssignmentExpression'
            ? asNode(node.left)
            : undefined;
        const value = node.type === 'VariableDeclarator'
            ? asNode(node.init)
            : node.type === 'AssignmentExpression'
            ? asNode(node.right)
            : undefined;
        if (!pattern) {
            return;
        }
        for (const write of readFlowPatternWrites(pattern, value, access)) {
            if (isCapturedFlowWrite(write, node, access)) {
                hasCapturedWrites = true;
                continue;
            }
            addWrite(
                write.targetKey,
                write.source,
                readPosition(node),
                conditionalNodes.has(node),
                nextOrder++,
                writes
            );
        }
    }, { lexical: access.lexical });
    if (hasCapturedWrites) {
        const closureWrites = collectClosureExecutionWrites(
            program,
            access,
            (node) => conditionalNodes.has(node)
        );
        for (const write of closureWrites) {
            addWrite(
                write.targetKey,
                write.source,
                write.position,
                write.conditional,
                nextOrder++,
                writes
            );
        }
    }

    const calls = new Map<string, FlowCapabilityMethod>();
    walkReachableAst(program, (node) => {
        if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
            return;
        }
        const position = readPosition(node);
        for (const method of resolveCallee(asNode(node.callee), position, writes, access)) {
            calls.set(methodKey(method), method);
        }
    }, { lexical: access.lexical });
    return [...calls.values()];
}

function addWrite(
    targetKey: string,
    source: FlowMethodSource,
    position: number,
    conditional: boolean,
    order: number,
    writes: Map<string, MethodWrite[]>
): void {
    if (!targetKey) {
        return;
    }
    const entries = writes.get(targetKey) ?? [];
    entries.push({ conditional, order, position, source });
    writes.set(targetKey, entries);
}

function resolveCallee(
    value: AstNode | undefined,
    position: number,
    writes: ReadonlyMap<string, readonly MethodWrite[]>,
    access: CapabilityFlowAccess
): ReadonlySet<FlowCapabilityMethod> {
    const node = unwrap(value);
    if (!node) {
        return new Set();
    }
    const key = access.expressionKey(node);
    if (key && writes.has(key)) {
        return resolveKey(key, position, writes, access, new Set());
    }
    const direct = access.directMethod(node) ?? (key ? access.fallbackMethod(key) : undefined);
    return direct ? new Set([direct]) : new Set();
}

function resolveKey(
    key: string,
    position: number,
    writes: ReadonlyMap<string, readonly MethodWrite[]>,
    access: CapabilityFlowAccess,
    resolving: Set<string>
): ReadonlySet<FlowCapabilityMethod> {
    const resolutionKey = `${key}:${position}`;
    if (resolving.has(resolutionKey)) {
        return new Set();
    }
    resolving.add(resolutionKey);
    let state = new Map<string, FlowCapabilityMethod>();
    const orderedWrites = [...writes.get(key) ?? []].toSorted((left, right) => left.position - right.position || left.order - right.order);
    for (const write of orderedWrites) {
        if (write.position >= position) {
            continue;
        }
        const source = resolveSource(write.source, write.position, writes, access, resolving);
        if (!write.conditional) {
            state = new Map([...source].map((method) => [methodKey(method), method]));
        }
        else {
            for (const method of source) {
                state.set(methodKey(method), method);
            }
        }
    }
    resolving.delete(resolutionKey);
    if (state.size > 0 || writes.has(key)) {
        return new Set(state.values());
    }
    const fallback = access.fallbackMethod(key);
    return fallback ? new Set([fallback]) : new Set();
}

function resolveSource(
    source: FlowMethodSource,
    position: number,
    writes: ReadonlyMap<string, readonly MethodWrite[]>,
    access: CapabilityFlowAccess,
    resolving: Set<string>
): ReadonlySet<FlowCapabilityMethod> {
    if (source.direct) {
        return new Set([source.direct]);
    }
    return source.key ? resolveKey(source.key, position, writes, access, resolving) : new Set();
}

function findConditionalNodes(
    program: AstNode,
    access: CapabilityFlowAccess
): WeakSet<object> {
    const conditional = new WeakSet<object>();
    walkReachableAst(program, (node, context) => {
        if (context.conditional) {
            conditional.add(node);
        }
    }, { lexical: access.lexical });
    return conditional;
}

function readPosition(node: AstNode): number {
    return typeof node.start === 'number' ? node.start : Number.MAX_SAFE_INTEGER;
}

function methodKey(method: FlowCapabilityMethod): string {
    return `${method.capability}.${method.method}`;
}
