import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { GroupTopologyConfigMutationService } from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createTopologyConfigMutationTestInput,
    deepFreezeTopologyTestValue
} from './group-topology-config-mutation-test-fixtures.ts';

describe('group topology config mutation phases', () => {
    it('computes override expiry from explicit command and read facts without a prepare phase', () => {
        const service = createService();
        const mutation = createTopologyConfigMutationTestInput({ operation: 'putOverride' });
        const command = {
            ...mutation.command,
            commandHash: `sha256:${'a'.repeat(64)}`,
            capturedAtEpochMs: 10_000,
            input: { ...mutation.command.input, ttlMs: 5_000 }
        };
        const read = deepFreezeTopologyTestValue({
            state: mutation.read,
            policyNowEpochMs: 10_000,
            isPlatformAdmin: false,
            serverDefaults: {}
        });
        const computed = service.compute(command, read, 1);

        expect(computed).toMatchObject({
            outcome: 'write',
            receipt: {
                commandHash: command.commandHash,
                acceptedCreatedAtEpochMs: 10_000,
                acceptedUpdatedAtEpochMs: 10_000,
                acceptedExpiresAtEpochMs: 15_000
            }
        });
        expect(() => service.validate({ command, read, attemptCount: 1, computed })).not.toThrow();
    });

    it('keeps compute and validate repeatable after explicit read facts are captured', () => {
        const isPlatformAdmin = () => {
            throw new Error('Compute and validate must use the captured authority fact');
        };
        const service = createService(isPlatformAdmin);
        const mutation = createTopologyConfigMutationTestInput();
        const read = deepFreezeTopologyTestValue({
            state: mutation.read,
            policyNowEpochMs: 1_000,
            isPlatformAdmin: false,
            serverDefaults: {}
        });

        const first = service.compute(mutation.command, read, 1);
        const second = service.compute(mutation.command, read, 1);

        expect(second).toEqual(first);
        expect(() => service.validate({ command: mutation.command, read, attemptCount: 1, computed: first })).not.toThrow();
        expect(() => service.validate({ command: mutation.command, read, attemptCount: 1, computed: second })).not.toThrow();
    });
});

function createService(isPlatformAdmin: (principalId: string) => boolean = () => false): GroupTopologyConfigMutationService {
    const runtimeRepository = new FakeRuntimeStateRepository();
    return new GroupTopologyConfigMutationService({
        configRepository: new GroupTopologyConfigRepository(runtimeRepository),
        groupStateRepository: createTestGroupStateRepository(runtimeRepository),
        nowEpochMs: () => 20_000,
        isPlatformAdmin,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
    });
}
