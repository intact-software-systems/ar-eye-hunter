import {
    describe,
    expect,
    it
} from 'vitest';

import type { JsonValue } from '@shared-test/json-compare/compare-json-values.ts';
import { CompareJson } from '@shared-test/json-compare/json-compare.ts';
import {
    computeGroupAssertionConformanceResult,
    GROUP_ASSERTION_CONFORMANCE_CASES,
    GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
    GROUP_ASSERTION_CONFORMANCE_RECIPE_ID
} from '@shared-test/rallar-bb-test/conformance/group-assertion-conformance.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { deepEqualJson } from '@shared-test/rallar-bb-test/distributed/group-assertions-aggregates.ts';
import { computeDistributedGroupAssertionResults } from '@shared-test/rallar-bb-test/distributed/group-assertions-evaluation.ts';
import type { DistributedGroupAssertionRecipeEvidence } from '@shared-test/rallar-bb-test/distributed/group-assertions-evidence.ts';
import type { RallarBlackBoxGroupAssertionValue } from '@shared-test/rallar-bb-test/distributed/group-assertions.ts';
import type {
    RallarBlackBoxTestLoopChildResult,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isSameJsonValue } from '@shared-test/rallar-bb-test/wait/wait-event-match.ts';

const PROBE_LOOP_COMMAND_ID = 'probe-loop';

function toGroupAssertionManifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'group-assertion-run',
        controlRunId: 'group-assertion-run',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'conformance-room'
        },
        recipes: [{
            recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
            variables: {}
        }],
        targetPolicy: { mode: 'all-online-group-members' },
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        startMode: 'manual',
        groupAssertions: [{
            groupAssertionId: 'every-probe-observed-seven',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 7 },
            source: {
                recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
                commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
                path: 'observed'
            }
        }],
        metadata: {}
    };
}

function toProbeResult(commandId: string, observed: number): RallarBlackBoxTestResult {
    return {
        commandId,
        kind: 'health',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 1_000,
        endedAtEpochMs: 1_001,
        durationMs: 1,
        value: { observed }
    };
}

function toProbeLoopChild(originalCommandId: string, commandIndex: number): RallarBlackBoxTestLoopChildResult {
    const commandId = `${PROBE_LOOP_COMMAND_ID}:i1:c${commandIndex + 1}:${originalCommandId}`;
    return {
        commandId,
        originalCommandId,
        parentCommandId: PROBE_LOOP_COMMAND_ID,
        path: `$.iterations[1].commands[${commandIndex}]`,
        sourceRecipePath: `$.commands[${commandIndex}]`,
        childIndex: commandIndex,
        commandIndex,
        iteration: 1,
        result: toProbeResult(commandId, 7)
    };
}

function toProbeLoopEvidence(
    agentId: string,
    children: readonly RallarBlackBoxGroupAssertionValue[]
): DistributedGroupAssertionRecipeEvidence {
    return toRecipeEvidence(agentId, {
        ...toProbeResult(PROBE_LOOP_COMMAND_ID, 7),
        kind: 'loop',
        value: {
            commandId: PROBE_LOOP_COMMAND_ID,
            iterations: 1,
            childResultCount: children.length,
            passed: children.length,
            failed: 0,
            cancelled: false,
            results: children
        }
    });
}

function toRecipeEvidence(
    agentId: string,
    rootResult: RallarBlackBoxGroupAssertionValue
): DistributedGroupAssertionRecipeEvidence {
    return {
        agentId,
        recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
        hasResult: true,
        resultValue: { results: [rootResult] }
    };
}

describe('rallar-bb-test group assertion conformance', () => {
    it('covers every aggregate with a passing case and a deliberately-broken control', () => {
        const byAggregate = new Map<string, { pass: number; fail: number; }>();
        for (const conformanceCase of GROUP_ASSERTION_CONFORMANCE_CASES) {
            const entry = byAggregate.get(conformanceCase.assertion.aggregate) ??
                { pass: 0, fail: 0 };
            if (conformanceCase.expected.ok) {
                entry.pass += 1;
            }
            else {
                entry.fail += 1;
            }
            byAggregate.set(conformanceCase.assertion.aggregate, entry);
        }
        for (
            const aggregate of [
                'allMatch',
                'noneMatch',
                'countMatching',
                'allEqual',
                'allEqualWithin'
            ]
        ) {
            const entry = byAggregate.get(aggregate);
            expect(entry?.pass ?? 0, `${aggregate} passing case`).toBeGreaterThan(0);
            expect(entry?.fail ?? 0, `${aggregate} broken control`).toBeGreaterThan(0);
        }
    });

    for (const conformanceCase of GROUP_ASSERTION_CONFORMANCE_CASES) {
        it(`evaluates ${conformanceCase.caseId}: ${conformanceCase.intent}`, () => {
            const result = computeGroupAssertionConformanceResult(conformanceCase);
            const { expected } = conformanceCase;
            expect(result.ok, conformanceCase.caseId).toBe(expected.ok);
            if (expected.ok) {
                return;
            }
            if (expected.code !== undefined) {
                expect(result.error?.code, conformanceCase.caseId).toBe(expected.code);
            }
            if (expected.violatingAgentIds !== undefined) {
                expect([...result.violatingAgentIds].sort(), conformanceCase.caseId)
                    .toEqual([...expected.violatingAgentIds].sort());
            }
            if (expected.missingAgentIds !== undefined) {
                expect([...result.missingAgentIds].sort(), conformanceCase.caseId)
                    .toEqual([...expected.missingAgentIds].sort());
            }
        });
    }

    it('names both missing and violating agents in one failing evaluation', () => {
        const result = computeGroupAssertionConformanceResult({
            caseId: 'missing-and-violating',
            intent: 'Failure artifacts identify both missing and violating agents.',
            assertion: {
                groupAssertionId: 'missing-and-violating',
                aggregate: 'allMatch',
                predicate: { operator: 'equals', expected: 1 },
                source: {
                    recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
                    commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
                    path: 'observed'
                }
            },
            agents: [
                { agentId: 'agent-a', evidence: 'resolved', observed: 1 },
                { agentId: 'agent-b', evidence: 'resolved', observed: 2 },
                { agentId: 'agent-c', evidence: 'missing' }
            ],
            expected: { ok: false }
        });

        expect(result.missingAgentIds).toEqual(['agent-c']);
        expect(result.violatingAgentIds).toEqual(['agent-b']);
        expect(result.error?.code).toBe('RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING');
        const rows = Object.fromEntries(result.perAgent.map((row) => [row.agentId, row]));
        expect(rows['agent-b']).toMatchObject({ evidence: 'resolved', verdict: 'not-matching' });
        expect(rows['agent-c'].evidence).toBe('missing');
    });

    it('does not evaluate until every dispatched recipe result completed', () => {
        const manifest = toGroupAssertionManifest();
        const pending = computeDistributedGroupAssertionResults({
            manifest,
            participants: [{ agentId: 'agent-a', roles: [] }],
            recipeResults: [{
                recipeKey: `agent-a:${GROUP_ASSERTION_CONFORMANCE_RECIPE_ID}`,
                agentId: 'agent-a',
                state: 'running'
            }],
            recipeEvidence: []
        });
        expect(pending).toBeUndefined();

        const noAssertions = computeDistributedGroupAssertionResults({
            manifest: { ...manifest, groupAssertions: [] },
            participants: [{ agentId: 'agent-a', roles: [] }],
            recipeResults: [{
                recipeKey: `agent-a:${GROUP_ASSERTION_CONFORMANCE_RECIPE_ID}`,
                agentId: 'agent-a',
                state: 'passed'
            }],
            recipeEvidence: []
        });
        expect(noAssertions).toBeUndefined();
    });

    it('reports evidence inside command results that do not decode as undecodable and keeps decodable sibling evidence', () => {
        const agentIds = ['agent-a', 'agent-b', 'agent-c'];
        const probeChild = toProbeLoopChild(GROUP_ASSERTION_CONFORMANCE_COMMAND_ID, 0);
        const results = computeDistributedGroupAssertionResults({
            manifest: toGroupAssertionManifest(),
            participants: agentIds.map((agentId) => ({ agentId, roles: [] })),
            recipeResults: agentIds.map((agentId) => ({
                recipeKey: `${agentId}:${GROUP_ASSERTION_CONFORMANCE_RECIPE_ID}`,
                recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
                agentId,
                state: 'passed',
                ok: true
            })),
            recipeEvidence: [
                toProbeLoopEvidence('agent-a', [
                    probeChild,
                    { ...toProbeLoopChild('other-read', 1), result: { ...probeChild.result, error: { code: 'X' } } }
                ]),
                toProbeLoopEvidence('agent-b', [{ ...probeChild, path: undefined }]),
                toRecipeEvidence('agent-c', { commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID, kind: 'health' })
            ]
        });

        const result = results?.[0];
        expect(result?.ok).toBe(false);
        expect(result?.missingAgentIds).toEqual([]);
        expect(result?.perAgent).toEqual([
            { agentId: 'agent-a', evidence: 'resolved', verdict: 'matching', value: 7 },
            { agentId: 'agent-b', evidence: 'undecodable' },
            { agentId: 'agent-c', evidence: 'undecodable' }
        ]);
        expect(result?.error?.code).toBe('RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING');
        expect(result?.error?.message).toContain('from: agent-b (undecodable), agent-c (undecodable).');
    });

    it('redacts sensitive values in per-agent tables and error details', () => {
        const result = computeGroupAssertionConformanceResult({
            caseId: 'redaction',
            intent: 'Evidence values pass redaction before artifacts.',
            assertion: {
                groupAssertionId: 'redaction',
                aggregate: 'allEqual',
                source: {
                    recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
                    commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
                    path: 'observed'
                }
            },
            agents: [
                { agentId: 'agent-a', evidence: 'resolved', observed: { accessToken: 'secret-a', count: 1 } },
                { agentId: 'agent-b', evidence: 'resolved', observed: { accessToken: 'secret-b', count: 1 } }
            ],
            expected: { ok: false }
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
        expect(isSameJsonValue(keyOrderLeft, keyOrderRight)).toBe(false);

        const arrayOrderLeft: JsonValue = { members: ['a', 'b'] };
        const arrayOrderRight: JsonValue = { members: ['b', 'a'] };
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
