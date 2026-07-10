import { describe, expect, it } from 'vitest';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../shared-test/rallar-bb-test/control-snapshots.ts';
import {
    controlSnapshotSelectionIndexWorkForTest,
    createControlSnapshotBoardRunOverlayPlan,
    createControlSnapshotSelectionIndex,
    rebindCommandLinksFromSelectionIndex,
    rebindControlAgentFromSelectionIndex,
    rebindControlAgentsFromSelectionIndex,
    rebindControlCommandFromSelectionIndex,
    rebindControlCommandsFromSelectionIndex,
    rebindControlRunFromSelectionIndex,
    rebindControlRunsFromSelectionIndex,
    rebindDistributedRunFromSelectionIndex,
    rebindDistributedRunPairFromSelectionIndex,
    rebindDistributedRunsFromSelectionIndex,
} from '../../shared-test/rallar-bb-test/control-snapshot-selection-index.ts';

const SCALE = 5_000;

describe('control snapshot selection index', () => {
    it('preserves first-match, source, updated, active, target, link, and board order', () => {
        const hostileRunId = 'control\0|\u202e\ud800';
        const hostileDistributedId = 'distributed\0|\u202e\udfff';
        const hostileAgentId = 'agent\0|\u202e\ud800';
        const hostileCommandId = 'command\0|\u202e\udfff';
        const snapshot = freezeDeep<ControlServerSnapshot>({
            runs: [
                controlRun(hostileRunId, 10, {
                    agents: [
                        controlAgent(hostileRunId, hostileAgentId),
                        controlAgent(hostileRunId, hostileAgentId),
                        controlAgent(hostileRunId, '000-agent'),
                    ],
                    commands: [
                        controlCommand(hostileRunId, hostileAgentId, hostileCommandId),
                        controlCommand(hostileRunId, hostileAgentId, hostileCommandId),
                        controlCommand(
                            hostileRunId,
                            hostileAgentId,
                            'completed-command',
                            2,
                        ),
                        controlCommand(hostileRunId, '000-agent', 'other-command'),
                    ],
                }),
                controlRun('control-b', 30),
                controlRun(hostileRunId, 50, {
                    agents: [controlAgent(hostileRunId, 'shadow-agent')],
                    commands: [controlCommand(hostileRunId, 'shadow-agent', 'shadow-command')],
                }),
            ],
            distributedRuns: [
                distributedRun(hostileDistributedId, hostileRunId, 10, 'running', {
                    targetAgentIds: [hostileAgentId, hostileAgentId],
                    commandLinks: [
                        commandLink(hostileAgentId, hostileCommandId, 'stage'),
                        commandLink(hostileAgentId, hostileCommandId, 'barrier'),
                    ],
                }),
                distributedRun('distributed-b', 'control-b', 30, 'passed', {
                    targetAgentIds: ['agent-b'],
                }),
                distributedRun(hostileDistributedId, 'control-b', 50, 'running', {
                    targetAgentIds: ['agent-late'],
                    commandLinks: [commandLink('agent-late', 'command-late', 'start')],
                }),
                distributedRun('distributed-a-active', hostileRunId, 40, 'ready', {
                    targetAgentIds: ['agent-a'],
                }),
                distributedRun('distributed-a-terminal', hostileRunId, 60, 'passed'),
            ],
        });
        const before = JSON.stringify(snapshot);

        const index = createControlSnapshotSelectionIndex(snapshot);

        expect(index.hasDistributedRunCollection).toBe(true);
        expect(index.firstControlRunOrdinalById.get(hostileRunId)).toBe(0);
        expect(index.firstDistributedRunOrdinalById.get(hostileDistributedId)).toBe(0);
        expect(index.controlRunOrdinalsByUpdatedDesc).toEqual([2, 1, 0]);
        expect(index.distributedRunOrdinalsByUpdatedDesc).toEqual([4, 2, 3, 1, 0]);
        expect(index.firstAgentOrdinalByControlRunId.get(hostileRunId)?.get(hostileAgentId))
            .toBe(0);
        expect(index.firstCommandOrdinalByControlRunId.get(hostileRunId)?.get(hostileCommandId))
            .toBe(0);
        expect(index.controlAgentOrdinalsByControlRunIdSorted.get(hostileRunId))
            .toEqual([2, 0, 1]);
        expect(index.controlCommandOrdinalsByControlRunAgentId
            .get(hostileRunId)?.get(hostileAgentId)).toEqual([0, 1, 2]);
        expect(index.queuedControlCommandCountByControlRunAgentId
            .get(hostileRunId)?.get(hostileAgentId)).toBe(2);
        expect(index.queuedControlCommandCountByControlRunAgentId
            .get(hostileRunId)?.get('000-agent')).toBe(1);
        expect(index.distributedRunOrdinalsByControlRunId.get(hostileRunId))
            .toEqual([0, 3, 4]);
        expect(index.distributedRunOrdinalsByControlRunIdUpdatedDesc.get(hostileRunId))
            .toEqual([4, 3, 0]);
        expect(index.distributedRunOrdinalsByControlRunIdUpdatedDesc.get('control-b'))
            .toEqual([2, 1]);
        expect(index.activeDistributedRunOrdinalsByControlRunId.get(hostileRunId))
            .toEqual([3, 0]);
        expect(index.targetDistributedRunOrdinalsByControlRunId
            .get(hostileRunId)?.get(hostileAgentId)).toEqual([0]);
        expect(index.commandLinkOrdinalsByDistributedRunOrdinal
            .get(0)?.get(hostileAgentId)).toEqual([0, 1]);

        // Map replacement keeps the first insertion position while the last
        // duplicate payload wins, matching the current board's uniqueRuns.
        expect(index.boardDistributedRunOrdinalsByControlRunId.get('control-b'))
            .toEqual([2, 1]);
        expect(index.boardDistributedRunOrdinalsByControlRunId.get(hostileRunId))
            .toEqual([3, 4]);
        expect(index.boardTargetDistributedRunOrdinalsByControlRunId
            .get('control-b')?.get('agent-late')).toEqual([2]);

        const next = structuredClone(snapshot);
        expect(rebindControlRunFromSelectionIndex(index, next, hostileRunId))
            .toBe(next.runs[0]);
        expect(rebindControlAgentFromSelectionIndex(
            index,
            next,
            hostileRunId,
            hostileAgentId,
        )).toBe(next.runs[0]!.agents[0]);
        expect(rebindControlCommandFromSelectionIndex(
            index,
            next,
            hostileRunId,
            hostileCommandId,
        )).toBe(next.runs[0]!.commands[0]);
        expect(rebindControlAgentsFromSelectionIndex(
            index,
            next,
            hostileRunId,
            index.controlAgentOrdinalsByControlRunIdSorted.get(hostileRunId)!,
        )).toEqual([
            next.runs[0]!.agents[2],
            next.runs[0]!.agents[0],
            next.runs[0]!.agents[1],
        ]);
        expect(rebindControlCommandsFromSelectionIndex(
            index,
            next,
            hostileRunId,
            index.controlCommandOrdinalsByControlRunAgentId
                .get(hostileRunId)!.get(hostileAgentId)!,
        )).toEqual([
            next.runs[0]!.commands[0],
            next.runs[0]!.commands[1],
            next.runs[0]!.commands[2],
        ]);
        expect(rebindDistributedRunFromSelectionIndex(index, next, hostileDistributedId))
            .toBe(next.distributedRuns![0]);
        expect(rebindControlRunsFromSelectionIndex(
            index,
            next,
            index.controlRunOrdinalsByUpdatedDesc,
        )).toEqual([next.runs[2], next.runs[1], next.runs[0]]);
        expect(rebindDistributedRunsFromSelectionIndex(
            index,
            next,
            index.boardDistributedRunOrdinalsByControlRunId.get('control-b')!,
        )).toEqual([next.distributedRuns![2], next.distributedRuns![1]]);
        expect(rebindCommandLinksFromSelectionIndex(
            index,
            next,
            0,
            index.commandLinkOrdinalsByDistributedRunOrdinal.get(0)!.get(hostileAgentId)!,
        )).toEqual([
            next.distributedRuns![0]!.commandLinks[0],
            next.distributedRuns![0]!.commandLinks[1],
        ]);
        expect(JSON.stringify(snapshot)).toBe(before);
    });

    it('keeps an omitted distributed-run collection distinct from an authoritative empty one', () => {
        const omitted = createControlSnapshotSelectionIndex({ runs: [] });
        const empty = createControlSnapshotSelectionIndex({ runs: [], distributedRuns: [] });

        expect(omitted.hasDistributedRunCollection).toBe(false);
        expect(empty.hasDistributedRunCollection).toBe(true);
        expect(omitted.distributedRunIdsByOrdinal).toEqual([]);
        expect(empty.distributedRunIdsByOrdinal).toEqual([]);
    });

    it('indexes empty identifiers separately and without truthiness shortcuts', () => {
        const snapshot: ControlServerSnapshot = {
            runs: [controlRun('', 1, {
                agents: [controlAgent('', '')],
                commands: [controlCommand('', '', '')],
            })],
            distributedRuns: [distributedRun('', '', 1, 'running', {
                targetAgentIds: [''],
                commandLinks: [commandLink('', '', 'stage')],
            })],
        };
        const index = createControlSnapshotSelectionIndex(snapshot);

        expect(index.firstControlRunOrdinalById.get('')).toBe(0);
        expect(index.firstDistributedRunOrdinalById.get('')).toBe(0);
        expect(index.firstAgentOrdinalByControlRunId.get('')?.get('')).toBe(0);
        expect(index.firstCommandOrdinalByControlRunId.get('')?.get('')).toBe(0);
        expect(index.targetDistributedRunOrdinalsByControlRunId.get('')?.get(''))
            .toEqual([0]);
        expect(rebindControlRunFromSelectionIndex(index, snapshot, '')).toBe(snapshot.runs[0]);
        expect(rebindDistributedRunFromSelectionIndex(index, snapshot, ''))
            .toBe(snapshot.distributedRuns![0]);
    });

    it('indexes board role precedence as resolution, manifest, then first command link', () => {
        const agent = 'role-agent\0\u202e\ud800';
        const resolution = distributedRun('resolution', 'control', 3, 'running', {
            targetAgentIds: [agent],
            commandLinks: [
                commandLink(agent, 'resolution-link-a', 'stage', 'link-first'),
                commandLink(agent, 'resolution-link-b', 'start', 'link-later'),
            ],
        });
        const manifest = distributedRun('manifest', 'control', 2, 'running', {
            targetAgentIds: [agent],
            commandLinks: [commandLink(agent, 'manifest-link', 'stage', 'link-only')],
        });
        const link = distributedRun('link', 'control', 1, 'running', {
            targetAgentIds: [agent],
            commandLinks: [
                commandLink(agent, 'link-a', 'stage', 'link-first'),
                commandLink(agent, 'link-b', 'start', 'link-later'),
            ],
        });
        const linkBlockedByFirst = distributedRun(
            'link-blocked-by-first',
            'control',
            0,
            'running',
            {
                targetAgentIds: [agent],
                commandLinks: [
                    commandLink(agent, 'link-no-role', 'stage'),
                    commandLink(agent, 'link-role-later', 'start', 'must-not-win'),
                ],
            },
        );
        const snapshot: ControlServerSnapshot = {
            runs: [controlRun('control', 1)],
            distributedRuns: [{
                ...resolution,
                manifest: {
                    ...resolution.manifest,
                    roleAssignments: [
                        { agentId: agent, role: 'manifest-first', required: true },
                        { agentId: agent, role: 'manifest-later', required: true },
                    ],
                },
                targetResolution: targetResolution(agent, [
                    { agentId: agent, role: 'resolution-first', required: true },
                    { agentId: agent, role: 'resolution-later', required: true },
                ]),
            }, {
                ...manifest,
                manifest: {
                    ...manifest.manifest,
                    roleAssignments: [
                        { agentId: agent, role: 'manifest-first', required: true },
                        { agentId: agent, role: 'manifest-later', required: true },
                    ],
                },
            }, link, linkBlockedByFirst],
        };

        const index = createControlSnapshotSelectionIndex(snapshot);

        expect(index.boardRoleByAgentIdByDistributedRunOrdinal.get(0)?.get(agent))
            .toBe('resolution-first');
        expect(index.boardRoleByAgentIdByDistributedRunOrdinal.get(1)?.get(agent))
            .toBe('manifest-first');
        expect(index.boardRoleByAgentIdByDistributedRunOrdinal.get(2)?.get(agent))
            .toBe('link-first');
        expect(index.boardRoleByAgentIdByDistributedRunOrdinal.get(3)?.has(agent))
            .toBe(false);
        expect(index.commandLinkOrdinalsByDistributedRunOrdinal.get(0)?.get(agent))
            .toEqual([0, 1]);
    });

    it('falls through nullish first assignments without allowing later duplicates to win', () => {
        const agent = 'role-nullish-agent';
        const manifestNullish = distributedRun(
            'manifest-nullish',
            'control',
            2,
            'running',
            {
                targetAgentIds: [agent],
                commandLinks: [commandLink(agent, 'link-manifest-fallback', 'stage', 'link-fallback')],
            },
        );
        const resolutionNullish = distributedRun(
            'resolution-nullish',
            'control',
            1,
            'running',
            {
                targetAgentIds: [agent],
                commandLinks: [commandLink(agent, 'link-resolution-fallback', 'stage', 'link-lower')],
            },
        );
        const snapshot: ControlServerSnapshot = {
            runs: [controlRun('control', 1)],
            distributedRuns: [{
                ...manifestNullish,
                manifest: {
                    ...manifestNullish.manifest,
                    roleAssignments: [{
                        agentId: agent,
                        role: undefined,
                        required: true,
                    }, {
                        agentId: agent,
                        role: 'manifest-later-must-not-win',
                        required: true,
                    }] as unknown as NonNullable<
                        ControlDistributedRunSnapshot['manifest']['roleAssignments']
                    >,
                },
            }, {
                ...resolutionNullish,
                manifest: {
                    ...resolutionNullish.manifest,
                    roleAssignments: [{
                        agentId: agent,
                        role: 'manifest-fallback',
                        required: true,
                    }],
                },
                targetResolution: targetResolution(agent, [{
                    agentId: agent,
                    role: null,
                    required: true,
                }, {
                    agentId: agent,
                    role: 'resolution-later-must-not-win',
                    required: true,
                }] as unknown as NonNullable<
                    ControlDistributedRunSnapshot['targetResolution']
                >['roleAssignments']),
            }],
        };

        const index = createControlSnapshotSelectionIndex(snapshot);

        expect(index.boardRoleByAgentIdByDistributedRunOrdinal.get(0)?.get(agent))
            .toBe('link-fallback');
        expect(index.boardRoleByAgentIdByDistributedRunOrdinal.get(1)?.get(agent))
            .toBe('manifest-fallback');
    });

    it('plans an exact selected board override at the first insertion position', () => {
        const firstTarget = 'first-target';
        const lastTarget = 'last-target';
        const source = [
            distributedRun('duplicate', 'control', 1, 'running', {
                targetAgentIds: [firstTarget],
            }),
            distributedRun('middle', 'control', 2, 'running'),
            distributedRun('duplicate', 'control', 3, 'running', {
                targetAgentIds: [lastTarget],
            }),
        ];
        const snapshot: ControlServerSnapshot = {
            runs: [controlRun('control', 1)],
            distributedRuns: source,
        };
        const index = createControlSnapshotSelectionIndex(snapshot);

        expect(index.boardDistributedRunIdsInFirstInsertionOrder)
            .toEqual(['duplicate', 'middle']);
        expect(index.boardSourceWinnerOrdinalByDistributedRunId.get('duplicate')).toBe(2);
        expect(index.boardSourceCountByDistributedRunId.get('duplicate')).toBe(2);
        expect(index.boardFirstInsertionOrdinalByDistributedRunId.get('duplicate')).toBe(0);

        const selected = source[0]!;
        const plan = createControlSnapshotBoardRunOverlayPlan(
            index,
            'control',
            selected,
        );
        expect(plan).toEqual([{
            kind: 'selected',
            distributedRunId: 'duplicate',
            firstInsertionOrdinal: 0,
            sourceWinnerOrdinal: 2,
            sourceCount: 2,
        }, {
            kind: 'source',
            distributedRunId: 'middle',
            firstInsertionOrdinal: 1,
            sourceWinnerOrdinal: 1,
            sourceCount: 1,
        }]);
        const rebound = plan.map(entry =>
            entry.kind === 'selected'
                ? selected
                : snapshot.distributedRuns![entry.sourceWinnerOrdinal]
        );
        expect(rebound.filter(run => run!.targetAgentIds.includes(firstTarget))
            .map(run => run!.distributedRunId)).toEqual(['duplicate']);
        expect(rebound.filter(run => run!.targetAgentIds.includes(lastTarget)))
            .toEqual([]);

        expect(createControlSnapshotBoardRunOverlayPlan(index, 'control', {
            distributedRunId: 'external',
            controlRunId: 'control',
        }).at(-1)).toEqual({
            kind: 'selected',
            distributedRunId: 'external',
            firstInsertionOrdinal: source.length,
            sourceWinnerOrdinal: undefined,
            sourceCount: 0,
        });
    });

    it('keeps global-ID, ID/control-pair, and compatible-source lookups distinct', () => {
        const distributedRunId = 'shared\0|\u202e\ud800';
        const controlA = 'control\0a|b';
        const controlB = 'control\0a';
        const snapshot: ControlServerSnapshot = {
            runs: [controlRun(controlA, 1), controlRun(controlB, 2)],
            distributedRuns: [
                distributedRun(distributedRunId, controlB, 1, 'running'),
                distributedRun(distributedRunId, controlA, 2, 'running'),
                distributedRun('b|' + distributedRunId, controlA, 3, 'running'),
            ],
        };
        const index = createControlSnapshotSelectionIndex(snapshot);

        expect(index.firstDistributedRunOrdinalById.get(distributedRunId)).toBe(0);
        expect(index.firstDistributedRunOrdinalByIdAndControlRunId
            .get(distributedRunId)?.get(controlA)).toBe(1);
        expect(index.firstDistributedRunOrdinalByIdAndControlRunId
            .get(distributedRunId)?.get(controlB)).toBe(0);
        expect(index.distributedRunOrdinalsByControlRunId.get(controlA)).toEqual([1, 2]);
        expect(rebindDistributedRunFromSelectionIndex(index, snapshot, distributedRunId))
            .toBe(snapshot.distributedRuns![0]);
        expect(rebindDistributedRunPairFromSelectionIndex(
            index,
            snapshot,
            distributedRunId,
            controlA,
        )).toBe(snapshot.distributedRuns![1]);
    });

    it('indexes 5,000 control/distributed pairs with exact linear work and reaches the tail', () => {
        const snapshot = scaleSnapshot(SCALE);

        const index = createControlSnapshotSelectionIndex(snapshot);

        expect(rebindControlRunFromSelectionIndex(index, snapshot, controlId(SCALE - 1)))
            .toBe(snapshot.runs[SCALE - 1]);
        expect(rebindControlAgentFromSelectionIndex(
            index,
            snapshot,
            controlId(SCALE - 1),
            agentId(SCALE - 1),
        )).toBe(snapshot.runs[SCALE - 1]!.agents[0]);
        expect(rebindControlCommandFromSelectionIndex(
            index,
            snapshot,
            controlId(SCALE - 1),
            commandId(SCALE - 1),
        )).toBe(snapshot.runs[SCALE - 1]!.commands[0]);
        expect(rebindDistributedRunFromSelectionIndex(
            index,
            snapshot,
            distributedId(SCALE - 1),
        )).toBe(snapshot.distributedRuns![SCALE - 1]);
        expect(index.boardTargetDistributedRunOrdinalsByControlRunId
            .get(controlId(SCALE - 1))?.get(agentId(SCALE - 1)))
            .toEqual([SCALE - 1]);
        expect(controlSnapshotSelectionIndexWorkForTest(index)).toEqual({
            controlRunVisitCount: SCALE,
            controlAgentVisitCount: SCALE,
            controlAgentSortedOrdinalProjectionVisitCount: SCALE,
            controlCommandVisitCount: SCALE,
            controlCommandAgentBucketWriteCount: SCALE,
            queuedControlCommandCountIncrementCount: SCALE,
            controlRunUpdatedOrderProjectionVisitCount: SCALE,
            distributedRunVisitCount: SCALE,
            distributedControlBucketWriteCount: SCALE,
            distributedUpdatedControlBucketWriteCount: SCALE,
            activeDistributedRunProjectionVisitCount: SCALE,
            activeDistributedControlBucketWriteCount: SCALE,
            distributedTargetAgentVisitCount: SCALE,
            targetMembershipWriteCount: SCALE,
            distributedCommandLinkVisitCount: SCALE,
            commandLinkAgentBucketWriteCount: SCALE,
            manifestRoleAssignmentVisitCount: 0,
            targetResolutionRoleAssignmentVisitCount: 0,
            boardRolePrecedenceWriteCount: 0,
            distributedUpdatedOrderProjectionVisitCount: SCALE,
            boardWinnerVisitCount: SCALE,
            boardControlBucketWriteCount: SCALE,
            boardTargetAgentVisitCount: SCALE,
            boardTargetMembershipWriteCount: SCALE,
        });
    }, 30_000);

    it('retains only primitive identity and ordinal topology, never source objects', () => {
        const snapshot = freezeDeep(scaleSnapshot(3));
        const sourceObjects = collectObjects(snapshot);

        const index = createControlSnapshotSelectionIndex(snapshot);

        for (const value of collectObjects(index)) {
            expect(sourceObjects.has(value)).toBe(false);
        }
    });

    it('drops rebind candidates when a supposedly equivalent poll changed identity order', () => {
        const snapshot = scaleSnapshot(2);
        const index = createControlSnapshotSelectionIndex(snapshot);
        const changed = structuredClone(snapshot);
        changed.runs.reverse();
        changed.distributedRuns!.reverse();

        expect(rebindControlRunFromSelectionIndex(index, changed, controlId(0))).toBeUndefined();
        expect(rebindDistributedRunFromSelectionIndex(
            index,
            changed,
            distributedId(0),
        )).toBeUndefined();
        expect(rebindControlRunsFromSelectionIndex(
            index,
            changed,
            index.controlRunOrdinalsByUpdatedDesc,
        )).toEqual([]);
        expect(rebindDistributedRunsFromSelectionIndex(
            index,
            changed,
            index.distributedRunOrdinalsByUpdatedDesc,
        )).toEqual([]);
    });
});

function scaleSnapshot(size: number): ControlServerSnapshot {
    return {
        runs: Array.from({ length: size }, (_, ordinal) => controlRun(
            controlId(ordinal),
            ordinal,
            {
                agents: [controlAgent(controlId(ordinal), agentId(ordinal))],
                commands: [controlCommand(
                    controlId(ordinal),
                    agentId(ordinal),
                    commandId(ordinal),
                )],
            },
        )),
        distributedRuns: Array.from({ length: size }, (_, ordinal) => distributedRun(
            distributedId(ordinal),
            controlId(ordinal),
            ordinal,
            'running',
            {
                targetAgentIds: [agentId(ordinal)],
                commandLinks: [commandLink(
                    agentId(ordinal),
                    commandId(ordinal),
                    'start',
                )],
            },
        )),
    };
}

function controlRun(
    runId: string,
    updatedAtEpochMs: number,
    input: Readonly<{
        agents?: readonly ControlAgentSnapshot[];
        commands?: readonly ControlQueuedCommandSnapshot[];
    }> = {},
): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: updatedAtEpochMs,
        updatedAtEpochMs,
        agents: input.agents ?? [],
        commands: input.commands ?? [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function controlAgent(runId: string, value: string): ControlAgentSnapshot {
    return {
        runId,
        agentId: value,
        connected: true,
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: [],
    };
}

function controlCommand(
    runId: string,
    value: string,
    id: string,
    completedAtEpochMs?: number,
): ControlQueuedCommandSnapshot {
    return {
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId,
            agentId: value,
            commandId: id,
            command: { kind: 'health' },
        },
        queuedAtEpochMs: 1,
        completedAtEpochMs,
        dispatchCount: 0,
    };
}

function distributedRun(
    distributedRunId: string,
    controlRunId: string,
    updatedAtEpochMs: number,
    state: ControlDistributedRunSnapshot['state'],
    input: Readonly<{
        targetAgentIds?: readonly string[];
        commandLinks?: readonly ControlDistributedRunCommandLink[];
    }> = {},
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        manifest: {
            distributedRunId,
            controlRunId,
            group: {
                applicationId: 'test',
                workspaceId: 'test',
                groupId: 'test',
            },
            recipes: [],
            targetPolicy: { mode: 'selected-agents', agentIds: [] },
        },
        state,
        createdAtEpochMs: updatedAtEpochMs,
        updatedAtEpochMs,
        targetAgentIds: input.targetAgentIds ?? [],
        commandLinks: input.commandLinks ?? [],
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
                blockingFailures: 0,
            },
            failures: [],
        },
    };
}

function commandLink(
    value: string,
    commandId: string,
    phase: ControlDistributedRunCommandLink['phase'],
    role?: string,
): ControlDistributedRunCommandLink {
    return {
        phase,
        agentId: value,
        commandId,
        role,
        queuedAtEpochMs: 1,
    };
}

function targetResolution(
    agentId: string,
    roleAssignments: NonNullable<ControlDistributedRunSnapshot['targetResolution']>['roleAssignments'],
): NonNullable<ControlDistributedRunSnapshot['targetResolution']> {
    return {
        group: {
            applicationId: 'test',
            workspaceId: 'test',
            groupId: 'test',
        },
        resolvedAtEpochMs: 1,
        staleAfterMs: 1,
        targetPolicyMode: 'selected-agents',
        targetAgentIds: [agentId],
        roleAssignments,
        blockers: [],
        summary: {
            agents: 1,
            targetable: 1,
            selected: 1,
            expectedParticipantCount: 1,
            missingExpectedParticipants: 0,
            staleAgents: 0,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: {},
            regions: {},
            providers: {},
        },
    };
}

function controlId(ordinal: number): string {
    return `control-${ordinal.toString().padStart(5, '0')}`;
}

function distributedId(ordinal: number): string {
    return `distributed-${ordinal.toString().padStart(5, '0')}`;
}

function agentId(ordinal: number): string {
    return `agent-${ordinal.toString().padStart(5, '0')}`;
}

function commandId(ordinal: number): string {
    return `command-${ordinal.toString().padStart(5, '0')}`;
}

function freezeDeep<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(freezeDeep);
    }
    return value;
}

function collectObjects(value: unknown, output = new Set<object>()): Set<object> {
    if (!value || typeof value !== 'object' || output.has(value)) return output;
    output.add(value);
    if (value instanceof Map) {
        value.forEach((entry, key) => {
            collectObjects(key, output);
            collectObjects(entry, output);
        });
    } else {
        Object.values(value).forEach(entry => collectObjects(entry, output));
    }
    return output;
}
