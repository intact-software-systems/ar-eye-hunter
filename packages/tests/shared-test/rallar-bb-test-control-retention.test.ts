import { describe, expect, it, vi } from 'vitest';
import {
    CONTROL_RETENTION_PLAN_LIMITS,
    ControlRetentionPlanLimitError,
    planControlRunRetention,
    type ControlRetentionPlanInput,
    type ControlRetentionRunSafety,
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlFleetRunReport } from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';

describe('rallar-bb-test control retention planning', () => {
    it.each([undefined, 0, -1])(
        'disables retention for maxRuns=%s without reading time, network, or mutating input',
        (maxRuns) => {
            const input = freezeDeep(retentionInput({
                maxRuns,
                runs: [controlRun('run-a', 10), controlRun('run-b', 20)],
                runSafety: [runSafety('run-a'), runSafety('run-b')],
            }));
            const before = JSON.stringify(input);
            const now = vi.spyOn(Date, 'now').mockImplementation(() => {
                throw new Error('retention planning must not read time');
            });
            const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
                throw new Error('retention planning must not use the network');
            });

            try {
                const plan = planControlRunRetention(input);

                expect(plan.deletedRunIds).toEqual([]);
                expect(plan.candidates).toEqual([]);
                expect(plan.currentRuns).toBe(2);
                expect(plan.projectedRetainedRuns).toBe(2);
                expect(JSON.stringify(input)).toBe(before);
                expect(now).not.toHaveBeenCalled();
                expect(fetch).not.toHaveBeenCalled();
            } finally {
                now.mockRestore();
                fetch.mockRestore();
            }
        },
    );

    it('keeps the exact cap by updated time and resolves ties with control-map insertion order', () => {
        const plan = planControlRunRetention(retentionInput({
            maxRuns: 2,
            runs: [
                controlRun('tied-first', 20),
                controlRun('oldest', 10),
                controlRun('tied-second', 20),
                controlRun('tied-third', 20),
            ],
            runSafety: [
                runSafety('tied-first'),
                runSafety('oldest'),
                runSafety('tied-second'),
                runSafety('tied-third'),
            ],
        }));

        expect(plan.deletedRunIds).toEqual(['oldest', 'tied-third']);
        expect(plan.candidates.map((candidate) => candidate.runId)).toEqual([
            'oldest',
            'tied-third',
        ]);
        expect(plan.currentRuns).toBe(4);
        expect(plan.projectedRetainedRuns).toBe(2);
    });

    it('returns linked deletion consequences in the order the current maps prune them', () => {
        const deleted = controlRun('delete-me', 1, [
            controlAgent('delete-me', 'agent-b', true),
            controlAgent('delete-me', 'agent-a', false),
        ]);
        const kept = controlRun('keep-me', 2);
        const linkedB = distributedRun('dist-b', 'delete-me', 'running');
        const linkedA = distributedRun('dist-a', 'delete-me', 'passed');
        const keptDistributed = distributedRun('dist-kept', 'keep-me', 'passed');
        const orphanReport = fleetReport('dist-orphan', 'delete-me', false);
        const plan = planControlRunRetention(retentionInput({
            maxRuns: 1,
            runs: [deleted, kept],
            distributedRuns: [linkedB, keptDistributed, linkedA],
            fleetReports: [
                fleetReport('dist-a', 'delete-me', true),
                fleetReport('dist-kept', 'keep-me', true),
                orphanReport,
                fleetReport('dist-b', 'delete-me', false),
            ],
            runSafety: [
                runSafety('delete-me', {
                    connectedAgentIds: ['agent-b'],
                    issuedRunTokens: [
                        { agentId: 'agent-b', issuedAtEpochMs: 5, expiresAtEpochMs: 50 },
                        { agentId: 'agent-a', issuedAtEpochMs: 6, expiresAtEpochMs: 60 },
                    ],
                }),
                runSafety('keep-me'),
            ],
        }));

        expect(plan.deletedRunIds).toEqual(['delete-me']);
        expect(plan.distributedRunIds).toEqual(['dist-b', 'dist-a']);
        expect(plan.fleetReportIds).toEqual(['dist-b', 'dist-a']);
        expect(plan.candidates).toEqual([
            {
                runId: 'delete-me',
                createdAtEpochMs: 0,
                updatedAtEpochMs: 1,
                connectedAgentCount: 1,
                issuedRunTokenCount: 2,
                distributedRuns: [
                    { distributedRunId: 'dist-b', state: 'running' },
                    { distributedRunId: 'dist-a', state: 'passed' },
                ],
                fleetReportIds: ['dist-b', 'dist-a'],
            },
        ]);
        expect(plan.canonicalConsequence).not.toContain('dist-orphan');
        expect(plan.canonicalConsequence).not.toContain('dist-kept');
    });

    it('canonicalizes property and non-semantic safety ordering', () => {
        const base = retentionInput({
            maxRuns: 1,
            runs: [
                controlRun('delete-me', 1, [controlAgent('delete-me', 'agent-a', true)]),
                controlRun('keep-me', 2),
            ],
            distributedRuns: [distributedRun('dist-1', 'delete-me', 'passed')],
            fleetReports: [fleetReport('dist-1', 'delete-me', true)],
            runSafety: [
                runSafety('delete-me', {
                    connectedAgentIds: ['agent-b', 'agent-a'],
                    issuedRunTokens: [
                        tokenMetadata('agent-b', 2, 20),
                        tokenMetadata('agent-a', 1, 10),
                    ],
                }),
                runSafety('keep-me'),
            ],
        });
        const cloned = reorderRecordProperties(structuredClone(base)) as ControlRetentionPlanInput;
        const [reversedSafety, ...remainingSafety] = cloned.runSafety;
        const reordered: ControlRetentionPlanInput = {
            ...cloned,
            runSafety: [
                {
                    ...reversedSafety,
                    connectedAgentIds: reversedSafety.connectedAgentIds.toReversed(),
                    issuedRunTokens: reversedSafety.issuedRunTokens.toReversed(),
                },
                ...remainingSafety,
            ],
        };

        const left = planControlRunRetention(base);
        const right = planControlRunRetention(reordered);

        expect(right.canonicalConsequence).toBe(left.canonicalConsequence);
    });

    it.each([
        {
            label: 'control content',
            mutate: (input: MutableRetentionInput) => {
                input.runs[0]!.agents[0]!.status = 'drifted-at-the-same-time';
            },
        },
        {
            label: 'distributed content',
            mutate: (input: MutableRetentionInput) => {
                input.distributedRuns[0]!.manifest.group.groupId = 'drifted-at-the-same-time';
            },
        },
        {
            label: 'fleet content',
            mutate: (input: MutableRetentionInput) => {
                input.fleetReports[0]!.summary.failed = 99;
            },
        },
        {
            label: 'connected agent identity',
            mutate: (input: MutableRetentionInput) => {
                input.runSafety[0]!.connectedAgentIds[0] = 'agent-drifted';
            },
        },
        {
            label: 'secret-free issued token state',
            mutate: (input: MutableRetentionInput) => {
                input.runSafety[0]!.issuedRunTokens[0]!.expiresAtEpochMs += 1;
            },
        },
        {
            label: 'same-visible-snapshot hidden run state',
            mutate: (input: MutableRetentionInput) => {
                input.runSafety[0]!.runStateFingerprint = 'revision:2';
            },
        },
        {
            label: 'same-count issued token replacement',
            mutate: (input: MutableRetentionInput) => {
                input.runSafety[0]!.issuedRunTokenStateFingerprint = 'revision:2';
            },
        },
    ])('changes the canonical consequence for same-timestamp $label drift', ({ mutate }) => {
        const original = mutableRetentionInput();
        const changed = structuredClone(original);
        mutate(changed);

        expect(planControlRunRetention(changed).canonicalConsequence).not.toBe(
            planControlRunRetention(original).canonicalConsequence,
        );
    });

    it('includes issued-token multiplicity even when secret-free metadata is identical', () => {
        const original = mutableRetentionInput();
        const changed = structuredClone(original);
        changed.runSafety[0]!.issuedRunTokens.push({
            ...changed.runSafety[0]!.issuedRunTokens[0]!,
        });

        const before = planControlRunRetention(original);
        const after = planControlRunRetention(changed);

        expect(before.candidates[0]?.issuedRunTokenCount).toBe(1);
        expect(after.candidates[0]?.issuedRunTokenCount).toBe(2);
        expect(after.canonicalConsequence).not.toBe(before.canonicalConsequence);
    });

    it.each([
        ['delete\0line\n|tail', 'delete|\0line\ntail'],
        ['__proto__', '__proto__\0'],
        ['caf\u00e9', 'cafe\u0301'],
        ['<script data-id="a&b">', '&lt;script data-id=a&amp;b&gt;'],
    ])('encodes unsafe identity %j distinctly from %j', (leftId, rightId) => {
        const nulIdentity = retentionInput({
            maxRuns: 1,
            runs: [controlRun('keep', 2), controlRun(leftId, 1)],
            runSafety: [runSafety('keep'), runSafety(leftId)],
        });
        const splitIdentity = retentionInput({
            maxRuns: 1,
            runs: [controlRun('keep', 2), controlRun(rightId, 1)],
            runSafety: [runSafety('keep'), runSafety(rightId)],
        });

        const nulPlan = planControlRunRetention(nulIdentity);
        const splitPlan = planControlRunRetention(splitIdentity);

        expect(nulPlan.canonicalConsequence).not.toBe(splitPlan.canonicalConsequence);
        expect(JSON.parse(nulPlan.canonicalConsequence).candidates[0].run.runId)
            .toBe(leftId);
    });

    it.each([
        ['non-finite cap', () => retentionInput({ maxRuns: Number.NaN })],
        ['fractional cap', () => retentionInput({ maxRuns: 1.5 })],
        ['unsafe cap', () => retentionInput({ maxRuns: Number.MAX_SAFE_INTEGER + 1 })],
        [
            'duplicate control identity',
            () => retentionInput({
                runs: [controlRun('duplicate', 1), controlRun('duplicate', 2)],
                runSafety: [runSafety('duplicate')],
            }),
        ],
        [
            'missing run safety',
            () => retentionInput({
                runs: [controlRun('run-a', 1)],
                runSafety: [],
            }),
        ],
        [
            'duplicate run safety',
            () => retentionInput({
                runs: [controlRun('run-a', 1)],
                runSafety: [runSafety('run-a'), runSafety('run-a')],
            }),
        ],
        [
            'duplicate connected agent identity',
            () => retentionInput({
                runs: [controlRun('run-a', 1)],
                runSafety: [runSafety('run-a', { connectedAgentIds: ['agent-a', 'agent-a'] })],
            }),
        ],
        [
            'malformed token time',
            () => retentionInput({
                runs: [controlRun('run-a', 1)],
                runSafety: [runSafety('run-a', {
                    issuedRunTokens: [
                        { agentId: 'agent-a', issuedAtEpochMs: Number.NaN, expiresAtEpochMs: 2 },
                    ],
                })],
            }),
        ],
        [
            'raw token metadata',
            () => retentionInput({
                runs: [controlRun('run-a', 1)],
                runSafety: [runSafety('run-a', {
                    issuedRunTokens: [
                        unsafeTokenMetadata('must-never-enter-shared-input'),
                    ],
                })],
            }),
        ],
        [
            'duplicate distributed identity',
            () => retentionInput({
                distributedRuns: [
                    distributedRun('dist-a', 'run-delete', 'passed'),
                    distributedRun('dist-a', 'run-delete', 'passed'),
                ],
            }),
        ],
        [
            'duplicate fleet identity',
            () => retentionInput({
                fleetReports: [
                    fleetReport('dist-a', 'run-delete', true),
                    fleetReport('dist-a', 'run-delete', false),
                ],
            }),
        ],
    ])('fails closed for %s', (_label, createInput) => {
        expect(() => planControlRunRetention(createInput())).toThrow(TypeError);
    });

    it('accepts the largest safe cap and returns typed limit failures for pathological inputs', () => {
        expect(planControlRunRetention(retentionInput({
            maxRuns: Number.MAX_SAFE_INTEGER,
        })).deletedRunIds).toEqual([]);

        const oversized = new Array(CONTROL_RETENTION_PLAN_LIMITS.collectionItems + 1)
            .fill(controlRun('same-object', 1));
        expectLimit(() => planControlRunRetention({
            maxRuns: 1,
            runs: oversized,
            runSafety: [],
        }), 'collectionItems');

        const tooManyCandidates = Array.from(
            { length: CONTROL_RETENTION_PLAN_LIMITS.candidates + 2 },
            (_, index) => controlRun(`run-${index}`, index),
        );
        expectLimit(() => planControlRunRetention(retentionInput({
            maxRuns: 1,
            runs: tooManyCandidates,
            runSafety: tooManyCandidates.map((run) => runSafety(run.runId)),
        })), 'candidates');

        const deep = mutableRetentionInput();
        let cursor: Record<string, unknown> = deep.runs[0] as unknown as Record<string, unknown>;
        for (let depth = 0; depth < CONTROL_RETENTION_PLAN_LIMITS.canonicalDepth + 2; depth += 1) {
            cursor.nested = {};
            cursor = cursor.nested as Record<string, unknown>;
        }
        expectLimit(() => planControlRunRetention(deep), 'canonicalDepth');

        const giantString = mutableRetentionInput();
        (giantString.runs[0] as unknown as Record<string, unknown>).giant =
            'x'.repeat(CONTROL_RETENTION_PLAN_LIMITS.stringCharacters + 1);
        expectLimit(() => planControlRunRetention(giantString), 'stringCharacters');

        const wide = mutableRetentionInput();
        (wide.runs[0] as unknown as Record<string, unknown>).wide = Object.fromEntries(
            Array.from(
                { length: CONTROL_RETENTION_PLAN_LIMITS.canonicalNodes + 1 },
                (_, index) => [`property-${index}`, undefined],
            ),
        );
        expectLimit(() => planControlRunRetention(wide), 'canonicalNodes');

        const tooManyBytes = mutableRetentionInput();
        let readPastByteLimit = false;
        const boundedStrings = new Array(6).fill(
            '\u00e9'.repeat(CONTROL_RETENTION_PLAN_LIMITS.stringCharacters),
            0,
            5,
        );
        Object.defineProperty(boundedStrings, 5, {
            enumerable: true,
            get() {
                readPastByteLimit = true;
                throw new Error('Serializer read past its canonical byte budget.');
            },
        });
        (tooManyBytes.runs[0] as unknown as Record<string, unknown>).multiByte = boundedStrings;
        expectLimit(() => planControlRunRetention(tooManyBytes), 'canonicalUtf8Bytes');
        expect(readPastByteLimit).toBe(false);
    });
});

function expectLimit(
    action: () => unknown,
    limit: keyof typeof CONTROL_RETENTION_PLAN_LIMITS,
): void {
    try {
        action();
        throw new Error('Expected retention planning to reject a bounded input.');
    } catch (error) {
        expect(error).toBeInstanceOf(ControlRetentionPlanLimitError);
        expect((error as ControlRetentionPlanLimitError).limit).toBe(limit);
    }
}

function retentionInput(
    overrides: Partial<ControlRetentionPlanInput> = {},
): ControlRetentionPlanInput {
    return {
        maxRuns: 1,
        runs: [controlRun('run-delete', 1), controlRun('run-keep', 2)],
        distributedRuns: [],
        fleetReports: [],
        runSafety: [runSafety('run-delete'), runSafety('run-keep')],
        ...overrides,
    };
}

type MutableRetentionInput = {
    maxRuns: number;
    runs: Mutable<ControlRunSnapshot>[];
    distributedRuns: Mutable<ControlDistributedRunSnapshot>[];
    fleetReports: Mutable<ControlFleetRunReport>[];
    runSafety: Mutable<ControlRetentionRunSafety>[];
};

type Mutable<T> = T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

function mutableRetentionInput(): MutableRetentionInput {
    return structuredClone(retentionInput({
        maxRuns: 1,
        runs: [
            controlRun('run-delete', 1, [
                controlAgent('run-delete', 'agent-a', true, 'unchanged'),
            ]),
            controlRun('run-keep', 2),
        ],
        distributedRuns: [distributedRun('dist-a', 'run-delete', 'passed')],
        fleetReports: [fleetReport('dist-a', 'run-delete', true)],
        runSafety: [
            runSafety('run-delete', {
                connectedAgentIds: ['agent-a'],
                issuedRunTokens: [
                    { agentId: 'agent-a', issuedAtEpochMs: 7, expiresAtEpochMs: 70 },
                ],
            }),
            runSafety('run-keep'),
        ],
    })) as MutableRetentionInput;
}

function runSafety(
    runId: string,
    overrides: Partial<ControlRetentionRunSafety> = {},
): ControlRetentionRunSafety {
    return {
        runId,
        connectedAgentIds: [],
        issuedRunTokens: [],
        runStateFingerprint: 'revision:0',
        issuedRunTokenStateFingerprint: 'revision:0',
        ...overrides,
    };
}

function tokenMetadata(
    agentId: string,
    issuedAtEpochMs: number,
    expiresAtEpochMs: number,
) {
    return { agentId, issuedAtEpochMs, expiresAtEpochMs };
}

function unsafeTokenMetadata(token: string) {
    return {
        agentId: 'agent-a',
        issuedAtEpochMs: 1,
        expiresAtEpochMs: 2,
        token,
    };
}

function controlRun(
    runId: string,
    updatedAtEpochMs: number,
    agents: readonly ControlAgentSnapshot[] = [],
): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 0,
        updatedAtEpochMs,
        agents,
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function controlAgent(
    runId: string,
    agentId: string,
    connected: boolean,
    status = 'ready',
): ControlAgentSnapshot {
    return {
        runId,
        agentId,
        connected,
        status,
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: [],
    };
}

function distributedRun(
    distributedRunId: string,
    controlRunId: string,
    state: ControlDistributedRunSnapshot['state'],
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        manifest: {
            distributedRunId,
            controlRunId,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'group-a',
            },
            recipes: [],
            targetPolicy: { mode: 'selected-agents', agentIds: [] },
        },
        state,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 10,
        targetAgentIds: [],
        commandLinks: [],
        rollup: {
            state,
            ok: state === 'passed',
            summary: {
                participants: 0,
                requiredParticipants: 0,
                readyParticipants: 0,
                passedParticipants: 0,
                failedParticipants: 0,
                recipes: 0,
                requiredRecipes: 0,
                passedRecipes: 0,
                failedRecipes: 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 0,
            },
            failures: [],
        },
    };
}

function fleetReport(
    distributedRunId: string,
    controlRunId: string,
    ok: boolean,
): ControlFleetRunReport {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        controlRunId,
        generatedAtEpochMs: 10,
        state: ok ? 'passed' : 'failed',
        ok,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'group-a',
        },
        recipeIds: [],
        summary: {
            agents: 0,
            regions: 0,
            passed: ok ? 1 : 0,
            failed: ok ? 0 : 1,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: ok ? 1 : 0,
            failureGroups: ok ? 0 : 1,
        },
        timing: {
            run: { count: 0 },
            commands: { count: 0 },
        },
        agents: [],
        regions: [],
        failureSignatures: [],
        artifactRefs: {
            distributedRun: `/distributed-runs/${distributedRunId}`,
            controlRun: `/runs/${controlRunId}`,
            fleetReport: `/fleet/reports/${distributedRunId}`,
        },
    };
}

function reorderRecordProperties(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(reorderRecordProperties);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, entry]) => [key, reorderRecordProperties(entry)]),
    );
}

function freezeDeep<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const entry of Object.values(value as Record<string, unknown>)) {
            freezeDeep(entry);
        }
    }
    return value;
}
