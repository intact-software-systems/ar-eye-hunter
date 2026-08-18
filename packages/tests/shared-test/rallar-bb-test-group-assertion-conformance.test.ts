import { describe, expect, it } from 'vitest';

import {
    evaluateGroupAssertionConformanceCase,
    GROUP_ASSERTION_CONFORMANCE_CASES,
    GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
    GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
} from '@shared-test/rallar-bb-test/conformance/group-assertion-conformance.ts';
import {
    deepEqualJson,
} from '@shared-test/rallar-bb-test/distributed/group-assertions-aggregates.ts';
import {
    evaluateDistributedGroupAssertions,
} from '@shared-test/rallar-bb-test/distributed/group-assertions-evaluation.ts';
import { sameJsonValue } from '@shared-test/rallar-bb-test/wait/wait-event-match.ts';
import { CompareJson } from '@shared-test/json-compare/json-compare.ts';
import type { JsonValue } from '@shared-test/json-compare/CompareJson.ts';

describe('rallar-bb-test group assertion conformance', () => {
    it('covers every aggregate with a passing case and a deliberately-broken control', () => {
        const byAggregate = new Map<string, { pass: number; fail: number }>();
        for (const conformanceCase of GROUP_ASSERTION_CONFORMANCE_CASES) {
            const entry = byAggregate.get(conformanceCase.assertion.aggregate) ??
                { pass: 0, fail: 0 };
            if (conformanceCase.expected.ok) {
                entry.pass += 1;
            } else {
                entry.fail += 1;
            }
            byAggregate.set(conformanceCase.assertion.aggregate, entry);
        }
        for (const aggregate of [
            'allMatch',
            'noneMatch',
            'countMatching',
            'allEqual',
            'allEqualWithin',
        ]) {
            const entry = byAggregate.get(aggregate);
            expect(entry?.pass ?? 0, `${aggregate} passing case`).toBeGreaterThan(0);
            expect(entry?.fail ?? 0, `${aggregate} broken control`).toBeGreaterThan(0);
        }
    });

    for (const conformanceCase of GROUP_ASSERTION_CONFORMANCE_CASES) {
        it(`evaluates ${conformanceCase.caseId}: ${conformanceCase.intent}`, () => {
            const result = evaluateGroupAssertionConformanceCase(conformanceCase);
            expect(result.ok, conformanceCase.caseId).toBe(conformanceCase.expected.ok);
            if (conformanceCase.expected.code !== undefined) {
                expect(result.error?.code, conformanceCase.caseId)
                    .toBe(conformanceCase.expected.code);
            }
            if (conformanceCase.expected.violatingAgentIds !== undefined) {
                expect([...result.violatingAgentIds].sort(), conformanceCase.caseId)
                    .toEqual([...conformanceCase.expected.violatingAgentIds].sort());
            }
            if (conformanceCase.expected.missingAgentIds !== undefined) {
                expect([...result.missingAgentIds].sort(), conformanceCase.caseId)
                    .toEqual([...conformanceCase.expected.missingAgentIds].sort());
            }
        });
    }

    it('names both missing and violating agents in one failing evaluation', () => {
        const result = evaluateGroupAssertionConformanceCase({
            caseId: 'missing-and-violating',
            intent: 'Failure artifacts identify both missing and violating agents.',
            assertion: {
                groupAssertionId: 'missing-and-violating',
                aggregate: 'allMatch',
                predicate: { operator: 'equals', expected: 1 },
                source: {
                    recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
                    commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
                    path: 'observed',
                },
            },
            agents: [
                { agentId: 'agent-a', observed: 1 },
                { agentId: 'agent-b', observed: 2 },
                { agentId: 'agent-c', evidence: 'missing' },
            ],
            expected: { ok: false },
        });

        expect(result.missingAgentIds).toEqual(['agent-c']);
        expect(result.violatingAgentIds).toEqual(['agent-b']);
        expect(result.error?.code).toBe('RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING');
        const rows = Object.fromEntries(result.perAgent.map(row => [row.agentId, row]));
        expect(rows['agent-b'].verdict).toBe('not-matching');
        expect(rows['agent-c'].evidence).toBe('missing');
    });

    it('does not evaluate until every dispatched recipe result completed', () => {
        const manifest = {
            schemaVersion: 1 as const,
            distributedRunId: 'pending-run',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'conformance-room',
            },
            recipes: [{ recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID }],
            targetPolicy: { mode: 'all-online-group-members' as const },
            groupAssertions: [{
                groupAssertionId: 'pending',
                aggregate: 'allEqual' as const,
                source: {
                    recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
                    commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
                    path: 'observed',
                },
            }],
        };
        const pending = evaluateDistributedGroupAssertions({
            manifest,
            participants: [{ agentId: 'agent-a', roles: [] }],
            recipeResults: [{
                recipeKey: `agent-a:${GROUP_ASSERTION_CONFORMANCE_RECIPE_ID}`,
                agentId: 'agent-a',
                state: 'running',
            }],
            recipeEvidence: [],
        });
        expect(pending).toBeUndefined();

        const noAssertions = evaluateDistributedGroupAssertions({
            manifest: { ...manifest, groupAssertions: [] },
            participants: [{ agentId: 'agent-a', roles: [] }],
            recipeResults: [{
                recipeKey: `agent-a:${GROUP_ASSERTION_CONFORMANCE_RECIPE_ID}`,
                agentId: 'agent-a',
                state: 'passed',
            }],
            recipeEvidence: [],
        });
        expect(noAssertions).toBeUndefined();
    });

    it('redacts sensitive values in per-agent tables and error details', () => {
        const result = evaluateGroupAssertionConformanceCase({
            caseId: 'redaction',
            intent: 'Evidence values pass redaction before artifacts.',
            assertion: {
                groupAssertionId: 'redaction',
                aggregate: 'allEqual',
                source: {
                    recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
                    commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
                    path: 'observed',
                },
            },
            agents: [
                { agentId: 'agent-a', observed: { accessToken: 'secret-a', count: 1 } },
                { agentId: 'agent-b', observed: { accessToken: 'secret-b', count: 1 } },
            ],
            expected: { ok: false },
        });

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('secret-a');
        expect(serialized).not.toContain('secret-b');
        expect(result.violatingAgentIds.length).toBeGreaterThan(0);
    });

    it('keeps the three comparison vocabularies deliberately distinct', () => {
        const keyOrderLeft = { first: 1, second: [1, 2] };
        const keyOrderRight = { second: [1, 2], first: 1 };
        expect(deepEqualJson(keyOrderLeft, keyOrderRight)).toBe(true);
        expect(sameJsonValue(keyOrderLeft, keyOrderRight)).toBe(false);

        const arrayOrderLeft = { members: ['a', 'b'] } as unknown as JsonValue;
        const arrayOrderRight = { members: ['b', 'a'] } as unknown as JsonValue;
        expect(deepEqualJson(arrayOrderLeft, arrayOrderRight)).toBe(false);
        expect(CompareJson.exact(arrayOrderLeft, arrayOrderRight).isEqual).toBe(true);

        expect(deepEqualJson(0, -0)).toBe(true);
        expect(deepEqualJson({ a: undefined }, {})).toBe(false);
        expect(deepEqualJson([1, [2, 3]], [1, [2, 3]])).toBe(true);
        expect(deepEqualJson([1, [2, 3]], [1, [3, 2]])).toBe(false);
        expect(deepEqualJson(null, null)).toBe(true);
        expect(deepEqualJson(null, {})).toBe(false);
    });
});
