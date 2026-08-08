import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
    GroupTopologyManagementService,
} from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import type {
    GroupTopologyConfigMutationCommand,
} from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

const GROUP_REF = {
    applicationId: 'topology-app',
    workspaceId: 'topology-workspace',
    groupId: 'topology-room',
} as const;

describe('GroupTopologyManagementService AppInbox boundary', () => {
    it('exposes transaction-bound writes without a service-local retry lane or DB lock', () => {
        const source = readFileSync(new URL(
            '../../shared-server/rallar-system/services/group-topology-management-service.ts',
            import.meta.url,
        ), 'utf8');

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
        const preparation = await service.prepareTopologyConfigMutation({
            command: command('putOverride', {
                config: { topologyKind: 'tree' },
                ttlMs: 5_000,
                expiresAtEpochMs: null,
            }),
            commandHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            capturedAtEpochMs: 10_000,
        });

        expect(preparation.stableFacts).toEqual({
            requestedAtEpochMs: 10_000,
            commandHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            resolvedOverrideExpiresAtEpochMs: 15_000,
        });
        expect(preparation.stableFacts).not.toHaveProperty('deleteTarget');
    });

    it.each(['deleteConfig', 'deleteOverride'] as const)(
        'does not capture mutable state while preparing %s',
        async (operation) => {
            const service = createService();
            const preparation = await service.prepareTopologyConfigMutation({
                command: command(operation, {
                    config: null,
                    ttlMs: null,
                    expiresAtEpochMs: null,
                }),
                commandHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                capturedAtEpochMs: 20_000,
            });

            expect(preparation.stableFacts).toEqual({
                requestedAtEpochMs: 20_000,
                commandHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                resolvedOverrideExpiresAtEpochMs: null,
            });
        },
    );

    it('rejects direct config writes that bypass AppInbox execution', async () => {
        const service = createService();
        await expect(service.putConfig({
            groupRef: GROUP_REF,
            config: { topologyKind: 'mesh' },
            updatedByPrincipalId: 'owner',
            requestId: 'bypass-put',
        })).rejects.toThrow(/AppInbox execution/);
        await expect(service.deleteConfig({
            groupRef: GROUP_REF,
            updatedByPrincipalId: 'owner',
            requestId: 'bypass-delete',
        })).rejects.toThrow(/AppInbox execution/);
    });
});

function createService(): GroupTopologyManagementService {
    return new GroupTopologyManagementService({
        findGroupSnapshotByRef: () => Promise.resolve(undefined),
        topologyService: new RallarRtcTopologyService({ now: () => 20_000 }),
        processRttReader: () => [],
        now: () => 20_000,
    });
}

function command(
    operation: GroupTopologyConfigMutationCommand['operation'],
    input: Omit<
        GroupTopologyConfigMutationCommand['input'],
        'updatedByPrincipalId'
    >,
): GroupTopologyConfigMutationCommand {
    return {
        operation,
        aggregateRef: GROUP_REF,
        commandId: `${operation}-command`,
        requestId: `${operation}-request`,
        input: {
            ...input,
            updatedByPrincipalId: 'owner',
        },
    };
}
