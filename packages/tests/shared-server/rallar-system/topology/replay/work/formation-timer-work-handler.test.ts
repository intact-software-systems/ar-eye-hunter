import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import {
    computeFormationTimerEntries,
    computeFormationTimerEntry,
    decodeFormationTimerWork
} from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeFormationCriterionCommand } from '@shared-server/rallar-system/topology/replay/work/compute-formation-criterion-command.ts';
import { createFormationTimerWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-formation-timer-work-handler.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { createGroupAuthorityFacts, transitionCommand } from '../../../group-state/mutation/group-mutation-test-runtime.ts';

import { createTestGroup } from '../../../../../create-test-group.ts';
import { createTopologyTestGroupSnapshot } from '../../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('formation timer work handler', () => {
    it.each(['reconfiguring', 'reconnecting'] as const)('observes criteria and arms deadlines only while %s is dialing', async (lifecycleState) => {
        const base = createTopologyTestGroupSnapshot();
        const group = { ...base, group: createTestGroup({ ...base.group, lifecycleState, formationEpoch: 2, establishmentStartedAtEpochMs: 1000 }) };
        const command = computeFormationCriterionCommand({
            group,
            planned: {
                groupRef: group.group,
                overlayId: toScopedOverlayId(group.group),
                name: 'candidate',
                topology: 'tree',
                degreeLimit: 2,
                activeSessionIds: [],
                nextHopsBySessionId: {},
                version: 1,
                state: 'active',
                sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 0 },
                createdByClientId: 'server',
                createdAtEpochMs: 1000,
                updatedAtEpochMs: 1000
            },
            rttMeasurements: [],
            nowEpochMs: 2000,
            lifecyclePolicy: { status: 'present', policy: resolveGroupLifecyclePolicyPreset('managed') }
        });
        expect(command?.operation ?? null).toBe(lifecycleState === 'reconnecting' ? 'activateGroup' : null);
        const entries = computeFormationTimerEntries({
            command: transitionCommand('connectGroup'),
            next: group.group,
            policy: resolveGroupLifecyclePolicyPreset('managed'),
            facts: createGroupAuthorityFacts()
        });
        expect(entries.map((entry) => decodeFormationTimerWork(entry.resource).kind)).toEqual(lifecycleState === 'reconnecting' ? ['deadline'] : []);
    });

    it.each(['forming', 'active', 'dormant'] as const)('arms automatic retry only for the initial %s failure landing', (lifecycleState) => {
        const next = createTestGroup({ lifecycleState, formationAttemptCount: 1 });
        const entries = computeFormationTimerEntries({
            command: transitionCommand('failGroupFormation'),
            next,
            policy: resolveGroupLifecyclePolicyPreset('managed'),
            facts: createGroupAuthorityFacts()
        });
        expect(entries.map((entry) => decodeFormationTimerWork(entry.resource).kind)).toEqual(lifecycleState === 'forming' ? ['retry'] : []);
    });

    it('keeps a due deadline retryable while its planned topology is unavailable', async () => {
        const nowEpochMs = 2_000;
        const base = createTopologyTestGroupSnapshot();
        const group = {
            ...base,
            group: createTestGroup({
                ...base.group,
                lifecycleState: 'connecting',
                formationEpoch: 1,
                formationAttemptCount: 1,
                establishmentStartedAtEpochMs: 1_000
            })
        };
        const entry = computeFormationTimerEntry({
            work: {
                kind: 'deadline',
                groupRef: group.group,
                formationEpoch: group.group.formationEpoch,
                groupSnapshotVersion: group.group.snapshotVersion,
                notBeforeEpochMs: nowEpochMs
            },
            senderId: 'formation-timer-test',
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 60_000
        });
        const submittedCommands: GroupMutationCommand[] = [];
        const handler = createFormationTimerWorkHandler({
            findGroupSnapshotByRef: async () => group,
            readPlannedTopology: async () => null,
            topologyPlanning: {
                readTopologyPlanningAuthority: async () => ({
                    group,
                    config: resolveGroupTopologyConfig({}),
                    kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
                    rttReportingDegreeLimit: 5,
                    rttMeasurements: [],
                    replanning: 'auto' as const,
                    nowEpochMs
                })
            },
            readLifecyclePolicy: async () => ({ status: 'absent' }),
            submitCommand: async (command) => {
                submittedCommands.push(command);
            },
            submitAutomationCommand: async (command) => {
                submittedCommands.push(command);
            },
            nowEpochMs: () => nowEpochMs
        });
        const message = newALUntargetedMessage(
            'formation-timer-test',
            newALRoute('formation-timer-test', 'formation-timer-test', 'formation-timer-test'),
            AppOutboxType.FORMATION_TIMER,
            {}
        );

        await expect(handler.onMessage(message, entry)).rejects.toThrow(
            'Formation topology plan is not available'
        );
        expect(submittedCommands).toEqual([]);
    });

    it('refreshes through the timer snapshot version before judging its epoch', async () => {
        const nowEpochMs = 2_000;
        const current = formationGroup({ formationEpoch: 3, snapshotVersion: 8 });
        const requestedVersions: Array<number | undefined> = [];
        const submittedCommands: GroupMutationCommand[] = [];
        const handler = createFormationTimerWorkHandler({
            findGroupSnapshotByRef: async (_ref, options) => {
                requestedVersions.push(options?.minSnapshotVersion);
                return current;
            },
            readPlannedTopology: async () => null,
            topologyPlanning: unusedTopologyPlanning(current, nowEpochMs),
            readLifecyclePolicy: async () => ({ status: 'absent' }),
            submitCommand: async (command) => {
                submittedCommands.push(command);
            },
            submitAutomationCommand: async (command) => {
                submittedCommands.push(command);
            },
            nowEpochMs: () => nowEpochMs
        });

        await handler.onMessage(
            formationTimerMessage(),
            computeFormationTimerEntry({
                work: {
                    kind: 'retry',
                    groupRef: current.group,
                    formationEpoch: current.group.formationEpoch,
                    groupSnapshotVersion: current.group.snapshotVersion,
                    notBeforeEpochMs: nowEpochMs
                },
                senderId: 'formation-timer-test',
                createdAtEpochMs: 1_000,
                expireAtEpochMs: 60_000
            })
        );

        expect(requestedVersions).toEqual([current.group.snapshotVersion]);
        expect(submittedCommands).toMatchObject([
            {
                operation: 'planGroupLayout',
                aggregateRef: {
                    applicationId: current.group.applicationId,
                    workspaceId: current.group.workspaceId,
                    groupId: current.group.groupId
                }
            }
        ]);
    });

    it('keeps the timer retryable when the refreshed group epoch is still behind', async () => {
        const nowEpochMs = 2_000;
        const behind = formationGroup({ formationEpoch: 2, snapshotVersion: 8 });
        const handler = createFormationTimerWorkHandler({
            findGroupSnapshotByRef: async () => behind,
            readPlannedTopology: async () => null,
            topologyPlanning: unusedTopologyPlanning(behind, nowEpochMs),
            readLifecyclePolicy: async () => ({ status: 'absent' }),
            submitAutomationCommand: async () => {
                throw new Error('Unexpected automation');
            },
            submitCommand: async () => {
                throw new Error('A behind snapshot must not submit a command');
            },
            nowEpochMs: () => nowEpochMs
        });

        await expect(
            handler.onMessage(
                formationTimerMessage(),
                computeFormationTimerEntry({
                    work: {
                        kind: 'deadline',
                        groupRef: behind.group,
                        formationEpoch: behind.group.formationEpoch + 1,
                        groupSnapshotVersion: behind.group.snapshotVersion,
                        notBeforeEpochMs: nowEpochMs
                    },
                    senderId: 'formation-timer-test',
                    createdAtEpochMs: 1_000,
                    expireAtEpochMs: 60_000
                })
            )
        ).rejects.toThrow('Formation timer group snapshot is behind');
    });

    it('acknowledges a timer whose epoch has already been superseded', async () => {
        const nowEpochMs = 2_000;
        const current = formationGroup({ formationEpoch: 4, snapshotVersion: 9 });
        const handler = createFormationTimerWorkHandler({
            findGroupSnapshotByRef: async () => current,
            readPlannedTopology: async () => null,
            topologyPlanning: unusedTopologyPlanning(current, nowEpochMs),
            readLifecyclePolicy: async () => ({ status: 'absent' }),
            submitCommand: async () => {
                throw new Error('A superseded timer must not submit a command');
            },
            submitAutomationCommand: async () => {
                throw new Error('A superseded timer must not retry');
            },
            nowEpochMs: () => nowEpochMs
        });

        await expect(
            handler.onMessage(
                formationTimerMessage(),
                computeFormationTimerEntry({
                    work: {
                        kind: 'deadline',
                        groupRef: current.group,
                        formationEpoch: current.group.formationEpoch - 1,
                        groupSnapshotVersion: current.group.snapshotVersion - 1,
                        notBeforeEpochMs: nowEpochMs
                    },
                    senderId: 'formation-timer-test',
                    createdAtEpochMs: 1_000,
                    expireAtEpochMs: 60_000
                })
            )
        ).resolves.toBeUndefined();
    });

    it('rejects timer work without the snapshot version required by the current reader', () => {
        const current = formationGroup({ formationEpoch: 3, snapshotVersion: 8 });
        const entry = computeFormationTimerEntry({
            work: {
                kind: 'retry',
                groupRef: current.group,
                formationEpoch: current.group.formationEpoch,
                groupSnapshotVersion: current.group.snapshotVersion,
                notBeforeEpochMs: 2_000
            },
            senderId: 'formation-timer-test',
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 60_000
        });
        const predecessorResource = entry.resource.replace(
            String.raw`,\"groupSnapshotVersion\":8`,
            ''
        );

        expect(predecessorResource).not.toBe(entry.resource);
        expect(() => decodeFormationTimerWork(predecessorResource)).toThrow(
            'Formation timer work payload fields are invalid'
        );
    });
});

function formationGroup(input: Readonly<{ formationEpoch: number; snapshotVersion: number; }>) {
    const base = createTopologyTestGroupSnapshot();
    return {
        ...base,
        group: createTestGroup({
            ...base.group,
            lifecycleState: 'forming',
            formationEpoch: input.formationEpoch,
            formationAttemptCount: 1,
            snapshotVersion: input.snapshotVersion
        })
    };
}

function unusedTopologyPlanning(group: ReturnType<typeof formationGroup>, nowEpochMs: number) {
    return {
        readTopologyPlanningAuthority: async () => ({
            group,
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttReportingDegreeLimit: 5,
            rttMeasurements: [],
            replanning: 'auto' as const,
            nowEpochMs
        })
    };
}

function formationTimerMessage() {
    return newALUntargetedMessage(
        'formation-timer-test',
        newALRoute('formation-timer-test', 'formation-timer-test', 'formation-timer-test'),
        AppOutboxType.FORMATION_TIMER,
        {}
    );
}
