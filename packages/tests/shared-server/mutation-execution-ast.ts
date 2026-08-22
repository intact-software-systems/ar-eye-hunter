import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';
import type { MutationExecutionAstNode as AstNode } from './mutation-execution-path-state.ts';

export function readExactExecutionIterable(
    value: unknown,
    lexical: MutationBoundaryLexicalValues | undefined,
    resolving: Set<string>
): readonly (AstNode | undefined)[] | undefined {
    const node = unwrapExecutionNode(asExecutionNode(value));
    if (node?.type === 'ArrayExpression' || node?.type === 'TupleExpression') {
        return rawExecutionValues(node.elements).map(asExecutionNode);
    }
    if (node?.type !== 'Identifier' || !lexical) {
        return undefined;
    }
    const key = lexical.bindings.identifierKey(node);
    if (!key || resolving.has(key)) {
        return undefined;
    }
    const resolved = lexical.resolveIdentifier(node);
    return !resolved.unknown && resolved.values.length === 1
        ? readExactExecutionIterable(
            resolved.values[0],
            lexical,
            new Set(resolving).add(key)
        )
        : undefined;
}

export function isExecutionLoop(node: AstNode | undefined): node is AstNode {
    return !!node && [
        'DoWhileStatement',
        'ForInStatement',
        'ForOfStatement',
        'ForStatement',
        'WhileStatement'
    ].includes(node.type);
}

export function isExecutionFunction(node: AstNode): boolean {
    return [
        'ArrowFunctionExpression',
        'FunctionDeclaration',
        'FunctionExpression',
        'ObjectMethod',
        'ClassMethod',
        'ClassPrivateMethod'
    ].includes(node.type);
}

export function unwrapExecutionNode(value: AstNode | undefined): AstNode | undefined {
    if (
        value?.type === 'TSAsExpression' || value?.type === 'TSTypeAssertion' ||
        value?.type === 'TypeCastExpression' || value?.type === 'TSNonNullExpression' ||
        value?.type === 'ParenthesizedExpression'
    ) {
        return unwrapExecutionNode(asExecutionNode(value.expression));
    }
    return value;
}

export function readExecutionName(value: unknown): string | undefined {
    const node = asExecutionNode(value);
    return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined;
}

export function asExecutionNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

export function asExecutionNodes(value: unknown): readonly AstNode[] {
    return rawExecutionValues(value)
        .map(asExecutionNode)
        .filter((node): node is AstNode => node !== undefined);
}

export function rawExecutionValues(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

export const EXECUTION_IGNORED_KEYS = new Set([
    'loc',
    'start',
    'end',
    'comments',
    'tokens'
]);
