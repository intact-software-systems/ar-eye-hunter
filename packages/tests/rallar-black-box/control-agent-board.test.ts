import { describe, expect, it } from 'vitest';
import {
    controlAgentBoardWorkForTest,
    deriveControlAgentBoardRows,
    summarizeControlAgentBoardRows
} from '../../../apps/rallar-black-box/src/control-agent-board.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import { bindControlSelectionIndexToSnapshot } from '../../../apps/rallar-black-box/src/control-selection-index-binding.ts';
import type { DistributedRunAgentProgressRow } from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import { createControlSelectionIndexCache } from '../../../apps/rallar-black-box/src/recipe-console/control/control-selection-index-cache.ts';
import { createControlSnapshotSelectionIndex } from '../../../packages/shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/types.ts';

const group: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'bb-group'
};

function agent(
    agentId: string,
    options: Readonly<{
        connected?: boolean;
        lastHeartbeatAtEpochMs?: number;
        groupId?: string;
        identity?: false;
        crdt?: boolean;
    }> = {}
): ControlRunSnapshot['agents'][number] {
    const identity: ControlRunSnapshot['agents'][number]['identity'] = options.identity === false
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
                            'rtc-with-ws-fallback'
                        ]
                    }
                }
                : undefined
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
        resumeCompletedCommandIds: []
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
        heartbeats: []
    };
}

function distributedRun(
    state: ControlDistributedRunSnapshot['state'],
    targetAgentIds: readonly string[],
    options: Readonly<{
        controlRunId?: string;
        distributedRunId?: string;
    }> = {}
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
                expectedParticipantCount: targetAgentIds.length
            },
            roleAssignments: targetAgentIds.map((agentId, index) => ({
                agentId,
                role: index === 0 ? 'sender' : 'receiver',
                required: true
            }))
        },
        commandLinks: targetAgentIds.flatMap((agentId) => [
            {
                phase: 'stage' as const,
                agentId,
                commandId: `stage-${agentId}`,
                recipeId: 'health-only',
                role: agentId.endsWith('a') ? 'sender' : 'receiver',
                queuedAtEpochMs: 2_010
            },
            {
                phase: 'start' as const,
                agentId,
                commandId: `start-${agentId}`,
                recipeId: 'health-only',
                role: agentId.endsWith('a') ? 'sender' : 'receiver',
                queuedAtEpochMs: 2_110
            }
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
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: state === 'failed' ? 1 : 0
            },
            failures: state === 'failed'
                ? [{
                    kind: 'recipe',
                    key: 'health-only',
                    state: 'failed',
                    required: true,
                    error: {
                        code: 'RECIPE_FAILED',
                        message: 'Recipe failed.'
                    }
                }]
                : []
        }
    };
}

describe('control agent board derivation', () => {
    it('returns indexed empty truth without traversing 5,000 runs when nothing is selected', () => {
        const distributedRuns = Array.from({ length: 5_000 }, (_, ordinal) =>
            distributedRun('running', [`agent-${ordinal}`], {
                controlRunId: `run-${ordinal}`,
                distributedRunId: `distributed-${ordinal}`
            }));
        const first = { runs: [], distributedRuns };
        const currentRuns = new Proxy(structuredClone(distributedRuns), {
            get(target, property, receiver) {
                if (
                    property === Symbol.iterator || property === 'forEach' ||
                    property === 'filter' || property === 'map'
                ) {
                    throw new Error('global distributed traversal is forbidden');
                }
                return Reflect.get(target, property, receiver);
            }
        });
        const current = { runs: [], distributedRuns: currentRuns };

        const rows = deriveControlAgentBoardRows({
            run: undefined,
            snapshot: current,
            selectionIndex: bindControlSelectionIndexToSnapshot(
                current,
                createControlSnapshotSelectionIndex(first)
            ),
            distributedRuns: currentRuns,
            nowEpochMs: 2_500
        });

        expect(rows).toEqual([]);
        expect(controlAgentBoardWorkForTest(rows)).toEqual({
            indexed: true,
            fallback: false,
            agentProjectionCount: 0,
            queuedCommandLookupCount: 0,
            targetMembershipLookupCount: 0,
            distributedRunProjectionCount: 0,
            commandLinkProjectionCount: 0,
            roleLookupCount: 0
        });
    });

    it('uses indexed ordinals while preserving selected duplicate override and current objects', () => {
        const firstSelected = distributedRun('running', ['agent-first'], {
            distributedRunId: 'duplicate\0\u202e'
        });
        const lastDuplicate = distributedRun('running', ['agent-last'], {
            distributedRunId: 'duplicate\0\u202e'
        });
        const first = {
            runs: [controlRun([
                agent('agent-first'),
                agent('agent-last')
            ])],
            distributedRuns: [firstSelected, lastDuplicate]
        };
        const current = structuredClone(first);
        const selectionIndex = bindControlSelectionIndexToSnapshot(
            current,
            createControlSnapshotSelectionIndex(first)
        );
        const legacy = deriveControlAgentBoardRows({
            run: current.runs[0],
            group,
            distributedRuns: current.distributedRuns,
            selectedDistributedRun: current.distributedRuns[0],
            nowEpochMs: 2_500
        });

        const indexed = deriveControlAgentBoardRows({
            run: current.runs[0],
            group,
            snapshot: current,
            selectionIndex,
            distributedRuns: current.distributedRuns,
            selectedDistributedRun: current.distributedRuns[0],
            nowEpochMs: 2_500
        });

        expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
        expect(indexed[0]!.selectedRun?.distributedRunId).toBe('duplicate\0\u202e');
        expect(indexed[1]!.selectedRun).toBeUndefined();
        expect(indexed[0]!.identity).toBe(current.runs[0]!.agents[0]!.identity);
        expect(controlAgentBoardWorkForTest(indexed)).toEqual({
            indexed: true,
            fallback: false,
            agentProjectionCount: 2,
            queuedCommandLookupCount: 2,
            targetMembershipLookupCount: 2,
            distributedRunProjectionCount: 1,
            commandLinkProjectionCount: 2,
            roleLookupCount: 1
        });
    });

    it('projects only active winners in first-insertion order and preserves cross-control selected suppression', () => {
        const run = controlRun([agent('agent-a')]);
        const distributedRuns = [
            distributedRun('running', ['agent-a'], {
                distributedRunId: 'terminal-winner'
            }),
            distributedRun('passed', ['agent-a'], {
                distributedRunId: 'active-winner'
            }),
            distributedRun('running', ['agent-a'], {
                distributedRunId: 'cross-control-selected'
            }),
            distributedRun('running', ['agent-a'], {
                distributedRunId: 'later-first-insertion'
            }),
            distributedRun('passed', ['agent-a'], {
                distributedRunId: 'terminal-winner'
            }),
            distributedRun('running', ['agent-a'], {
                distributedRunId: 'active-winner'
            }),
            distributedRun('running', ['ghost', 'ghost'], {
                controlRunId: 'run-2',
                distributedRunId: 'cross-control-selected'
            })
        ];
        const snapshot = { runs: [run], distributedRuns };
        const selectionIndex = createControlSelectionIndexCache().get(snapshot);
        const selected = distributedRuns[6]!;
        const legacy = deriveControlAgentBoardRows({
            run,
            group,
            distributedRuns,
            selectedDistributedRun: selected,
            nowEpochMs: 2_500
        });

        const indexed = deriveControlAgentBoardRows({
            run,
            group,
            snapshot,
            selectionIndex,
            distributedRuns,
            selectedDistributedRun: selected,
            nowEpochMs: 2_500
        });

        expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
        expect(indexed[0]!.activeRuns.map((item) => item.distributedRunId)).toEqual([
            'active-winner',
            'later-first-insertion'
        ]);
        expect(indexed.filter((row) => row.agentId === 'ghost')).toHaveLength(2);
        expect(indexed.every((row) => row.selectedRun === undefined)).toBe(true);
        expect(controlAgentBoardWorkForTest(indexed)).toMatchObject({
            indexed: true,
            fallback: false,
            distributedRunProjectionCount: 2
        });
    });

    it('matches legacy board truth for 5,000 deterministic randomized duplicate runs', () => {
        const agents = Array.from({ length: 8 }, (_, ordinal) => agent(`agent-${ordinal}`));
        const run = controlRun(agents);
        let seed = 0x6d2b79f5;
        const next = () => {
            seed = Math.imul(seed ^ seed >>> 15, seed | 1);
            seed ^= seed + Math.imul(seed ^ seed >>> 7, seed | 61);
            return (seed ^ seed >>> 14) >>> 0;
        };
        const states = ['running', 'ready', 'passed', 'failed'] as const;
        const distributedRuns = Array.from({ length: 5_000 }, () => {
            const value = next();
            const firstAgentId = `agent-${value % agents.length}`;
            const secondAgentId = `agent-${(value >>> 5) % agents.length}`;
            return distributedRun(
                states[(value >>> 9) % states.length]!,
                value % 13 === 0
                    ? [firstAgentId, secondAgentId, secondAgentId]
                    : [firstAgentId],
                {
                    controlRunId: value % 11 === 0 ? 'run-2' : 'run-1',
                    distributedRunId: `distributed-${value % 700}`
                }
            );
        });
        const selected = distributedRun('running', ['ghost', 'ghost'], {
            distributedRunId: 'distributed-17'
        });
        distributedRuns.push(selected);
        const snapshot = { runs: [run], distributedRuns };
        const selectionIndex = createControlSelectionIndexCache().get(snapshot);

        const legacy = deriveControlAgentBoardRows({
            run,
            group,
            distributedRuns,
            selectedDistributedRun: selected,
            nowEpochMs: 2_500
        });
        const indexed = deriveControlAgentBoardRows({
            run,
            group,
            snapshot,
            selectionIndex,
            distributedRuns,
            selectedDistributedRun: selected,
            nowEpochMs: 2_500
        });

        const work = controlAgentBoardWorkForTest(indexed);
        expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
        expect(work).toMatchObject({
            indexed: true,
            fallback: false
        });
        if (work?.indexed !== true) {
            throw new Error('indexed derivation reported fallback work');
        }
        expect(work.distributedRunProjectionCount)
            .toBeLessThanOrEqual(700);
    });

    it('falls back explicitly when selected run identity is external to the indexed snapshot', () => {
        const selected = distributedRun('running', ['agent-a']);
        const snapshot = {
            runs: [controlRun([agent('agent-a')])],
            distributedRuns: [selected]
        };
        const external = {
            ...structuredClone(selected),
            targetAgentIds: ['ghost']
        };

        const rows = deriveControlAgentBoardRows({
            run: snapshot.runs[0],
            group,
            snapshot,
            selectionIndex: bindControlSelectionIndexToSnapshot(
                snapshot,
                createControlSnapshotSelectionIndex(snapshot)
            ),
            distributedRuns: snapshot.distributedRuns,
            selectedDistributedRun: external,
            nowEpochMs: 2_500
        });

        expect(rows.map((row) => row.agentId)).toEqual(['agent-a', 'ghost']);
        expect(controlAgentBoardWorkForTest(rows)).toMatchObject({
            indexed: false,
            fallback: true
        });
    });

    it('marks connected matching agents as targetable and summarizes them', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            group,
            nowEpochMs: 2_500
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
            receivedEventCount: 4
        });
        expect(summarizeControlAgentBoardRows(rows)).toMatchObject({
            total: 1,
            connected: 1,
            targetable: 1,
            active: 0
        });
    });

    it('reports stale, offline, wrong-group, and missing-identity blockers', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([
                agent('agent-a', { lastHeartbeatAtEpochMs: 1_000 }),
                agent('agent-b', { connected: false }),
                agent('agent-c', { groupId: 'other-group' }),
                agent('agent-d', { identity: false })
            ]),
            group,
            nowEpochMs: 40_000
        });

        expect(rows.map((row) => [row.agentId, row.targetStatus, row.targetable])).toEqual([
            ['agent-a', 'stale', false],
            ['agent-b', 'offline', false],
            ['agent-c', 'different-group', false],
            ['agent-d', 'missing-identity', false]
        ]);
        expect(summarizeControlAgentBoardRows(rows)).toMatchObject({
            stale: 1,
            offline: 1,
            wrongGroup: 1,
            missingIdentity: 1
        });
    });

    it('uses a strict 30,000ms heartbeat freshness boundary', () => {
        const fresh = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a', { lastHeartbeatAtEpochMs: 2_000 })]),
            group,
            nowEpochMs: 32_000
        });
        const stale = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a', { lastHeartbeatAtEpochMs: 2_000 })]),
            group,
            nowEpochMs: 32_001
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
            nowEpochMs: 100_000
        });

        expect(rows[0]).toMatchObject({
            heartbeatAgeMs: undefined,
            targetStatus: 'matched',
            targetable: true
        });
    });

    it('marks otherwise matching agents not-scoped when no group is supplied', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            nowEpochMs: 2_500
        });

        expect(rows[0]).toMatchObject({
            targetStatus: 'not-scoped',
            targetable: false
        });
    });

    it('requires CRDT capability when recipe command kinds need CRDT runtime', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([
                agent('agent-a'),
                agent('agent-b', { crdt: true })
            ]),
            group,
            requiredCommandKinds: ['crdt.open'],
            nowEpochMs: 2_500
        });

        expect(rows.map((row) => [row.agentId, row.targetStatus, row.targetable])).toEqual([
            ['agent-a', 'missing-crdt-runtime', false],
            ['agent-b', 'matched', true]
        ]);
        expect(summarizeControlAgentBoardRows(rows)).toMatchObject({
            targetable: 1,
            missingCapability: 1
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
                        transports: ['ws']
                    }
                }
            }
        }]);
        const recipe = (transport: 'rtc' | 'ws'): RallarBlackBoxTestRecipe => ({
            schemaVersion: 1,
            recipeId: `crdt-${transport}`,
            commands: [{
                kind: 'crdt.open',
                handle: 'document',
                name: 'document',
                transport
            }]
        });

        const rtcRows = deriveControlAgentBoardRows({
            run,
            group,
            requiredCommandKinds: ['crdt.open'],
            requiredRecipes: [recipe('rtc')],
            nowEpochMs: 2_500
        });
        const wsRows = deriveControlAgentBoardRows({
            run,
            group,
            requiredCommandKinds: ['crdt.open'],
            requiredRecipes: [recipe('ws')],
            nowEpochMs: 2_500
        });

        expect(rtcRows[0]).toMatchObject({
            targetStatus: 'missing-crdt-transport',
            targetable: false,
            targetReason: 'Agent CRDT runtime does not report rtc transport support.'
        });
        expect(wsRows[0]).toMatchObject({
            targetStatus: 'matched',
            targetable: true
        });
    });

    it('adds active distributed run participation for non-terminal runs only', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            group,
            distributedRuns: [
                distributedRun('running', ['agent-a']),
                distributedRun('passed', ['agent-a'])
            ],
            nowEpochMs: 2_500
        });

        expect(rows[0].activeRuns.map((run) => run.distributedRunId)).toEqual([
            'dist-running'
        ]);
        expect(rows[0].activeRuns[0]).toMatchObject({
            state: 'running',
            role: 'sender',
            commandPhases: ['stage', 'start'],
            blockingFailures: 0
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
                    expectedParticipantCount: 2
                },
                roleAssignments: undefined,
                roleAssignmentPolicy: {
                    mode: 'ordered-targets',
                    pattern: 'one-sender-many-receivers',
                    orderBy: 'agent-id'
                }
            },
            targetResolution: {
                group,
                resolvedAtEpochMs: 2_000,
                staleAfterMs: 30_000,
                targetPolicyMode: 'all-online-group-members',
                targetAgentIds: ['agent-a', 'agent-b'],
                roleAssignments: [
                    { agentId: 'agent-a', role: 'sender', required: true },
                    { agentId: 'agent-b', role: 'receiver', required: true }
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
                    providers: {}
                }
            }
        };

        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a'), agent('agent-b')]),
            group,
            selectedDistributedRun,
            nowEpochMs: 2_500
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
            lastActivityAtEpochMs: 2_400
        };

        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            group,
            selectedDistributedRun,
            monitorAgentProgress: [progress],
            nowEpochMs: 2_500
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
                eventCount: 2
            }
        });
    });

    it('ignores active distributed runs from other control runs', () => {
        const rows = deriveControlAgentBoardRows({
            run: controlRun([agent('agent-a')]),
            group,
            distributedRuns: [
                distributedRun('running', ['agent-a'], {
                    controlRunId: 'run-2',
                    distributedRunId: 'dist-other-run'
                })
            ],
            nowEpochMs: 2_500
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
            nowEpochMs: 2_500
        });

        expect(rows.map((row) => row.agentId)).toEqual(['agent-a', 'ghost-agent']);
        expect(rows.map((row) => row.selectedRun?.distributedRunId)).toEqual([
            'dist-running',
            'dist-running'
        ]);
    });
});
