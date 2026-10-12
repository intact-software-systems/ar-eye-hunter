import { describe, expect, it } from 'vitest';

import {
    computeGroupAssertionConformanceResult,
    GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
    GROUP_ASSERTION_CONFORMANCE_RECIPE_ID
} from '../../../shared-test/rallar-bb-test/conformance/group-assertion-conformance.ts';
import { decodeControlDistributedRunSnapshot } from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import type { RallarBlackBoxDistributedGroupAssertionResult } from '../../../shared-test/rallar-bb-test/distributed/group-assertions.ts';
import {
    createDistributedRunManifest,
    createDistributedRunSnapshot
} from './distributed-artifact-files-fixture.ts';

const SOURCE = {
    recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
    commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
    path: 'observed'
};
const ASSERTION = {
    groupAssertionId: 'recipient-sessions-match',
    aggregate: 'sameUniqueStringSetAsRole' as const,
    source: SOURCE,
    scope: { role: 'sender' },
    comparison: { role: 'receiver', source: SOURCE }
};

function produceRoleSetResult(
    senderSessions: readonly string[],
    expectedOk: boolean
): RallarBlackBoxDistributedGroupAssertionResult {
    return computeGroupAssertionConformanceResult({
        caseId: 'recipient-sessions-match',
        intent: 'A sender names exactly the frozen receiver connection sessions.',
        assertion: ASSERTION,
        agents: [
            { agentId: 'agent-sender', role: 'sender', evidence: 'resolved', observed: [...senderSessions] },
            { agentId: 'agent-receiver', role: 'receiver', evidence: 'resolved', observed: 'receiver-session' }
        ],
        expected: expectedOk ? { ok: true } : { ok: false }
    });
}

function toSerializedTerminalSnapshot(result: Readonly<{ ok: boolean; }>): object {
    const agentIds = ['agent-sender', 'agent-receiver'];
    const manifest = createDistributedRunManifest({
        distributedRunId: 'terminal-role-set',
        controlRunId: 'control-role-set',
        agentIds,
        recipes: [{ recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID, variables: {} }]
    });
    const snapshot = createDistributedRunSnapshot({
        distributedRunId: manifest.distributedRunId,
        controlRunId: manifest.controlRunId,
        state: result.ok ? 'passed' : 'failed',
        agentIds,
        manifest: {
            ...manifest,
            roleAssignments: [
                {
                    role: 'sender',
                    agentId: 'agent-sender',
                    recipeIds: [GROUP_ASSERTION_CONFORMANCE_RECIPE_ID],
                    variables: {}
                },
                {
                    role: 'receiver',
                    agentId: 'agent-receiver',
                    recipeIds: [GROUP_ASSERTION_CONFORMANCE_RECIPE_ID],
                    variables: {}
                }
            ],
            groupAssertions: [ASSERTION]
        },
        summary: {
            passedParticipants: 2,
            failedParticipants: 0,
            recipes: 2,
            passedRecipes: 2,
            failedRecipes: 0,
            groupAssertions: 1,
            passedGroupAssertions: result.ok ? 1 : 0,
            failedGroupAssertions: result.ok ? 0 : 1,
            blockingFailures: result.ok ? 0 : 1
        },
        failures: result.ok ? [] : [{ kind: 'group-assertion', key: ASSERTION.groupAssertionId, state: 'failed' }]
    });
    return JSON.parse(JSON.stringify({
        ...snapshot,
        rollup: { ...snapshot.rollup, groupAssertions: [result] }
    }));
}

describe('terminal group assertion decoding', () => {
    it('round-trips a produced role-set equality result with its counts and resolved rows', () => {
        const produced = produceRoleSetResult(['receiver-session'], true);

        expect(produced).toMatchObject({
            aggregate: 'sameUniqueStringSetAsRole',
            ok: true,
            participants: { expected: 2, required: 2, withEvidence: 2 },
            missingAgentIds: [],
            violatingAgentIds: [],
            perAgent: [
                { agentId: 'agent-sender', role: 'sender', evidence: 'resolved', verdict: 'agreeing' },
                { agentId: 'agent-receiver', role: 'receiver', evidence: 'resolved', verdict: 'agreeing' }
            ]
        });

        const decoded = decodeControlDistributedRunSnapshot(toSerializedTerminalSnapshot(produced));

        expect(decoded.left).toBeUndefined();
        expect(decoded.right?.rollup.groupAssertions).toEqual([produced]);
    });

    it('round-trips a produced role-set mismatch without changing the failed verdict', () => {
        const produced = produceRoleSetResult(['other-session'], false);

        expect(produced).toMatchObject({
            aggregate: 'sameUniqueStringSetAsRole',
            ok: false,
            participants: { expected: 2, required: 2, withEvidence: 2 },
            missingAgentIds: [],
            violatingAgentIds: ['agent-sender'],
            perAgent: [
                { agentId: 'agent-sender', evidence: 'resolved', verdict: 'violating' },
                { agentId: 'agent-receiver', evidence: 'resolved', verdict: 'agreeing' }
            ],
            error: { code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED' }
        });

        const decoded = decodeControlDistributedRunSnapshot(toSerializedTerminalSnapshot(produced));

        expect(decoded.left).toBeUndefined();
        expect(decoded.right?.rollup.groupAssertions).toEqual([produced]);
    });

    it.each([
        {
            name: 'unknown aggregate',
            change: (result: RallarBlackBoxDistributedGroupAssertionResult) => ({ ...result, aggregate: 'unrecognized' }),
            issue: 'rollup.groupAssertions[0].aggregate must be a group assertion aggregate'
        },
        {
            name: 'missing equality count',
            change: (result: RallarBlackBoxDistributedGroupAssertionResult) => ({
                ...result,
                participants: { expected: 2, required: 2 }
            }),
            issue: 'rollup.groupAssertions[0].participants must count expected, required and withEvidence participants'
        },
        {
            name: 'resolved row without verdict',
            change: (result: RallarBlackBoxDistributedGroupAssertionResult) => ({
                ...result,
                perAgent: [{ agentId: 'agent-sender', role: 'sender', evidence: 'resolved', value: ['receiver-session'] }]
            }),
            issue: 'rollup.groupAssertions[0].perAgent[0].verdict must be a group assertion verdict for resolved evidence'
        }
    ])('rejects a $name in a role-set terminal result', ({ change, issue }) => {
        const malformed = change(produceRoleSetResult(['receiver-session'], true));

        const decoded = decodeControlDistributedRunSnapshot(toSerializedTerminalSnapshot(malformed));

        expect(decoded.left).toBe(issue);
    });
});
