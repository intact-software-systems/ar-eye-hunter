import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

import { executeMutationPaths } from './mutation-execution-outcomes.ts';
import type { MutationExecutionAstNode as AstNode } from './mutation-execution-path-state.ts';

describe('Mutation route owner execution state contracts', () => {
    it('coalesces equivalent states at every nested logical junction', () => {
        const root = parseFunction(`function inspect(first, second, third, fourth, fifth, last) {
      first || second || third || fourth || fifth || last;
    }`);
        let lastVisits = 0;
        const paths = executeMutationPaths(root, [undefined], {
            lexical: () => undefined,
            nestedFunctions: 'skip',
            statesEqual: () => true,
            visit: (node, state) => {
                if (node.type === 'Identifier' && node.name === 'last') {
                    lastVisits += 1;
                }
                return state;
            }
        });

        expect(lastVisits).toBe(1);
        expect(paths).toHaveLength(1);
    });

    it('does not coalesce normal and abrupt alternatives', () => {
        const root = parseFunction(`function inspect(stop) {
      if (stop) {
        return;
      }
      marker();
    }`);
        let markerVisits = 0;
        const paths = executeMutationPaths(root, [undefined], {
            lexical: () => undefined,
            nestedFunctions: 'skip',
            statesEqual: () => true,
            visit: (node, state) => {
                if (node.type === 'CallExpression') {
                    markerVisits += 1;
                }
                return state;
            }
        });

        expect(markerVisits).toBe(1);
        expect(paths.map((path) => path.completion.kind).toSorted()).toEqual(['normal', 'return']);
    });

    it('retains distinct routing-like state values when coalescing is disabled', () => {
        const root = parseFunction(`function inspect(flag) {
      if (flag) {
        left;
      } else {
        right;
      }
    }`);
        const paths = executeMutationPaths(root, [''], {
            lexical: () => undefined,
            nestedFunctions: 'skip',
            visit: (node, state) =>
                node.type === 'Identifier' && (node.name === 'left' || node.name === 'right')
                    ? node.name
                    : state
        });

        expect(paths.map((path) => path.state).toSorted()).toEqual(['left', 'right']);
    });
});

function parseFunction(source: string): AstNode {
    return parse(source, { sourceType: 'module' }).program.body[0] as AstNode;
}
