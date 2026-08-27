import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { computeFormationTimerEntry, decodeFormationTimerWork } from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { createFormationTimerWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-formation-timer-work-handler.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';

import { createTestGroup } from '../../../../../create-test-group.ts';
import { createTopologyTestGroupSnapshot } from '../../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('formation timer work handler', () => {
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
                    rttMeasurements: [],
                    nowEpochMs
                })
            },
            readLifecyclePolicy: async () => ({ status: 'absent' }),
            submitCommand: async (command) => {
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
                operation: 'startGroupEstablishment',
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
            rttMeasurements: [],
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
