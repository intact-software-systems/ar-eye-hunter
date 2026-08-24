import { describe, expect, it } from 'vitest';

import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { computeFormationTimerEntry } from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { createFormationTimerWorkHandler } from '@shared-server/rallar-system/topology/replay/create-formation-timer-work-handler.ts';

import { createTestGroup } from '../../../../create-test-group.ts';
import { createTopologyTestGroupSnapshot } from '../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('formation timer topology planning availability', () => {
    it('keeps a due deadline retryable while its planned topology is unavailable', async () => {
        const nowEpochMs = 2_000;
        const base = createTopologyTestGroupSnapshot();
        const group = {
            ...base,
            group: createTestGroup({
                ...base.group,
                lifecycleState: 'establishing',
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
});
