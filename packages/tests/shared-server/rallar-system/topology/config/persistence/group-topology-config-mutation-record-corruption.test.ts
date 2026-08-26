import { describe, expect, it } from 'vitest';

import { GroupTopologyConfigRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTopologyTestEffectiveConfig, createTopologyTestGroupRef } from './group-topology-config-persistence-test-fixtures.ts';

describe('group topology config mutation record corruption', () => {
    it('rejects a persisted mutation record whose receipt commandId differs from requestId', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createTopologyTestGroupRef('workspace-1');
        const requestId = 'expected-request';
        const commandHash = `sha256:${'a'.repeat(64)}`;
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            repository.mutationKey(groupRef, requestId),
            JSON.stringify({
                groupRef,
                requestId,
                commandHash,
                receipt: {
                    commandId: 'different-request',
                    requestId,
                    commandHash,
                    operation: 'deleteConfig',
                    outcome: 'no-op',
                    attemptCount: 1,
                    groupRef,
                    target: 'config',
                    acceptedVersion: 0,
                    acceptedStorageRevision: null,
                    acceptedCreatedAtEpochMs: null,
                    acceptedUpdatedAtEpochMs: null,
                    acceptedExpiresAtEpochMs: null,
                    acceptedConfig: null,
                    acceptedCausalRevision: null,
                    eventId: null,
                    outboxIds: []
                }
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(repository.findMutationRecord(groupRef, requestId)).rejects.toThrow(
            'receipt commandId differs from requestId'
        );
    });

    it.each([
        {
            label: 'operation-target mismatch',
            receipt: { operation: 'putConfig', target: 'override' },
            message: 'operation target is invalid'
        },
        {
            label: 'applied missing accepted storage revision',
            receipt: {
                outcome: 'applied',
                acceptedVersion: 1,
                acceptedStorageRevision: null
            },
            message: 'applied receipt is incomplete'
        },
        {
            label: 'applied zero accepted version',
            receipt: {
                outcome: 'applied',
                acceptedVersion: 0,
                acceptedStorageRevision: 0
            },
            message: 'applied receipt is incomplete'
        }
    ])('rejects persisted $label payloads', async ({ receipt, message }, index) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createTopologyTestGroupRef('workspace-1');
        const requestId = `invalid-receipt-${index}`;
        const commandHash = `sha256:${'b'.repeat(64)}`;
        const acceptedCausalRevision = {
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 0,
            presenceVersion: 0
        };
        const outboxId = [
            requestId,
            'rtc-topology-recompute',
            'group-revision',
            'group=1;presence=0'
        ].join(':');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            repository.mutationKey(groupRef, requestId),
            JSON.stringify({
                groupRef,
                requestId,
                commandHash,
                receipt: {
                    commandId: requestId,
                    requestId,
                    commandHash,
                    operation: 'deleteConfig',
                    outcome: 'no-op',
                    attemptCount: 1,
                    groupRef,
                    target: 'config',
                    acceptedVersion: 0,
                    acceptedStorageRevision: null,
                    acceptedCreatedAtEpochMs: null,
                    acceptedUpdatedAtEpochMs: null,
                    acceptedExpiresAtEpochMs: null,
                    acceptedConfig: null,
                    acceptedCausalRevision,
                    eventId: null,
                    outboxIds: [outboxId],
                    ...receipt
                }
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(repository.findMutationRecord(groupRef, requestId)).rejects.toThrow(message);
    });

    it.each(['putConfig', 'putOverride'] as const)(
        'rejects a persisted impossible %s no-op receipt as typed corruption',
        async (operation) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createTopologyTestGroupRef('workspace-1');
            const requestId = `persisted-impossible-${operation}`;
            const commandHash = `sha256:${'6'.repeat(64)}`;
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                repository.mutationKey(groupRef, requestId),
                JSON.stringify({
                    groupRef,
                    requestId,
                    commandHash,
                    receipt: {
                        commandId: requestId,
                        requestId,
                        commandHash,
                        operation,
                        outcome: 'no-op',
                        attemptCount: 1,
                        groupRef,
                        target: operation === 'putConfig' ? 'config' : 'override',
                        acceptedVersion: 1,
                        acceptedStorageRevision: null,
                        acceptedCreatedAtEpochMs: 1_000,
                        acceptedUpdatedAtEpochMs: 1_000,
                        acceptedExpiresAtEpochMs: operation === 'putOverride' ? 6_000 : null,
                        acceptedConfig: createTopologyTestEffectiveConfig('tree'),
                        acceptedCausalRevision: null,
                        eventId: null,
                        outboxIds: []
                    }
                }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );

            await expect(repository.findMutationRecord(groupRef, requestId)).rejects.toBeInstanceOf(
                GroupTopologyConfigRepositoryInvariantCorruptionError
            );
        }
    );

    it.each([
        {
            label: 'put receipt without replay timestamps',
            receipt: {
                acceptedCreatedAtEpochMs: null,
                acceptedUpdatedAtEpochMs: null
            },
            message: 'receipt timestamps do not match operation'
        },
        {
            label: 'config receipt with override expiry',
            receipt: { acceptedExpiresAtEpochMs: 2 },
            message: 'receipt expiry does not match operation'
        }
    ])('rejects persisted $label', async ({ receipt, message }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createTopologyTestGroupRef('workspace-1');
        const requestId = 'expected-request';
        const commandHash = `sha256:${'c'.repeat(64)}`;
        const acceptedCausalRevision = {
            causalRevision: { groupRevision: 2, presenceRevision: 0 },
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0
        };
        const outboxId = [
            requestId,
            'rtc-topology-recompute',
            'group-revision',
            `group=${acceptedCausalRevision.causalRevision.groupRevision};presence=${acceptedCausalRevision.causalRevision.presenceRevision}`
        ].join(':');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            repository.mutationKey(groupRef, requestId),
            JSON.stringify({
                groupRef,
                requestId,
                commandHash,
                receipt: {
                    commandId: requestId,
                    requestId,
                    commandHash,
                    operation: 'putConfig',
                    outcome: 'applied',
                    attemptCount: 1,
                    groupRef,
                    target: 'config',
                    acceptedVersion: 1,
                    acceptedStorageRevision: 0,
                    acceptedCreatedAtEpochMs: 1,
                    acceptedUpdatedAtEpochMs: 1,
                    acceptedExpiresAtEpochMs: null,
                    acceptedConfig: createTopologyTestEffectiveConfig('tree'),
                    acceptedCausalRevision,
                    eventId: null,
                    outboxIds: [outboxId],
                    ...receipt
                }
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(repository.findMutationRecord(groupRef, requestId)).rejects.toThrow(message);
    });
});
