import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it, vi } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
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

    it('executes persistence-ready computed data without serializing in the transaction', async () => {
        const service = createService();
        const mutation = createTopologyConfigMutationTestInput();
        const read = {
            state: mutation.read,
            policyNowEpochMs: 1_000,
            isPlatformAdmin: false,
            serverDefaults: {}
        };
        const computed = service.compute(mutation.command, read, 1);
        service.validate({ command: mutation.command, read, attemptCount: 1, computed });
        if (computed.outcome !== 'write') {
            throw new Error('Expected topology config write');
        }
        const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
            throw new Error('Serialization entered the transaction');
        });

        try {
            await expect(service.write(createSuccessfulTransaction(), computed)).resolves.toBe(
                computed.receipt
            );
        }
        finally {
            stringify.mockRestore();
        }
    });
});

function createSuccessfulTransaction(): PSqlSql {
    const revisions = [1, 0, 0, 0, 0];
    function sql<Result>(
        strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql(_values: readonly PSqlParameter[]): object;
    function sql(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]
    ) {
        if (Array.isArray(stringsOrValues) && !Object.hasOwn(stringsOrValues, 'raw')) {
            return {};
        }
        const query = (stringsOrValues as TemplateStringsArray).join(' ');
        if (query.includes('returning ri_row_id')) {
            return Promise.resolve([{ ri_row_id: 1n }]);
        }
        if (query.includes('returning revision')) {
            return Promise.resolve([{ revision: revisions.shift() ?? 0 }]);
        }
        return Promise.resolve([]);
    }
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('Topology config write must not open a transaction');
        }
    });
}

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
