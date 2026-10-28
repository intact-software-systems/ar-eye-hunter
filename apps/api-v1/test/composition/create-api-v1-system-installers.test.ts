import assert from 'node:assert/strict';

import type { GroupActivationStatusClockWork } from '@shared-server/rallar-system/group-state/activation-status-clock-outbox-entry.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createActivationStatusClockArm } from '../../src/composition/create-api-v1-system-installers.ts';

const CLOCK: GroupActivationStatusClockWork = {
    kind: 'dwell',
    groupRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'room-1' },
    formationEpoch: 2,
    coverageBasisLayoutIdentity: { groupRevision: 7, presenceRevision: 3, version: 2, state: 'active' },
    candidateCondition: 'degraded',
    dueAtEpochMs: 5_000
};

Deno.test('every activation status clock arm writes its row under the arming trace', async () => {
    const armed: ResourceEntry[] = [];
    const arm = createActivationStatusClockArm({
        outbox: {
            enqueueIfAbsent: (entry) => {
                armed.push(entry);
                return Promise.resolve(entry);
            }
        },
        serviceId: 'server-1',
        nowEpochMs: () => 1_000
    });

    await arm(CLOCK, 'trace-activation-arm-1');
    await arm(CLOCK, 'trace-activation-arm-2');

    const traces = armed.map((entry) => decodePersistedALMessage(entry.resource).id.traceId);
    assert.deepEqual(traces, ['trace-activation-arm-1', 'trace-activation-arm-2']);
});
