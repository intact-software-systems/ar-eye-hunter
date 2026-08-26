import {
    asCapabilityNode as asNode,
    asCapabilityNodes as asNodes,
    unwrapCapabilityExpression as unwrap,
    type MutationBoundaryCapabilityAstNode as AstNode
} from '../capabilities/mutation-boundary-capability-ast.ts';
import type { CapabilityFlowAccess } from '../capabilities/mutation-boundary-capability-closures.ts';
import type { CallableAliasWrite, CallableResolution } from './mutation-boundary-callable-resolution.ts';

export interface CallablePatternWrite {
    readonly owner: AstNode;
    readonly projection: readonly string[];
    readonly source: AstNode | undefined;
    readonly targetKey: string;
}

export function readCallablePatternWrites(
    pattern: AstNode | undefined,
    source: AstNode | undefined,
    access: CapabilityFlowAccess,
    projection: readonly string[] = []
): readonly CallablePatternWrite[] {
    const node = unwrap(pattern);
    if (!node) {
        return [];
    }
    if (node.type === 'AssignmentPattern') {
        return readCallablePatternWrites(
            asNode(node.left),
            source ?? asNode(node.right),
            access,
            projection
        );
    }
    if (node.type === 'RestElement') {
        return readCallablePatternWrites(
            asNode(node.argument),
            source,
            access,
            projection
        );
    }
    if (node.type === 'Identifier') {
        const targetKey = access.expressionKey(node);
        return targetKey ? [{ owner: node, projection, source, targetKey }] : [];
    }
    if (
        node.type === 'MemberExpression' ||
        node.type === 'OptionalMemberExpression'
    ) {
        const directKey = access.expressionKey(node);
        const objectKey = access.expressionKey(node.object);
        const targetKey = directKey || (objectKey ? `${objectKey}.*` : '');
        return targetKey
            ? [{ owner: rootIdentifier(node) ?? node, projection, source, targetKey }]
            : [];
    }
    if (node.type === 'ArrayPattern') {
        const elements = Array.isArray(node.elements) ? node.elements : [];
        return elements.flatMap((element, index) => {
            const item = asNode(element);
            return item
                ? readCallablePatternWrites(item, source, access, [
                    ...projection,
                    String(index)
                ])
                : [];
        });
    }
    if (node.type !== 'ObjectPattern') {
        return [];
    }
    return asNodes(node.properties).flatMap((property) => {
        if (property.type !== 'ObjectProperty') {
            return [];
        }
        const name = access.propertyName(property.key, property.computed === true);
        return name
            ? readCallablePatternWrites(asNode(property.value), source, access, [
                ...projection,
                name
            ])
            : [];
    });
}

export function isCapturedCallableWrite(
    owner: AstNode,
    writeNode: AstNode,
    access: CapabilityFlowAccess
): boolean {
    const ownerFunction = access.ownerFunctionKey(owner);
    const writerFunction = access.functionKey(writeNode);
    return (
        !!ownerFunction && !!writerFunction && ownerFunction !== writerFunction
    );
}

export function appendCallableAlias(
    aliases: Map<string, CallableAliasWrite[]>,
    key: string,
    write: CallableAliasWrite
): void {
    if (!key) {
        return;
    }
    const writes = aliases.get(key) ?? [];
    writes.push(write);
    aliases.set(key, writes);
}

export function projectCallableResolution(
    resolution: CallableResolution,
    projection: readonly string[]
): CallableResolution {
    let current = resolution;
    for (const member of projection) {
        const next = current.members.get(member);
        if (!next) {
            return {
                localProvenance: current.localProvenance,
                members: new Map(),
                targets: new Map(),
                unknown: current.localProvenance
            };
        }
        current = next;
    }
    return current;
}

function rootIdentifier(value: AstNode): AstNode | undefined {
    const node = unwrap(value);
    if (node?.type === 'Identifier') {
        return node;
    }
    if (
        node?.type === 'MemberExpression' ||
        node?.type === 'OptionalMemberExpression'
    ) {
        const object = asNode(node.object);
        return object ? rootIdentifier(object) : undefined;
    }
    return undefined;
}
