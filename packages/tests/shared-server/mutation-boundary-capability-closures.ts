import {
    asCapabilityNode as asNode,
    asCapabilityNodes as asNodes,
    unwrapCapabilityExpression as unwrap,
    type MutationBoundaryCapabilityAstNode as AstNode
} from './mutation-boundary-capability-ast.ts';
import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';

export type FlowCapabilityMethod = Readonly<{
    capability: string;
    method: string;
}>;

export interface CapabilityFlowAccess {
    definitionKey(value: unknown): string;
    directMethod(value: unknown): FlowCapabilityMethod | undefined;
    expressionKey(value: unknown): string;
    fallbackMethod(key: string): FlowCapabilityMethod | undefined;
    functionKey(value: unknown): string;
    memberMethod(
        sourceKey: string,
        property: string
    ): FlowCapabilityMethod | undefined;
    ownerFunctionKey(value: unknown): string;
    propertyName(value: unknown, computed: boolean): string;
    readonly lexical: MutationBoundaryLexicalValues;
    staticTruth(value: unknown): boolean | undefined;
}

export interface FlowMethodSource {
    readonly direct?: FlowCapabilityMethod;
    readonly key: string;
}

export interface FlowPatternWrite {
    readonly owner: AstNode;
    readonly source: FlowMethodSource;
    readonly targetKey: string;
}

export interface ClosureExecutionWrite extends FlowPatternWrite {
    readonly conditional: boolean;
    readonly position: number;
}

export function readFlowPatternWrites(
    pattern: AstNode | undefined,
    value: AstNode | undefined,
    access: CapabilityFlowAccess,
    sourceOverride?: FlowMethodSource
): readonly FlowPatternWrite[] {
    if (!pattern) {
        return [];
    }
    if (pattern.type === 'AssignmentPattern') {
        return readFlowPatternWrites(
            asNode(pattern.left),
            asNode(pattern.right),
            access
        );
    }
    if (pattern.type === 'RestElement') {
        return readFlowPatternWrites(
            asNode(pattern.argument),
            value,
            access,
            sourceOverride
        );
    }
    if (pattern.type === 'Identifier') {
        const targetKey = access.expressionKey(pattern);
        const writes: FlowPatternWrite[] = [
            {
                owner: pattern,
                source: sourceOverride ?? readSource(value, access),
                targetKey
            }
        ];
        const object = unwrap(value);
        if (object?.type === 'ObjectExpression') {
            for (const property of asNodes(object.properties)) {
                const name = access.propertyName(
                    property.key,
                    property.computed === true
                );
                if (!name) {
                    continue;
                }
                writes.push({
                    owner: pattern,
                    source: readSource(asNode(property.value), access),
                    targetKey: `${targetKey}.${name}`
                });
            }
        }
        return writes;
    }
    if (
        pattern.type === 'MemberExpression' ||
        pattern.type === 'OptionalMemberExpression'
    ) {
        return [
            {
                owner: rootIdentifier(pattern) ?? pattern,
                source: sourceOverride ?? readSource(value, access),
                targetKey: access.expressionKey(pattern)
            }
        ];
    }
    if (pattern.type === 'ArrayPattern') {
        const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
        const sourceElements = Array.isArray(value?.elements) ? value.elements : [];
        const sourceKey = sourceOverride?.key ?? access.expressionKey(value);
        return elements.flatMap((rawTarget, index) => {
            const target = asNode(rawTarget);
            if (!target) {
                return [];
            }
            const directValue = asNode(sourceElements[index]);
            return readFlowPatternWrites(
                target,
                directValue,
                access,
                directValue ? undefined : {
                    direct: access.memberMethod(sourceKey, String(index)),
                    key: sourceKey ? `${sourceKey}.${index}` : ''
                }
            );
        });
    }
    if (pattern.type !== 'ObjectPattern') {
        return [];
    }
    const writes: FlowPatternWrite[] = [];
    const sourceKey = sourceOverride?.key ?? access.expressionKey(value);
    for (const property of asNodes(pattern.properties)) {
        if (property.type !== 'ObjectProperty') {
            continue;
        }
        const name = access.propertyName(property.key, property.computed === true);
        const target = asNode(property.value);
        if (!name || !target) {
            continue;
        }
        writes.push(
            ...readFlowPatternWrites(target, undefined, access, {
                direct: access.memberMethod(sourceKey, name),
                key: sourceKey ? `${sourceKey}.${name}` : ''
            })
        );
    }
    return writes;
}

export function isCapturedFlowWrite(
    write: FlowPatternWrite,
    writeNode: AstNode,
    access: CapabilityFlowAccess
): boolean {
    const owner = access.ownerFunctionKey(write.owner);
    const writer = access.functionKey(writeNode);
    return !!owner && !!writer && owner !== writer;
}

function readSource(
    value: AstNode | undefined,
    access: CapabilityFlowAccess
): FlowMethodSource {
    return {
        direct: access.directMethod(value),
        key: access.expressionKey(value)
    };
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
