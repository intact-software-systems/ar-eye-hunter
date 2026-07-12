import { describe, expect, it } from 'vitest';
import {
    deriveControlAgentBoardRows,
    summarizeControlAgentBoardRows,
} from '../../../apps/rallar-black-box/src/control-agent-board.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import type { DistributedRunAgentProgressRow } from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/types.ts';

const group: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'bb-group',
};

function agent(
    agentId: string,
    options: Readonly<{
        connected?: boolean;
        lastHeartbeatAtEpochMs?: number;
        groupId?: string;
        identity?: false;
        crdt?: boolean;
    }> = {},
): ControlRunSnapshot['agents'][number] {
    const identity = options.identity === false
        ? undefined
        : {
            principalId: `${agentId}-principal`,
            username: agentId,
            sessionId: `${agentId}-session`,
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            groupId: options.groupId ?? group.groupId,
            browserName: 'chromium',
            provider: 'hetzner',
            region: 'eu-north',
            capabilities: options.crdt === true
                ? {
                    crdt: {
                        supported: true,
                        transports: [
                            'local-only',
                            'ws',
                            'rtc',
                            'ws-then-rtc',
                            'rtc-with-ws-fallback',
                        ],
                    },
                }
                : undefined,
        };

    return {
        runId: 'run-1',
        agentId,
        connected: options.connected ?? true,
        lastSeenAtEpochMs: options.lastHeartbeatAtEpochMs ?? 2_000,
        lastHeartbeatAtEpochMs: options.lastHeartbeatAtEpochMs ?? 2_000,
        identity,
        connectionSequence: 1,
        reconnectCount: 2,
        receivedResultCount: 3,
        receivedEventCount: 4,
        completedCommandIds: ['done-1'],
        resumeCompletedCommandIds: [],
    };
}

function controlRun(agents: readonly ControlRunSnapshot['agents'][number][]): ControlRunSnapshot {
    return {
        runId: 'run-1',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        agents,
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function distributedRun(
    state: ControlDistributedRunSnapshot['state'],
    targetAgentIds: readonly string[],
    options: Readonly<{
        controlRunId?: string;
        distributedRunId?: string;
    }> = {},
): ControlDistributedRunSnapshot {
    const controlRunId = options.controlRunId ?? 'run-1';
    const distributedRunId = options.distributedRunId ?? `dist-${state}`;

    return {
        distributedRunId,
        controlRunId,
        state,
        createdAtEpochMs: 2_000,
        updatedAtEpochMs: 2_500,
        startedAtEpochMs: state === 'running' ? 2_100 : undefined,
        completedAtEpochMs: state === 'passed' ? 2_500 : undefined,
        targetAgentIds,
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            displayName: `Distributed ${state}`,
            group,
            recipes: [{ recipeId: 'health-only', required: true }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: targetAgentIds,
                expectedParticipantCount: targetAgentIds.length,
            },
            roleAssignments: targetAgentIds.map((agentId, index) => ({
                agentId,
                role: index === 0 ? 'sender' : 'receiver',
                required: true,
            })),
        },
        commandLinks: targetAgentIds.flatMap((agentId) => [
            {
                phase: 'stage' as const,
                agentId,
                commandId: `stage-${agentId}`,
                recipeId: 'health-only',
                role: agentId.endsWith('a') ? 'sender' : 'receiver',
                queuedAtEpochMs: 2_010,
            },
            {
                phase: 'start' as const,
                agentId,
                commandId: `start-${agentId}`,
                recipeId: 'health-only',
                role: agentId.endsWith('a') ? 'sender' : 'receiver',
                queuedAtEpochMs: 2_110,
            },
        ]),
        rollup: {
            state,
            ok: state === 'passed',
            summary: {
                participants: targetAgentIds.length,
                requiredParticipants: targetAgentIds.length,
                readyParticipants: state === 'running' || state === 'passed'
                    ? targetAgentIds.length
                    : 0,
                passedParticipants: state === 'passed' ? targetAgentIds.length : 0,
                failedParticipants: state === 'failed' ? 1 : 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: state === 'passed' ? 1 : 0,
                failedRecipes: state === 'failed' ? 1 : 0,
                blockingFailures: state === 'failed' ? 1 : 0,
            },
            failures: state === 'failed'
                ? [{
                    kind: 'recipe',
                    key: 'health-only',
                    state: 'failed',
                    required: true,
                    error: {
                        code: 'RECIPE_FAILED',
                        message: 'Recipe failed.',
                    },
                }]
                : [],
        },
    };
}

describe('control agent board derivation', () => {
    it('marks connected matching agents as targetable and summarizes them', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            group,
            nowEpochMs: 2_500,
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            agentId: 'agent-a',
            synthetic: false,
            connected: true,
            targetStatus: 'matched',
            targetable: true,
            heartbeatAgeMs: 500,
            reconnectCount: 2,
            receivedResultCount: 3,
            receivedEventCount: 4,
        });
        expect(summarizeControlAgentBoardRows(rows)).toMatchObject({
            total: 1,
            connected: 1,
            targetable: 1,
            active: 0,
        });
    });

    it('reports stale, offline, wrong-group, and missing-identity blockers', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([
                agent('agent-a', { lastHeartbeatAtEpochMs: 1_000 }),
                agent('agent-b', { connected: false }),
                agent('agent-c', { groupId: 'other-group' }),
                agent('agent-d', { identity: false }),
            ]),
            group,
            nowEpochMs: 40_000,
        });

        expect(rows.map((row) => [row.agentId, row.targetStatus, row.targetable])).toEqual([
            ['agent-a', 'stale', false],
            ['agent-b', 'offline', false],
            ['agent-c', 'different-group', false],
            ['agent-d', 'missing-identity', false],
        ]);
        expect(summarizeControlAgentBoardRows(rows)).toMatchObject({
            stale: 1,
            offline: 1,
            wrongGroup: 1,
            missingIdentity: 1,
        });
    });

    it('uses a strict 30,000ms heartbeat freshness boundary', () => {
        const fresh = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a', { lastHeartbeatAtEpochMs: 2_000 })]),
            group,
            nowEpochMs: 32_000,
        });
        const stale = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a', { lastHeartbeatAtEpochMs: 2_000 })]),
            group,
            nowEpochMs: 32_001,
        });

        expect(fresh[0]).toMatchObject({ targetStatus: 'matched', targetable: true });
        expect(stale[0]).toMatchObject({ targetStatus: 'stale', targetable: false });
    });

    it('does not invent staleness when a connected scoped agent has no timestamps', () => {
        const {
            lastHeartbeatAtEpochMs: _heartbeat,
            lastSeenAtEpochMs: _seen,
            ...withoutTimestamps
        } = agent('agent-a');
        const rows = deriveControlAgentBoardRows({
            run: controlRun([withoutTimestamps]),
            group,
            nowEpochMs: 100_000,
        });

        expect(rows[0]).toMatchObject({
            heartbeatAgeMs: undefined,
            targetStatus: 'matched',
            targetable: true,
        });
    });

    it('marks otherwise matching agents not-scoped when no group is supplied', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            nowEpochMs: 2_500,
        });

        expect(rows[0]).toMatchObject({
            targetStatus: 'not-scoped',
            targetable: false,
        });
    });

    it('requires CRDT capability when recipe command kinds need CRDT runtime', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([
                agent('agent-a'),
                agent('agent-b', { crdt: true }),
            ]),
            group,
            requiredCommandKinds: ['crdt.open'],
            nowEpochMs: 2_500,
        });

        expect(rows.map((row) => [row.agentId, row.targetStatus, row.targetable])).toEqual([
            ['agent-a', 'missing-crdt-runtime', false],
            ['agent-b', 'matched', true],
        ]);
        expect(summarizeControlAgentBoardRows(rows)).toMatchObject({
            targetable: 1,
            missingCapability: 1,
        });
    });

    it('renders exact selected-recipe CRDT transport targetability', () => {
        const wsOnly = agent('agent-a', { crdt: true });
        const run = controlRun([{
            ...wsOnly,
            identity: {
                ...wsOnly.identity!,
                capabilities: {
                    crdt: {
                        supported: true,
                        transports: ['ws'],
                    },
                },
            },
        }]);
        const recipe = (transport: 'rtc' | 'ws'): RallarBlackBoxTestRecipe => ({
            schemaVersion: 1,
            recipeId: `crdt-${transport}`,
            commands: [{
                kind: 'crdt.open',
                handle: 'document',
                name: 'document',
                transport,
            }],
        });

        const rtcRows = deriveControlAgentBoardRows({
            run,
            group,
            requiredCommandKinds: ['crdt.open'],
            requiredRecipes: [recipe('rtc')],
            nowEpochMs: 2_500,
        });
        const wsRows = deriveControlAgentBoardRows({
            run,
            group,
            requiredCommandKinds: ['crdt.open'],
            requiredRecipes: [recipe('ws')],
            nowEpochMs: 2_500,
        });

        expect(rtcRows[0]).toMatchObject({
            targetStatus: 'missing-crdt-transport',
            targetable: false,
            targetReason: 'Agent CRDT runtime does not report rtc transport support.',
        });
        expect(wsRows[0]).toMatchObject({
            targetStatus: 'matched',
            targetable: true,
        });
    });

    it('adds active distributed run participation for non-terminal runs only', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            group,
            distributedRuns: [
                distributedRun('running', ['agent-a']),
                distributedRun('passed', ['agent-a']),
            ],
            nowEpochMs: 2_500,
        });

        expect(rows[0].activeRuns.map((run) => run.distributedRunId)).toEqual([
            'dist-running',
        ]);
        expect(rows[0].activeRuns[0]).toMatchObject({
            state: 'running',
            role: 'sender',
            commandPhases: ['stage', 'start'],
            blockingFailures: 0,
        });
        expect(summarizeControlAgentBoardRows(rows).active).toBe(1);
    });

    it('uses server target-resolution roles before command links exist', () => {
        const baseRun = distributedRun('draft', ['agent-a', 'agent-b']);
        const selectedDistributedRun: ControlDistributedRunSnapshot = {
            ...baseRun,
            commandLinks: [],
            manifest: {
                ...baseRun.manifest,
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 2,
                },
                roleAssignments: undefined,
                roleAssignmentPolicy: {
                    mode: 'ordered-targets',
                    pattern: 'one-sender-many-receivers',
                    orderBy: 'agent-id',
                },
            },
            targetResolution: {
                group,
                resolvedAtEpochMs: 2_000,
                staleAfterMs: 30_000,
                targetPolicyMode: 'all-online-group-members',
                targetAgentIds: ['agent-a', 'agent-b'],
                roleAssignments: [
                    { agentId: 'agent-a', role: 'sender', required: true },
                    { agentId: 'agent-b', role: 'receiver', required: true },
                ],
                blockers: [],
                summary: {
                    agents: 2,
                    targetable: 2,
                    selected: 2,
                    expectedParticipantCount: 2,
                    missingExpectedParticipants: 0,
                    staleAgents: 0,
                    offlineAgents: 0,
                    wrongGroupAgents: 0,
                    agentsWithoutIdentity: 0,
                    roleCounts: { receiver: 1, sender: 1 },
                    regions: {},
                    providers: {},
                },
            },
        };

        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a'), agent('agent-b')]),
            group,
            selectedDistributedRun,
            nowEpochMs: 2_500,
        });

        expect(rows.map((row) => row.selectedRun?.role)).toEqual(['sender', 'receiver']);
    });

    it('includes synthetic rows for selected run targets missing from the control run', () => {
        const selectedDistributedRun = distributedRun('running', ['agent-a', 'ghost-agent']);
        const progress: DistributedRunAgentProgressRow = {
            agentId: 'ghost-agent',
            role: 'receiver',
            readiness: 'ready',
            barrier: 'missing',
            execution: 'running',
            stageCommandCount: 1,
            barrierCommandCount: 0,
            startCommandCount: 1,
            completedCommandCount: 1,
            failedCommandCount: 0,
            resultCount: 1,
            eventCount: 2,
            averageLatencyMs: 42,
            lastActivityAtEpochMs: 2_400,
        };

        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            group,
            selectedDistributedRun,
            monitorAgentProgress: [progress],
            nowEpochMs: 2_500,
        });

        expect(rows.map((row) => row.agentId)).toEqual(['agent-a', 'ghost-agent']);
        expect(rows[1]).toMatchObject({
            agentId: 'ghost-agent',
            synthetic: true,
            connected: false,
            targetStatus: 'missing-agent',
            selectedRun: {
                distributedRunId: 'dist-running',
                selected: true,
                execution: 'running',
                eventCount: 2,
            },
        });
    });

    it('ignores active distributed runs from other control runs', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            group,
            distributedRuns: [
                distributedRun('running', ['agent-a'], {
                    controlRunId: 'run-2',
                    distributedRunId: 'dist-other-run',
                }),
            ],
            nowEpochMs: 2_500,
        });

        expect(rows[0].activeRuns).toEqual([]);
        expect(summarizeControlAgentBoardRows(rows).active).toBe(0);
    });

    it('scopes rows to explicit agent ids and keeps missing selected targets', () => {
        const selectedDistributedRun = distributedRun('running', ['agent-a', 'ghost-agent']);
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a'), agent('agent-extra')]),
            group,
            selectedDistributedRun,
            agentIds: selectedDistributedRun.targetAgentIds,
            nowEpochMs: 2_500,
        });

        expect(rows.map((row) => row.agentId)).toEqual(['agent-a', 'ghost-agent']);
        expect(rows.map((row) => row.selectedRun?.distributedRunId)).toEqual([
            'dist-running',
            'dist-running',
        ]);
    });
});
