import { findAstNode, type MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';

export function readBoundNames(value: unknown): ReadonlySet<string> {
    const names = new Set<string>();
    visit(value, (node) => {
        if (node.type === 'Identifier') {
            names.add(readName(node));
        }
    });
    return names;
}

export function containsNode(value: unknown, expected: AstNode): boolean {
    return findAstNode(value, (node) => node === expected) !== undefined;
}

export function unwrap(value: AstNode | undefined): AstNode | undefined {
    if (
        value?.type === 'TSAsExpression' ||
        value?.type === 'TSTypeAssertion' ||
        value?.type === 'TypeCastExpression' ||
        value?.type === 'TSNonNullExpression' ||
        value?.type === 'ParenthesizedExpression'
    ) {
        return unwrap(asNode(value.expression));
    }
    return value;
}

export function isFunction(node: AstNode): boolean {
    return ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type);
}

export function readMemberName(node: AstNode | undefined): string {
    return node?.type === 'MemberExpression' ||
            node?.type === 'OptionalMemberExpression'
        ? readName(node.property)
        : '';
}

export function readName(value: unknown): string {
    const node = asNode(value);
    return node && typeof node.name === 'string' ? node.name : '';
}

export function asNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as AstNode)
        : undefined;
}

export function asNodes(value: unknown): readonly AstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
        : [];
}

function visit(value: unknown, visitor: (node: AstNode) => void): void {
    if (!value || typeof value !== 'object') {
        return;
    }
    if (Array.isArray(value)) {
        for (const child of value) {
            visit(child, visitor);
        }
        return;
    }
    const node = value as AstNode;
    if (typeof node.type === 'string') {
        visitor(node);
    }
    for (const [key, child] of Object.entries(node)) {
        if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
            visit(child, visitor);
        }
    }
}
