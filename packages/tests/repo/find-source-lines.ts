import { parse } from '@babel/parser';
import type { Node, Program } from '@babel/types';

/** Whether a node, reached through its ancestors (nearest first), is one a finder reports. */
export type SourceNodeMatch = (node: Node, ancestors: readonly Node[]) => boolean;

/**
 * The name a property key, binding, callee or member is known by, if it has one: an identifier's, a private name's,
 * a quoted key's or a computed string member's, or a member expression's property.
 */
export function toNodeName(node: Node | null | undefined): string | undefined {
    if (!node) {
        return undefined;
    }
    switch (node.type) {
        case 'Identifier':
            return node.name;
        case 'PrivateName':
            return node.id.name;
        case 'StringLiteral':
            return node.value;
        case 'MemberExpression':
        case 'OptionalMemberExpression':
            return toNodeName(node.property);
        default:
            return undefined;
    }
}

/** The nodes that open a function's body. */
export const FUNCTION_TYPES: ReadonlySet<string> = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ClassMethod',
    'ClassPrivateMethod',
    'ObjectMethod'
]);

/**
 * The name the nearest enclosing function, among `outer` (nearest first), is known by: its own, its method key's or
 * its binding's.
 */
export function toEnclosingFunctionName(outer: readonly Node[]): string | undefined {
    const index = outer.findIndex((node) => FUNCTION_TYPES.has(node.type));
    const fn = outer[index];
    if (fn === undefined) {
        return undefined;
    }
    if ('id' in fn && fn.id) {
        return toNodeName(fn.id);
    }
    if ('key' in fn) {
        return toNodeName(fn.key);
    }
    const binding = outer[index + 1];
    return binding?.type === 'VariableDeclarator' ? toNodeName(binding.id) : undefined;
}

/** Calls `visit` with every node of the tree and its ancestors, nearest first. */
export function walkNodes(node: Node, ancestors: readonly Node[], visit: (node: Node, ancestors: readonly Node[]) => void): void {
    visit(node, ancestors);
    const inner = [node, ...ancestors];
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key.endsWith('Comments')) {
            continue;
        }
        for (const child of Array.isArray(value) ? value : [value]) {
            if (typeof child === 'object' && child !== null && typeof child.type === 'string') {
                walkNodes(child, inner, visit);
            }
        }
    }
}

/**
 * Each line of a TypeScript source on which a node starts that the match `select` makes from the parsed program
 * reports, as `line: text`, in line order.
 */
export function findSourceLines(source: string, select: (program: Program) => SourceNodeMatch): readonly string[] {
    const lines = source.split('\n');
    const program = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true }).program;
    const matches = select(program);
    const found = new Set<number>();
    walkNodes(program, [], (node, ancestors) => {
        if (node.loc && matches(node, ancestors)) {
            found.add(node.loc.start.line);
        }
    });
    return [...found].sort((left, right) => left - right).map((line) => `${line}: ${lines[line - 1].trim()}`);
}
