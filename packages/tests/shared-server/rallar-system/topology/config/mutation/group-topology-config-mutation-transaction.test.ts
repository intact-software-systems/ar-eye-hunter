import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyConfigMutationService } from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';
import type { GroupTopologyConfigMutationCommand } from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';

import { FakeRuntimeStateRepository } from '../../../../fake-runtime-state-repository.ts';

const GROUP_REF = {
    applicationId: 'topology-app',
    workspaceId: 'topology-workspace',
    groupId: 'topology-room'
} as const;

describe('group topology config mutation transaction shell', () => {
    it('exposes transaction-bound writes without a service-local retry lane or DB lock', () => {
        const source = readFileSync(
            new URL(
                '../../../../../../shared-server/rallar-system/topology/config/mutation/write-topology-config-mutation.ts',
                import.meta.url
            ),
            'utf8'
        );

        expect(source).not.toMatch(/createInProcessMutationLane|configMutationLane/);
        expect(source).not.toMatch(/waitForRuntimeStateWriteRetry/);
        expect(source).not.toMatch(/\bfor\s*\([^)]*attempt/);
        expect(source).not.toMatch(/\.begin\s*\(/);
        expect(source).not.toMatch(/for\s+update|pg_advisory|row lock/i);
        expect(source).toContain('writeTopologyConfigMutation(');
        expect(source).toContain('transaction: PSqlTransactionSql');
    });

    it('materializes only first-winner time facts before an override attempt', async () => {
        const service = createService();
        const preparation = await service.prepare({
            command: command('putOverride', {
                config: { topologyKind: 'tree' },
                ttlMs: 5_000,
                expiresAtEpochMs: null
            }),
            commandHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            capturedAtEpochMs: 10_000
        });

        expect(preparation.stableFacts).toEqual({
            requestedAtEpochMs: 10_000,
            commandHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            resolvedOverrideExpiresAtEpochMs: 15_000
        });
        expect(preparation.stableFacts).not.toHaveProperty('deleteTarget');
    });

    it.each(['deleteConfig', 'deleteOverride'] as const)(
        'does not capture mutable state while preparing %s',
        async (operation) => {
            const service = createService();
            const preparation = await service.prepare({
                command: command(operation, {
                    config: null,
                    ttlMs: null,
                    expiresAtEpochMs: null
                }),
                commandHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                capturedAtEpochMs: 20_000
            });

            expect(preparation.stableFacts).toEqual({
                requestedAtEpochMs: 20_000,
                commandHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                resolvedOverrideExpiresAtEpochMs: null
            });
        }
    );
});

function createService(): GroupTopologyConfigMutationService {
    const runtimeRepository = new FakeRuntimeStateRepository();
    return new GroupTopologyConfigMutationService({
        readiness: { ensure: async () => undefined },
        configRepository: new GroupTopologyConfigRepository(runtimeRepository),
        groupStateRepository: new GroupStateRepository(runtimeRepository),
        nowEpochMs: () => 20_000,
        isPlatformAdmin: () => false
    });
}

function command(
    operation: GroupTopologyConfigMutationCommand['operation'],
    input: Omit<GroupTopologyConfigMutationCommand['input'], 'updatedByPrincipalId'>
): GroupTopologyConfigMutationCommand {
    return {
        operation,
        aggregateRef: GROUP_REF,
        commandId: `${operation}-command`,
        requestId: `${operation}-request`,
        input: {
            ...input,
            updatedByPrincipalId: 'owner'
        }
    };
}
