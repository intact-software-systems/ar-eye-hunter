// deno-lint-ignore-file no-explicit-any
import type {
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxDistributedGroupAssertionResult,
} from '../distributed/group-assertions.ts';
import {
    evaluateDistributedGroupAssertions,
} from '../distributed/group-assertions-evaluation.ts';
import type {
    DistributedGroupAssertionRecipeEvidence,
} from '../distributed/group-assertions-evidence.ts';

export const GROUP_ASSERTION_CONFORMANCE_RECIPE_ID = 'group-assertion-conformance-recipe';
export const GROUP_ASSERTION_CONFORMANCE_COMMAND_ID = 'group-assertion-probe';

export interface GroupAssertionConformanceAgent {
    readonly agentId: string;
    readonly role?: string;
    readonly observed?: any;
    readonly evidence?: 'resolved' | 'missing' | 'duplicate' | 'unresolved';
}

export interface GroupAssertionConformanceCase {
    readonly caseId: string;
    readonly intent: string;
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly agents: readonly GroupAssertionConformanceAgent[];
    readonly expected: Readonly<{
        ok: boolean;
        code?: string;
        violatingAgentIds?: readonly string[];
        missingAgentIds?: readonly string[];
    }>;
}

type GroupAssertionWithoutSource = RallarBlackBoxDistributedGroupAssertion extends infer Variant
    ? Variant extends RallarBlackBoxDistributedGroupAssertion ? Omit<Variant, 'source'> : never
    : never;

function conformanceAssertion(
    partial: GroupAssertionWithoutSource,
): RallarBlackBoxDistributedGroupAssertion {
    return {
        ...partial,
        source: {
            recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
            commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
            path: 'observed',
        },
    } as RallarBlackBoxDistributedGroupAssertion;
}

export const GROUP_ASSERTION_CONFORMANCE_CASES: readonly GroupAssertionConformanceCase[] = [
    {
        caseId: 'all-match-pass',
        intent: 'Every receiver observed exactly 100 messages.',
        assertion: conformanceAssertion({
            groupAssertionId: 'all-match-pass',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 100 },
        }),
        agents: [
            { agentId: 'agent-a', observed: 100 },
            { agentId: 'agent-b', observed: 100 },
            { agentId: 'agent-c', observed: 100 },
        ],
        expected: { ok: true },
    },
    {
        caseId: 'all-match-broken-control',
        intent: 'One receiver dropped a message, so allMatch names it.',
        assertion: conformanceAssertion({
            groupAssertionId: 'all-match-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 100 },
        }),
        agents: [
            { agentId: 'agent-a', observed: 100 },
            { agentId: 'agent-b', observed: 100 },
            { agentId: 'agent-c', observed: 99 },
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
            violatingAgentIds: ['agent-c'],
        },
    },
    {
        caseId: 'none-match-pass',
        intent: 'No agent observed the leaked frame marker.',
        assertion: conformanceAssertion({
            groupAssertionId: 'none-match-pass',
            aggregate: 'noneMatch',
            predicate: { operator: 'contains', expected: 'leak-probe' },
        }),
        agents: [
            { agentId: 'agent-a', observed: ['control-frame'] },
            { agentId: 'agent-b', observed: [] },
        ],
        expected: { ok: true },
    },
    {
        caseId: 'none-match-broken-control',
        intent: 'One leaked frame anywhere fails noneMatch with the offender.',
        assertion: conformanceAssertion({
            groupAssertionId: 'none-match-broken-control',
            aggregate: 'noneMatch',
            predicate: { operator: 'contains', expected: 'leak-probe' },
        }),
        agents: [
            { agentId: 'agent-a', observed: ['control-frame'] },
            { agentId: 'agent-b', observed: ['control-frame', 'leak-probe'] },
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
            violatingAgentIds: ['agent-b'],
        },
    },
    {
        caseId: 'count-matching-equals-pass',
        intent: 'Exactly one agent became leader.',
        assertion: conformanceAssertion({
            groupAssertionId: 'count-matching-equals-pass',
            aggregate: 'countMatching',
            predicate: { operator: 'equals', expected: 'leader' },
            count: { equals: 1 },
        }),
        agents: [
            { agentId: 'agent-a', observed: 'leader' },
            { agentId: 'agent-b', observed: 'follower' },
            { agentId: 'agent-c', observed: 'follower' },
        ],
        expected: { ok: true },
    },
    {
        caseId: 'count-matching-equals-broken-control',
        intent: 'A split brain elects two leaders and fails the exact count.',
        assertion: conformanceAssertion({
            groupAssertionId: 'count-matching-equals-broken-control',
            aggregate: 'countMatching',
            predicate: { operator: 'equals', expected: 'leader' },
            count: { equals: 1 },
        }),
        agents: [
            { agentId: 'agent-a', observed: 'leader' },
            { agentId: 'agent-b', observed: 'leader' },
            { agentId: 'agent-c', observed: 'follower' },
        ],
        expected: { ok: false, code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED' },
    },
    {
        caseId: 'count-matching-gte-pass',
        intent: 'A quorum of receivers against the frozen denominator.',
        assertion: conformanceAssertion({
            groupAssertionId: 'count-matching-gte-pass',
            aggregate: 'countMatching',
            predicate: { operator: 'gte', expected: 1 },
            count: { gte: 2 },
        }),
        agents: [
            { agentId: 'agent-a', observed: 3 },
            { agentId: 'agent-b', observed: 2 },
            { agentId: 'agent-c', observed: 0 },
        ],
        expected: { ok: true },
    },
    {
        caseId: 'count-matching-lte-broken-control',
        intent: 'More retries than the bound allows fails the run.',
        assertion: conformanceAssertion({
            groupAssertionId: 'count-matching-lte-broken-control',
            aggregate: 'countMatching',
            predicate: { operator: 'gte', expected: 1 },
            count: { lte: 1 },
        }),
        agents: [
            { agentId: 'agent-a', observed: 2 },
            { agentId: 'agent-b', observed: 1 },
            { agentId: 'agent-c', observed: 0 },
        ],
        expected: { ok: false, code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED' },
    },
    {
        caseId: 'all-equal-key-order-pass',
        intent: 'Deep equality ignores object key order across agents.',
        assertion: conformanceAssertion({
            groupAssertionId: 'all-equal-key-order-pass',
            aggregate: 'allEqual',
        }),
        agents: [
            { agentId: 'agent-a', observed: { revision: 7, members: ['a', 'b'] } },
            { agentId: 'agent-b', observed: { members: ['a', 'b'], revision: 7 } },
        ],
        expected: { ok: true },
    },
    {
        caseId: 'all-equal-broken-control',
        intent: 'A single disagreeing agent fails allEqual and is named.',
        assertion: conformanceAssertion({
            groupAssertionId: 'all-equal-broken-control',
            aggregate: 'allEqual',
        }),
        agents: [
            { agentId: 'agent-a', observed: { revision: 7 } },
            { agentId: 'agent-b', observed: { revision: 7 } },
            { agentId: 'agent-c', observed: { revision: 8 } },
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
            violatingAgentIds: ['agent-c'],
        },
    },
    {
        caseId: 'all-equal-array-order-broken-control',
        intent: 'Array order is significant, unlike json-compare exact mode.',
        assertion: conformanceAssertion({
            groupAssertionId: 'all-equal-array-order-broken-control',
            aggregate: 'allEqual',
        }),
        agents: [
            { agentId: 'agent-a', observed: { members: ['a', 'b'] } },
            { agentId: 'agent-b', observed: { members: ['b', 'a'] } },
        ],
        expected: { ok: false, code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED' },
    },
    {
        caseId: 'all-equal-within-pass',
        intent: 'Replicated counters differ by at most one.',
        assertion: conformanceAssertion({
            groupAssertionId: 'all-equal-within-pass',
            aggregate: 'allEqualWithin',
            tolerance: 1,
        }),
        agents: [
            { agentId: 'agent-a', observed: 10 },
            { agentId: 'agent-b', observed: 11 },
        ],
        expected: { ok: true },
    },
    {
        caseId: 'all-equal-within-broken-control',
        intent: 'A spread beyond the tolerance names the extreme holders.',
        assertion: conformanceAssertion({
            groupAssertionId: 'all-equal-within-broken-control',
            aggregate: 'allEqualWithin',
            tolerance: 1,
        }),
        agents: [
            { agentId: 'agent-a', observed: 10 },
            { agentId: 'agent-b', observed: 12 },
            { agentId: 'agent-c', observed: 11 },
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
            violatingAgentIds: ['agent-a', 'agent-b'],
        },
    },
    {
        caseId: 'missing-evidence-broken-control',
        intent: 'A frozen participant without evidence fails by default.',
        assertion: conformanceAssertion({
            groupAssertionId: 'missing-evidence-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'exists' },
        }),
        agents: [
            { agentId: 'agent-a', observed: 1 },
            { agentId: 'agent-b', evidence: 'missing' },
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING',
            missingAgentIds: ['agent-b'],
        },
    },
    {
        caseId: 'duplicate-evidence-broken-control',
        intent: 'Ambiguous duplicate evidence at the address fails by default.',
        assertion: conformanceAssertion({
            groupAssertionId: 'duplicate-evidence-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'exists' },
        }),
        agents: [
            { agentId: 'agent-a', observed: 1 },
            { agentId: 'agent-b', observed: 1, evidence: 'duplicate' },
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING',
        },
    },
    {
        caseId: 'unresolved-evidence-broken-control',
        intent: 'An address that does not resolve in the evidence fails by default.',
        assertion: conformanceAssertion({
            groupAssertionId: 'unresolved-evidence-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'exists' },
        }),
        agents: [
            { agentId: 'agent-a', observed: 1 },
            { agentId: 'agent-b', evidence: 'unresolved' },
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING',
        },
    },
    {
        caseId: 'min-participants-relaxation-pass',
        intent: 'minParticipants is the only explicit relaxation of the frozen set.',
        assertion: conformanceAssertion({
            groupAssertionId: 'min-participants-relaxation-pass',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 5 },
            minParticipants: 2,
        }),
        agents: [
            { agentId: 'agent-a', observed: 5 },
            { agentId: 'agent-b', observed: 5 },
            { agentId: 'agent-c', evidence: 'missing' },
        ],
        expected: { ok: true },
    },
    {
        caseId: 'role-scope-pass',
        intent: 'scope.role narrows the frozen participant set to one role.',
        assertion: conformanceAssertion({
            groupAssertionId: 'role-scope-pass',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 'delivered' },
            scope: { role: 'receiver' },
        }),
        agents: [
            { agentId: 'agent-a', role: 'sender', observed: 'sent' },
            { agentId: 'agent-b', role: 'receiver', observed: 'delivered' },
            { agentId: 'agent-c', role: 'receiver', observed: 'delivered' },
        ],
        expected: { ok: true },
    },
    {
        caseId: 'role-scope-no-participants-broken-control',
        intent: 'A role held by nobody in the frozen set fails closed.',
        assertion: conformanceAssertion({
            groupAssertionId: 'role-scope-no-participants-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'exists' },
            scope: { role: 'observer' },
        }),
        agents: [
            { agentId: 'agent-a', role: 'sender', observed: 1 },
            { agentId: 'agent-b', role: 'receiver', observed: 1 },
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS',
        },
    },
];

export function evaluateGroupAssertionConformanceCase(
    conformanceCase: GroupAssertionConformanceCase,
): RallarBlackBoxDistributedGroupAssertionResult {
    const results = evaluateDistributedGroupAssertions({
        manifest: toConformanceManifest(conformanceCase),
        participants: conformanceCase.agents.map(agent => ({
            agentId: agent.agentId,
            roles: agent.role === undefined ? [] : [agent.role],
        })),
        recipeResults: conformanceCase.agents.map(agent => ({
            recipeKey: `${agent.agentId}:${GROUP_ASSERTION_CONFORMANCE_RECIPE_ID}`,
            recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
            agentId: agent.agentId,
            state: 'passed' as const,
            ok: true,
        })),
        recipeEvidence: conformanceCase.agents.flatMap(toConformanceEvidence),
    });
    if (!results || results.length !== 1) {
        throw new Error(`Conformance case ${conformanceCase.caseId} did not evaluate.`);
    }
    return results[0];
}

function toConformanceManifest(conformanceCase: GroupAssertionConformanceCase): any {
    return {
        schemaVersion: 1,
        distributedRunId: `conformance-${conformanceCase.caseId}`,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'conformance-room',
        },
        recipes: [{ recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID }],
        targetPolicy: { mode: 'all-online-group-members' },
        groupAssertions: [conformanceCase.assertion],
    };
}

function toConformanceEvidence(
    agent: GroupAssertionConformanceAgent,
): readonly DistributedGroupAssertionRecipeEvidence[] {
    const evidence = agent.evidence ?? 'resolved';
    if (evidence === 'missing') {
        return [];
    }
    const commandResult = (observedValue: any) => ({
        commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
        kind: 'health',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 1_000,
        endedAtEpochMs: 1_001,
        durationMs: 1,
        value: observedValue,
    });
    const resultValue = evidence === 'unresolved'
        ? { results: [commandResult({ somethingElse: true })] }
        : evidence === 'duplicate'
        ? {
            results: [
                commandResult({ observed: agent.observed }),
                commandResult({ observed: agent.observed }),
            ],
        }
        : { results: [commandResult({ observed: agent.observed })] };
    return [{
        agentId: agent.agentId,
        recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
        role: agent.role,
        hasResult: true,
        resultValue,
    }];
}
