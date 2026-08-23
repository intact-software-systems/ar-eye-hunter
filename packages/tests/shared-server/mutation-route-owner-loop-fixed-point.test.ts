import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import {
    createMutationBoundaryLexicalValues,
    mutationBoundaryLexicalValuesEqual,
    withExecutedMutationBoundaryLexicalWrite,
    withMutationBoundaryLexicalOverrides,
    type MutationBoundaryLexicalValues
} from './mutation-boundary-lexical-values.ts';
import { executeMutationPaths } from './mutation-execution-outcomes.ts';
import type { MutationExecutionAstNode as AstNode } from './mutation-execution-path-state.ts';
import { readGroupOwnerAnchors } from './mutation-route-owner-anchors.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from './mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
const { collection: LIVE_GROUP_COLLECTION, loopStart: LOOP_START, loopEnd: LOOP_END, classStart: CLASS_START } = readGroupOwnerAnchors();
const TYPE_MAP = `const C18_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;

interface SourceExecutionState {
    readonly lexical: MutationBoundaryLexicalValues;
}

describe('Mutation route owner loop fixed-point contracts', () => {
    it('keeps boundary writes reachable after per-path false next tests', () => {
        const root = `${FIXTURES}/c18-loop-next-test-writes.ts`;
        expect(findMutationBoundaryViolationsFromRoots([root])).toEqual([
            expect.objectContaining({
                filePath: root,
                directMutatorCalls: [
                    'ClientStateRepository.deletePrincipal',
                    'ClientStateRepository.insertPrincipal',
                    'ClientStateRepository.updatePrincipal'
                ]
            })
        ]);
    });

    it.each([
        `let active = true;
      for (; active; active = false) {}`,
        `let active = true;
      for (; active;) { active = false; }`,
        `let active = true;
      while (active) { active = false; }`
    ])('reaches post-loop routing after an entered candidate makes its next test false', (loop) => {
        const issues = validateInvocations(`${loop}
      registerC18(undefined, 'values');`);
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('keeps zero-iteration exit plus entered divergence when an unknown test becomes true', () => {
        const issues = validateInvocations(
            `let active = c18InitiallyActive;
      while (active) {
        registerC18(undefined, 'keys');
        active = true;
      }
      registerC18(undefined, 'values');`,
            'declare const c18InitiallyActive: boolean;'
        );
        expectNeitherProjection(issues);
    });

    it('guarantees the post-loop registration when an unknown test becomes false', () => {
        const issues = validateInvocations(
            `let active = c18InitiallyActive;
      while (active) {
        registerC18(undefined, 'keys');
        active = false;
      }
      registerC18(undefined, 'values');`,
            'declare const c18InitiallyActive: boolean;'
        );
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('uses each continuing candidate state for its own next-test truth', () => {
        const issues = validateInvocations(
            `let active = true;
      while (active) {
        if (c18ChooseExit) {
          registerC18(undefined, 'values');
          active = false;
        } else {
          registerC18(undefined, 'keys');
          active = true;
        }
      }
      registerC18(undefined, 'keys');`,
            'declare const c18ChooseExit: boolean;'
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it.each(
        [
            [
                `let active = true;
       for (; active; active = false) {}`,
                ['normal'],
                ['marker']
            ],
            [
                `let active = true;
       for (; active;) { active = false; }`,
                ['normal'],
                ['marker']
            ],
            [
                `let active = true;
       while (active) { active = false; }`,
                ['normal'],
                ['marker']
            ],
            [
                `let active = initiallyActive;
       while (active) { active = true; }`,
                ['diverge', 'normal'],
                ['marker']
            ],
            [
                `let active = initiallyActive;
       while (active) { active = false; }`,
                ['normal', 'normal'],
                ['marker', 'marker']
            ],
            [
                `let active = true;
       while (active) {
         if (chooseExit) active = false;
         else active = true;
       }`,
                ['diverge', 'normal'],
                ['marker']
            ]
        ] as const
    )(
        're-evaluates a next test against the candidate state: %s',
        (loop, completions, calls) => {
            expect(executeSource(`${loop}\nmarker();`)).toEqual({ calls, completions });
        }
    );

    it('keeps literal, no-test, break, continue, and do-while controls exact', () => {
        expect(executeSource('while (false) {}\nmarker();')).toEqual({
            calls: ['marker'],
            completions: ['normal']
        });
        expect(executeSource('while (true) {}\nmarker();')).toEqual({
            calls: [],
            completions: ['diverge']
        });
        expect(executeSource('for (;;) {}\nmarker();')).toEqual({
            calls: [],
            completions: ['diverge']
        });
        expect(
            executeSource(`let active = true;
      for (; active; active = false) { break; }
      marker();`)
        ).toEqual({ calls: ['marker'], completions: ['normal'] });
        expect(
            executeSource(`let active = true;
      for (; active; active = false) { continue; }
      marker();`)
        ).toEqual({ calls: ['marker'], completions: ['normal'] });
        expect(
            executeSource(`let active = true;
      do { active = false; } while (active);
      marker();`)
        ).toEqual({ calls: ['marker'], completions: ['normal'] });
    });

    it('keeps unsupported executed writes conservative and bounded', () => {
        expect(
            executeSource(`const state = { active: true };
      while (state.active) { state.active = false; }
      marker();`).completions
        ).toEqual(['diverge', 'normal']);
        expect(
            executeSource(`let active = true;
      while (active) { active -= 1; }
      marker();`).completions
        ).toEqual(['diverge', 'normal']);

        const conditions = Array.from(
            { length: 12 },
            (_, index) => `if (flag${index}) active = false; else active = true;`
        ).join('\n');
        const execution = executeSource(`let active = true;
      while (active) { ${conditions} }
      marker();`);
        expect(execution.completions).toEqual(['diverge', 'normal']);
        expect(execution.calls).toEqual(['marker']);
    });

    it('does not coalesce different lexical candidate multisets', () => {
        const program = parse('let active = true;', { sourceType: 'module' })
            .program as unknown as AstNode;
        const lexical = createMutationBoundaryLexicalValues(program);
        const exactTrue: AstNode = { type: 'BooleanLiteral', value: true };
        const left = withMutationBoundaryLexicalOverrides(
            lexical,
            new Map([['binding:test', { values: [exactTrue, exactTrue], unknown: false }]])
        );
        const right = withMutationBoundaryLexicalOverrides(
            lexical,
            new Map([
                [
                    'binding:test',
                    {
                        values: [
                            { type: 'BooleanLiteral', value: true },
                            { type: 'BooleanLiteral', value: false }
                        ],
                        unknown: false
                    }
                ]
            ])
        );

        expect(mutationBoundaryLexicalValuesEqual(left, right)).toBe(false);
    });
});

function executeSource(body: string): Readonly<{
    calls: readonly string[];
    completions: readonly string[];
}> {
    const program = parse(
        `function inspect(initiallyActive: boolean, chooseExit: boolean) {
    ${body}
  }`,
        { sourceType: 'module', plugins: ['typescript'] }
    ).program as unknown as AstNode;
    const root = (program.body as readonly AstNode[])[0]!;
    const calls: string[] = [];
    const paths = executeMutationPaths(
        root,
        [
            {
                lexical: createMutationBoundaryLexicalValues(program)
            }
        ],
        {
            lexical: (state) => state.lexical,
            nestedFunctions: 'skip',
            statesEqual: (left, right) => mutationBoundaryLexicalValuesEqual(left.lexical, right.lexical),
            visit: (node, state) => {
                if (node.type === 'CallExpression') {
                    const callee = asNode(node.callee);
                    if (callee?.type === 'Identifier' && typeof callee.name === 'string') {
                        calls.push(callee.name);
                    }
                }
                return state;
            },
            writeLexical: (node: AstNode, state: SourceExecutionState) => ({
                lexical: withExecutedMutationBoundaryLexicalWrite(state.lexical, node)
            })
        }
    );
    return {
        calls,
        completions: paths.map((path) => path.completion.kind).toSorted()
    };
}

function validateInvocations(invocation: string, topLevel = ''): readonly string[] {
    const source = readFileSync(GROUP_OWNER, 'utf8');
    let mutated = source.replace(CLASS_START, `${TYPE_MAP}\n${topLevel}\n\n${CLASS_START}`);
    mutated = mutated.replace(
        LOOP_START,
        `        function registerC18(
            _ignored: unknown = undefined,
            MAP_METHOD = 'keys',
        ): void {\n${LOOP_START}`
    );
    mutated = mutated.replace(LOOP_END, `        }\n        ${invocation}\n${LOOP_END}`);
    mutated = mutated.replace(LIVE_GROUP_COLLECTION, 'C18_TYPE_MAP[MAP_METHOD]()');
    expect(mutated).not.toBe(source);
    return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[GROUP_OWNER, mutated]])
    });
}

function expectNeitherProjection(issues: readonly string[]): void {
    expectMissing(issues, 'GROUP_CREATE');
    expectMissing(issues, 'GROUP_UPDATE');
}

function expectProjection(issues: readonly string[], connected: string, missing: string): void {
    expect(hasMissingIssue(issues, connected)).toBe(false);
    expectMissing(issues, missing);
}

function hasMissingIssue(issues: readonly string[], type: string): boolean {
    return issues.some((issue) => issue.includes(`${type} owner dispatch is not connected`));
}

function expectMissing(issues: readonly string[], type: string): void {
    expect(hasMissingIssue(issues, type)).toBe(true);
}

function asNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as AstNode)
        : undefined;
}
