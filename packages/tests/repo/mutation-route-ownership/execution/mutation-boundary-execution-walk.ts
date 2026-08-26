import type { MutationBoundaryCapabilityAstNode as AstNode } from '../boundary/capabilities/mutation-boundary-capability-ast.ts';

import {
    mutationBoundaryLexicalValuesEqual,
    withExecutedMutationBoundaryLexicalWrite,
    type MutationBoundaryLexicalValues
} from '../boundary/lexical/mutation-boundary-lexical-values.ts';
import { executeMutationPaths } from './mutation-execution-outcomes.ts';
import type { ExecutionBranch } from './mutation-execution-path-state.ts';

export type { ExecutionBranch } from './mutation-execution-path-state.ts';

export interface ExecutionWalkOptions {
    readonly lexical?: MutationBoundaryLexicalValues;
    readonly nestedFunctions?: 'include' | 'skip';
}

export interface ExecutionVisitContext {
    readonly branches: readonly ExecutionBranch[];
    readonly conditional: boolean;
}

export function walkExecution(
    value: AstNode,
    visit: (node: AstNode, context: ExecutionVisitContext) => void,
    options: ExecutionWalkOptions = {}
): void {
    executeMutationPaths(value, [options.lexical], {
        lexical: (lexical) => lexical,
        nestedFunctions: options.nestedFunctions ?? 'skip',
        statesEqual: mutationBoundaryLexicalValuesEqual,
        visit: (node, lexical, context) => {
            visit(node as AstNode, context);
            return lexical;
        },
        writeLexical: (node, lexical) => lexical ? withExecutedMutationBoundaryLexicalWrite(lexical, node) : lexical
    });
}

export function walkReachableAst(
    value: AstNode,
    visit: (node: AstNode, context: ExecutionVisitContext) => void,
    options: Omit<ExecutionWalkOptions, 'nestedFunctions'> = {}
): void {
    walkExecution(value, visit, { ...options, nestedFunctions: 'include' });
}

export function walkAll(value: unknown, visit: (node: AstNode) => void): void {
    if (!value || typeof value !== 'object') {
        return;
    }
    if (Array.isArray(value)) {
        for (const child of value) {
            walkAll(child, visit);
        }
        return;
    }
    const node = value as AstNode;
    if (typeof node.type === 'string') {
        visit(node);
    }
    for (const [key, child] of Object.entries(node)) {
        if (!IGNORED_KEYS.has(key)) {
            walkAll(child, visit);
        }
    }
}

export function isCall(node: AstNode): boolean {
    return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}

export function readPosition(node: AstNode): number {
    return typeof node.start === 'number' ? node.start : Number.MAX_SAFE_INTEGER;
}

const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
