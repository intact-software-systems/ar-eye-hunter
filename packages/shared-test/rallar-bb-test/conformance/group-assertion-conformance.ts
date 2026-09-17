import type { RallarBlackBoxDistributedRunManifest } from '../distributed-run.ts';
import { computeDistributedGroupAssertionResults } from '../distributed/group-assertions-evaluation.ts';
import type { DistributedGroupAssertionRecipeEvidence } from '../distributed/group-assertions-evidence.ts';
import type {
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxDistributedGroupAssertionResult,
    RallarBlackBoxGroupAssertionValue
} from '../distributed/group-assertions.ts';
import type { RallarBlackBoxTestRecord, RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';

export const GROUP_ASSERTION_CONFORMANCE_RECIPE_ID = 'group-assertion-conformance-recipe';
export const GROUP_ASSERTION_CONFORMANCE_COMMAND_ID = 'group-assertion-probe';

export interface GroupAssertionConformanceAgentIdentity {
    readonly agentId: string;
    /** Absent when the frozen participant holds no role. */
    readonly role?: string;
}

/** The agent reported the observed value once, or twice at the same address. */
export interface GroupAssertionConformanceReportingAgent extends GroupAssertionConformanceAgentIdentity {
    readonly evidence: 'resolved' | 'duplicate';
    readonly observed: RallarBlackBoxGroupAssertionValue;
}

/** The agent reported no result, or a result without the addressed value. */
export interface GroupAssertionConformanceSilentAgent extends GroupAssertionConformanceAgentIdentity {
    readonly evidence: 'missing' | 'unresolved';
}

export type GroupAssertionConformanceAgent =
    | GroupAssertionConformanceReportingAgent
    | GroupAssertionConformanceSilentAgent;

export interface GroupAssertionConformanceFailure {
    readonly ok: false;
    /** Absent when the case does not pin the failure code. */
    readonly code?: string;
    /** Absent when the case does not pin the violating agents. */
    readonly violatingAgentIds?: readonly string[];
    /** Absent when the case does not pin the missing agents. */
    readonly missingAgentIds?: readonly string[];
}

export interface GroupAssertionConformanceCase {
    readonly caseId: string;
    readonly intent: string;
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly agents: readonly GroupAssertionConformanceAgent[];
    readonly expected: Readonly<{ ok: true; }> | GroupAssertionConformanceFailure;
}

type GroupAssertionWithoutSource = RallarBlackBoxDistributedGroupAssertion extends infer Variant ?
    Variant extends RallarBlackBoxDistributedGroupAssertion ? Omit<Variant, 'source'> : never :
    never;

const CONFORMANCE_SOURCE = {
    recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
    commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
    path: 'observed'
};

function toConformanceAssertion<Assertion extends GroupAssertionWithoutSource>(
    assertion: Assertion
): Assertion & Readonly<{ source: typeof CONFORMANCE_SOURCE; }> {
    return { ...assertion, source: CONFORMANCE_SOURCE };
}

export const GROUP_ASSERTION_CONFORMANCE_CASES: readonly GroupAssertionConformanceCase[] = [
    {
        caseId: 'all-match-pass',
        intent: 'Every receiver observed exactly 100 messages.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'all-match-pass',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 100 }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 100 },
            { agentId: 'agent-b', evidence: 'resolved', observed: 100 },
            { agentId: 'agent-c', evidence: 'resolved', observed: 100 }
        ],
        expected: { ok: true }
    },
    {
        caseId: 'all-match-broken-control',
        intent: 'One receiver dropped a message, so allMatch names it.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'all-match-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 100 }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 100 },
            { agentId: 'agent-b', evidence: 'resolved', observed: 100 },
            { agentId: 'agent-c', evidence: 'resolved', observed: 99 }
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
            violatingAgentIds: ['agent-c']
        }
    },
    {
        caseId: 'none-match-pass',
        intent: 'No agent observed the leaked frame marker.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'none-match-pass',
            aggregate: 'noneMatch',
            predicate: { operator: 'contains', expected: 'leak-probe' }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: ['control-frame'] },
            { agentId: 'agent-b', evidence: 'resolved', observed: [] }
        ],
        expected: { ok: true }
    },
    {
        caseId: 'none-match-broken-control',
        intent: 'One leaked frame anywhere fails noneMatch with the offender.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'none-match-broken-control',
            aggregate: 'noneMatch',
            predicate: { operator: 'contains', expected: 'leak-probe' }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: ['control-frame'] },
            { agentId: 'agent-b', evidence: 'resolved', observed: ['control-frame', 'leak-probe'] }
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
            violatingAgentIds: ['agent-b']
        }
    },
    {
        caseId: 'count-matching-equals-pass',
        intent: 'Exactly one agent became leader.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'count-matching-equals-pass',
            aggregate: 'countMatching',
            predicate: { operator: 'equals', expected: 'leader' },
            count: { equals: 1 }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 'leader' },
            { agentId: 'agent-b', evidence: 'resolved', observed: 'follower' },
            { agentId: 'agent-c', evidence: 'resolved', observed: 'follower' }
        ],
        expected: { ok: true }
    },
    {
        caseId: 'count-matching-equals-broken-control',
        intent: 'A split brain elects two leaders and fails the exact count.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'count-matching-equals-broken-control',
            aggregate: 'countMatching',
            predicate: { operator: 'equals', expected: 'leader' },
            count: { equals: 1 }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 'leader' },
            { agentId: 'agent-b', evidence: 'resolved', observed: 'leader' },
            { agentId: 'agent-c', evidence: 'resolved', observed: 'follower' }
        ],
        expected: { ok: false, code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED' }
    },
    {
        caseId: 'count-matching-gte-pass',
        intent: 'A quorum of receivers against the frozen denominator.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'count-matching-gte-pass',
            aggregate: 'countMatching',
            predicate: { operator: 'gte', expected: 1 },
            count: { gte: 2 }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 3 },
            { agentId: 'agent-b', evidence: 'resolved', observed: 2 },
            { agentId: 'agent-c', evidence: 'resolved', observed: 0 }
        ],
        expected: { ok: true }
    },
    {
        caseId: 'count-matching-lte-broken-control',
        intent: 'More retries than the bound allows fails the run.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'count-matching-lte-broken-control',
            aggregate: 'countMatching',
            predicate: { operator: 'gte', expected: 1 },
            count: { lte: 1 }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 2 },
            { agentId: 'agent-b', evidence: 'resolved', observed: 1 },
            { agentId: 'agent-c', evidence: 'resolved', observed: 0 }
        ],
        expected: { ok: false, code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED' }
    },
    {
        caseId: 'all-equal-key-order-pass',
        intent: 'Deep equality ignores object key order across agents.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'all-equal-key-order-pass',
            aggregate: 'allEqual'
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: { revision: 7, members: ['a', 'b'] } },
            { agentId: 'agent-b', evidence: 'resolved', observed: { members: ['a', 'b'], revision: 7 } }
        ],
        expected: { ok: true }
    },
    {
        caseId: 'all-equal-broken-control',
        intent: 'A single disagreeing agent fails allEqual and is named.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'all-equal-broken-control',
            aggregate: 'allEqual'
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: { revision: 7 } },
            { agentId: 'agent-b', evidence: 'resolved', observed: { revision: 7 } },
            { agentId: 'agent-c', evidence: 'resolved', observed: { revision: 8 } }
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
            violatingAgentIds: ['agent-c']
        }
    },
    {
        caseId: 'all-equal-array-order-broken-control',
        intent: 'Array order is significant, unlike json-compare exact mode.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'all-equal-array-order-broken-control',
            aggregate: 'allEqual'
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: { members: ['a', 'b'] } },
            { agentId: 'agent-b', evidence: 'resolved', observed: { members: ['b', 'a'] } }
        ],
        expected: { ok: false, code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED' }
    },
    {
        caseId: 'all-equal-within-pass',
        intent: 'Replicated counters differ by at most one.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'all-equal-within-pass',
            aggregate: 'allEqualWithin',
            tolerance: 1
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 10 },
            { agentId: 'agent-b', evidence: 'resolved', observed: 11 }
        ],
        expected: { ok: true }
    },
    {
        caseId: 'all-equal-within-broken-control',
        intent: 'A spread beyond the tolerance names the extreme holders.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'all-equal-within-broken-control',
            aggregate: 'allEqualWithin',
            tolerance: 1
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 10 },
            { agentId: 'agent-b', evidence: 'resolved', observed: 12 },
            { agentId: 'agent-c', evidence: 'resolved', observed: 11 }
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
            violatingAgentIds: ['agent-a', 'agent-b']
        }
    },
    {
        caseId: 'missing-evidence-broken-control',
        intent: 'A frozen participant without evidence fails by default.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'missing-evidence-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'exists' }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 1 },
            { agentId: 'agent-b', evidence: 'missing' }
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING',
            missingAgentIds: ['agent-b']
        }
    },
    {
        caseId: 'duplicate-evidence-broken-control',
        intent: 'Ambiguous duplicate evidence at the address fails by default.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'duplicate-evidence-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'exists' }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 1 },
            { agentId: 'agent-b', observed: 1, evidence: 'duplicate' }
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING'
        }
    },
    {
        caseId: 'unresolved-evidence-broken-control',
        intent: 'An address that does not resolve in the evidence fails by default.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'unresolved-evidence-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'exists' }
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 1 },
            { agentId: 'agent-b', evidence: 'unresolved' }
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING'
        }
    },
    {
        caseId: 'min-participants-relaxation-pass',
        intent: 'minParticipants is the only explicit relaxation of the frozen set.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'min-participants-relaxation-pass',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 5 },
            minParticipants: 2
        }),
        agents: [
            { agentId: 'agent-a', evidence: 'resolved', observed: 5 },
            { agentId: 'agent-b', evidence: 'resolved', observed: 5 },
            { agentId: 'agent-c', evidence: 'missing' }
        ],
        expected: { ok: true }
    },
    {
        caseId: 'role-scope-pass',
        intent: 'scope.role narrows the frozen participant set to one role.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'role-scope-pass',
            aggregate: 'allMatch',
            predicate: { operator: 'equals', expected: 'delivered' },
            scope: { role: 'receiver' }
        }),
        agents: [
            { agentId: 'agent-a', role: 'sender', evidence: 'resolved', observed: 'sent' },
            { agentId: 'agent-b', role: 'receiver', evidence: 'resolved', observed: 'delivered' },
            { agentId: 'agent-c', role: 'receiver', evidence: 'resolved', observed: 'delivered' }
        ],
        expected: { ok: true }
    },
    {
        caseId: 'role-scope-no-participants-broken-control',
        intent: 'A role held by nobody in the frozen set fails closed.',
        assertion: toConformanceAssertion({
            groupAssertionId: 'role-scope-no-participants-broken-control',
            aggregate: 'allMatch',
            predicate: { operator: 'exists' },
            scope: { role: 'observer' }
        }),
        agents: [
            { agentId: 'agent-a', role: 'sender', evidence: 'resolved', observed: 1 },
            { agentId: 'agent-b', role: 'receiver', evidence: 'resolved', observed: 1 }
        ],
        expected: {
            ok: false,
            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS'
        }
    }
];

/** Every case carries agents and exactly one group assertion, so exactly one result comes back. */
export function computeGroupAssertionConformanceResult(
    conformanceCase: GroupAssertionConformanceCase
): RallarBlackBoxDistributedGroupAssertionResult {
    const results = computeDistributedGroupAssertionResults({
        manifest: toConformanceManifest(conformanceCase),
        participants: conformanceCase.agents.map((agent) => ({
            agentId: agent.agentId,
            roles: agent.role === undefined ? [] : [agent.role]
        })),
        recipeResults: conformanceCase.agents.map((agent) => ({
            recipeKey: `${agent.agentId}:${GROUP_ASSERTION_CONFORMANCE_RECIPE_ID}`,
            recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
            agentId: agent.agentId,
            state: 'passed' as const,
            ok: true
        })),
        recipeEvidence: conformanceCase.agents.flatMap(toConformanceEvidence)
    });
    assertSingleConformanceResult(results, conformanceCase.caseId);
    return results[0];
}

function toConformanceManifest(conformanceCase: GroupAssertionConformanceCase): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: `conformance-${conformanceCase.caseId}`,
        controlRunId: `conformance-${conformanceCase.caseId}`,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'conformance-room'
        },
        recipes: [{ recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID, variables: {} }],
        targetPolicy: { mode: 'all-online-group-members' },
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        startMode: 'manual',
        groupAssertions: [conformanceCase.assertion],
        metadata: {}
    };
}

function toConformanceEvidence(
    agent: GroupAssertionConformanceAgent
): readonly DistributedGroupAssertionRecipeEvidence[] {
    const results = toProbeCommandResults(agent);
    return results === undefined ? [] : [{
        agentId: agent.agentId,
        recipeId: GROUP_ASSERTION_CONFORMANCE_RECIPE_ID,
        role: agent.role,
        hasResult: true,
        resultValue: { results }
    }];
}

/** Absent when the agent reported no result at all. */
function toProbeCommandResults(agent: GroupAssertionConformanceAgent): readonly RallarBlackBoxTestResult[] | undefined {
    switch (agent.evidence) {
        case 'missing':
            return undefined;
        case 'unresolved':
            return [toProbeCommandResult({ somethingElse: true })];
        case 'duplicate':
            return [
                toProbeCommandResult({ observed: agent.observed }),
                toProbeCommandResult({ observed: agent.observed })
            ];
        case 'resolved':
            return [toProbeCommandResult({ observed: agent.observed })];
    }
}

function toProbeCommandResult(value: RallarBlackBoxTestRecord): RallarBlackBoxTestResult {
    return {
        commandId: GROUP_ASSERTION_CONFORMANCE_COMMAND_ID,
        kind: 'health',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 1_000,
        endedAtEpochMs: 1_001,
        durationMs: 1,
        value
    };
}

function assertSingleConformanceResult(
    results: readonly RallarBlackBoxDistributedGroupAssertionResult[] | undefined,
    caseId: string
): asserts results is readonly [RallarBlackBoxDistributedGroupAssertionResult] {
    if (!results || results.length !== 1) {
        throw new Error(`Conformance case ${caseId} did not evaluate.`);
    }
}
