import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AuditStamp, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type {
    EffectiveGroupTopologyConfig,
} from '@shared/api/graph-topology-management-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    GroupTopologyConfigRepository,
    GroupTopologyConfigRepositoryInvariantCorruptionError,
    RtcRttRepository,
    RtcTopologySnapshotRepository,
} from '@shared-server/mod.ts';
import {
    GroupTopologyManagementService,
    GroupTopologyConfigIdempotencyConflictError,
    GroupTopologyValidationError,
    type DeleteGroupTopologyConfigInput,
    type GroupTopologyConfigMutationExecution,
    type PutGroupTopologyConfigInput,
    type PutGroupTopologyOverrideInput,
} from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import {
    createStateMutationOutboxRecord,
    STATE_MUTATION_OUTBOX_NAMESPACE,
    StateMutationOutboxRepository,
    hashStateMutationCommand,
} from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import type {
    GroupTopologyConfigMutationCommand,
    GroupTopologyConfigMutationComputed,
} from '@shared-server/rallar-system/services/group-topology-config-mutations.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import {
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
} from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import {
    ReadBatchFakeRuntimeStateRepository,
} from './read-batch-fake-runtime-state-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchEffect,
    type RuntimeStateGuardedBatchEffectResult,
    type RuntimeStateGuardedBatchGuard,
    type RuntimeStateGuardedBatchGuardResult,
    type RuntimeStateGuardedBatchResult,
    validateRuntimeStateGuardedBatch,
    validateRuntimeStateGuardedBatchResult,
} from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';

describe('GroupTopologyManagementService', () => {
    /*
     * Task 7 coverage migration (old architecture -> canonical owner):
     * - 17 guarded-batch/lane assertions -> 7 structural, phase, authority,
     *   invariant-retry, and PGlite transaction tests.
     * - 3 intermediate-outbox/wake assertions -> 3 exact replay, divergent
     *   WS_OUTBOX collision, and reservation-fence PGlite tests.
     * - 5 direct persistent topology/removal assertions -> 5 pure
     *   computation/removal and APP_OUTBOX worker transaction tests.
     * The 51 remaining tests retain normalization, authorization, generation,
     * expiry, receipt/replay, corruption, topology, and RTT-filter semantics.
     */
    it('exposes transaction-bound topology writes without a service-local lane or retry loop', () => {
        const source = readFileSync(new URL(
            '../../shared-server/rallar-system/services/group-topology-management-service.ts',
            import.meta.url,
        ), 'utf8');

        expect(source).not.toMatch(/createInProcessMutationLane|configMutationLane/);
        expect(source).not.toMatch(/waitForRuntimeStateWriteRetry/);
        expect(source).not.toMatch(/\bfor\s*\([^)]*attempt/);
        expect(source).not.toMatch(/\.begin\s*\(/);
        expect(source).toMatch(
            /writeTopologyConfigMutation\(\s*transaction:\s*PSqlTransactionSql/,
        );
        expect(source).toMatch(
            /writeTopologyMutation\(\s*transaction:\s*PSqlTransactionSql/,
        );
        expect(source).toMatch(/writeRtcTopologyOutbox\(transaction/);
        expect(source).toMatch(
            /writeTopologyMutation[\s\S]*advanceAuthorityFence[\s\S]*writeRtcTopologyOutbox/,
        );
        expect(source).not.toMatch(/StateMutationOutboxRepository|STATE_MUTATION_OUTBOX_NAMESPACE/);
    });

    it('batches the exact topology-config mutation read slots', async () => {
        const runtimeRepository = new ReadBatchFakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('mutation-read-batch'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            now: () => 1_000,
        });

        await service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'owner',
            requestId: 'mutation-read-batch',
        });

        const mutationCalls = runtimeRepository.readBatchCalls.filter((selectors) =>
            selectors.some(({ selectorId }) =>
                selectorId === 'topology-invariant'
            )
        );
        expect(mutationCalls).toEqual([[
            {
                selectorId: 'topology-invariant',
                kind: 'key',
                namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                key: configRepository.invariantGenerationKey(group.group),
            },
            {
                selectorId: 'topology-config',
                kind: 'key',
                namespace: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                key: configRepository.configKey(group.group),
            },
            {
                selectorId: 'topology-override',
                kind: 'key',
                namespace: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                key: configRepository.overrideKey(group.group),
            },
            {
                selectorId: 'topology-generation-config',
                kind: 'key',
                namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                key: configRepository.generationKey(group.group, 'config'),
            },
            {
                selectorId: 'topology-generation-override',
                kind: 'key',
                namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                key: configRepository.generationKey(group.group, 'override'),
            },
            {
                selectorId: 'topology-idempotency',
                kind: 'key',
                namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                key: groupStateIdempotencyStorageKey(
                    group.group,
                    'mutation-read-batch',
                ),
            },
        ]]);
    });

    it.each([
        {
            label: 'archives the group',
            updatedByPrincipalId: 'owner',
            isPlatformAdmin: false,
            mutate: (snapshot: GroupSnapshot): GroupSnapshot => ({
                ...snapshot,
                stateRevision: snapshot.stateRevision + 1,
                causalRevision: {
                    ...snapshot.causalRevision,
                    groupRevision: snapshot.causalRevision.groupRevision + 1,
                },
                group: {
                    ...snapshot.group,
                    status: 'archived',
                    deleted: null,
                    snapshotVersion: snapshot.group.snapshotVersion + 1,
                    updated: audit(2),
                    archived: audit(2),
                },
            }),
        },
        {
            label: 'demotes the owner',
            updatedByPrincipalId: 'owner',
            isPlatformAdmin: false,
            mutate: (snapshot: GroupSnapshot): GroupSnapshot => ({
                ...snapshot,
                stateRevision: snapshot.stateRevision + 1,
                causalRevision: {
                    ...snapshot.causalRevision,
                    groupRevision: snapshot.causalRevision.groupRevision + 1,
                },
                group: {
                    ...snapshot.group,
                    ownerPrincipalId: 'session-b',
                    snapshotVersion: snapshot.group.snapshotVersion + 1,
                    rosterVersion: snapshot.group.rosterVersion + 1,
                    updated: audit(2),
                },
                members: snapshot.members.map((member) =>
                    member.principalId === 'owner'
                        ? {
                            ...member,
                            role: 'member' as const,
                            updated: audit(2),
                        }
                        : member.principalId === 'session-b'
                        ? {
                            ...member,
                            role: 'owner' as const,
                            updated: audit(2),
                        }
                        : member
                ),
            }),
        },
        {
            label: 'archives the group for a platform admin',
            updatedByPrincipalId: 'platform-admin',
            isPlatformAdmin: true,
            mutate: (snapshot: GroupSnapshot): GroupSnapshot => ({
                ...snapshot,
                stateRevision: snapshot.stateRevision + 1,
                causalRevision: {
                    ...snapshot.causalRevision,
                    groupRevision: snapshot.causalRevision.groupRevision + 1,
                },
                group: {
                    ...snapshot.group,
                    status: 'archived',
                    deleted: null,
                    snapshotVersion: snapshot.group.snapshotVersion + 1,
                    updated: audit(2),
                    archived: audit(2),
                },
            }),
        },
    ])('rejects when a concurrent mutation $label immediately before the authority CAS', async ({ label, mutate, updatedByPrincipalId, isPlatformAdmin }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-authority-race'));
        seedGroupAuthorityState(runtimeRepository, group);
        const changed = mutate(group);
        let injected = false;
        let reapplied = false;
        const applyConcurrentMutation = async (): Promise<void> => {
            await runtimeRepository.upsert(
                'group-state:groups',
                groupStateGroupStorageKey(group.group),
                JSON.stringify(changed.group),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            for (const member of changed.members) {
                const original = group.members.find((candidate) =>
                    candidate.principalId === member.principalId
                );
                if (JSON.stringify(original) === JSON.stringify(member)) continue;
                await runtimeRepository.upsert(
                    'group-state:members',
                    groupStateMemberStorageKey(member),
                    JSON.stringify(member),
                    NEVER_EXPIRE_AT_TIMESTAMP,
                );
            }
        };
        runtimeRepository.beforeConditionalWrite = async () => {
            if (!injected) {
                injected = true;
                await applyConcurrentMutation();
            }
        };
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            adminPrincipalIds: isPlatformAdmin
                ? new Set([updatedByPrincipalId])
                : undefined,
            sleep: async () => {
                if (injected && !reapplied) {
                    reapplied = true;
                    await applyConcurrentMutation();
                }
            },
        });
        const requestId = `authority-race-${label.replaceAll(' ', '-')}`;

        await expect(service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId,
            requestId,
        })).rejects.toMatchObject({ status: 403 });
        expect(await configRepository.findConfig(group.group)).toBeUndefined();
        expect(await configRepository.findMutationRecord(
            group.group,
            requestId,
        )).toBeUndefined();
    });

    it('rechecks platform-admin policy after an outer optimistic retry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(
            createGroupRef('workspace-platform-admin-retry'),
        );
        const adminPrincipalIds = new Set(['platform-admin']);
        const configRepository = new GroupTopologyConfigRepository(
            runtimeRepository,
        );
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            adminPrincipalIds,
            sleep: () => Promise.resolve(),
        });
        let injected = false;
        runtimeRepository.beforeConditionalWrite = (
            operation,
            namespace,
        ) => {
            if (
                !injected &&
                operation === 'upsertIfRevision' &&
                namespace === 'group-state:groups'
            ) {
                injected = true;
                adminPrincipalIds.delete('platform-admin');
                throw new RuntimeStateWriteConflictError();
            }
        };

        await expect(service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'platform-admin',
            requestId: 'platform-admin-retry',
        })).rejects.toMatchObject({ status: 403 });

        expect(injected).toBe(true);
        expect(await configRepository.findConfig(group.group)).toBeUndefined();
        expect(await configRepository.findMutationRecord(
            group.group,
            'platform-admin-retry',
        )).toBeUndefined();
    });

    it('serializes cross-target writes before accepting a combined effective invariant', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        runtimeRepository.serializeTransactions = true;
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        await blockFirstReadsTogether(
            runtimeRepository,
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            configRepository.configKey(group.group),
            2,
        );
        const configService = createService({
            runtimeRepository,
            group,
            configRepository,
            sleep: () => Promise.resolve(),
        });
        const overrideService = createService({
            runtimeRepository,
            group,
            configRepository,
            sleep: () => Promise.resolve(),
        });

        const settled = await Promise.allSettled([
            configService.putConfig({
                groupRef: group.group,
                config: { meshParamK: 4 },
                updatedByPrincipalId: 'owner',
                requestId: 'cross-target-config',
            }),
            overrideService.putOverride({
                groupRef: group.group,
                config: { degreeLimit: 3 },
                expiresAtEpochMs: Date.now() + 60_000,
                updatedByPrincipalId: 'owner',
                requestId: 'cross-target-override',
            }),
        ]);

        expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(settled.filter(({ status }) => status === 'rejected'))
            .toEqual([expect.objectContaining({
                reason: expect.objectContaining({
                    code: 'group-topology-config-validation-failed',
                }),
            })]);
        const [durable, temporary] = await Promise.all([
            configRepository.findConfig(group.group),
            configRepository.findOverride(group.group),
        ]);
        expect(Number(durable !== undefined) + Number(temporary !== undefined)).toBe(1);
        expect(await configRepository.findInvariantGenerationEntry(group.group))
            .toMatchObject({
                value: { version: 1 },
                entry: {
                    key: configRepository.invariantGenerationKey(group.group),
                    revision: 0,
                },
            });
        await expect(configService.readConfig(group.group)).resolves.toBeDefined();
    });

        it('does not let a temporary override hide an invalid durable config after expiry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const service = createService({
            runtimeRepository,
            group,
            serverDefaults: { degreeLimit: 3, meshParamK: 2 },
        });
        await service.putOverride({
            groupRef: group.group,
            config: { degreeLimit: 5 },
            expiresAtEpochMs: Date.now() + 60_000,
            updatedByPrincipalId: 'owner',
            requestId: 'temporary-invariant-cover',
        });

        await expect(service.putConfig({
            groupRef: group.group,
            config: { meshParamK: 4 },
            updatedByPrincipalId: 'owner',
            requestId: 'invalid-after-expiry',
        })).rejects.toMatchObject({
            code: 'group-topology-config-validation-failed',
        });
    });

    it('retains per-target versions across delete and physical override expiry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const group = createGroupSnapshot(createGroupRef('workspace-1'));
            const service = createService({
                runtimeRepository,
                group,
                now: () => Date.now(),
            });

            const firstConfig = await service.putConfig({
                groupRef: group.group,
                config: { topologyKind: 'tree' },
                updatedByPrincipalId: 'owner',
                requestId: 'version-config-1',
            });
            const deletedConfig = await service.deleteConfig({
                groupRef: group.group,
                updatedByPrincipalId: 'owner',
                requestId: 'version-config-delete',
            });
            vi.setSystemTime(2_000);
            const recreatedConfig = await service.putConfig({
                groupRef: group.group,
                config: { topologyKind: 'mesh' },
                updatedByPrincipalId: 'owner',
                requestId: 'version-config-2',
            });

            expect([
                firstConfig.config.version,
                deletedConfig.receipt.acceptedVersion,
                recreatedConfig.config.version,
            ]).toEqual([1, 2, 3]);

            const firstOverride = await service.putOverride({
                groupRef: group.group,
                config: { degreeLimit: 3 },
                expiresAtEpochMs: 2_500,
                updatedByPrincipalId: 'owner',
                requestId: 'version-override-1',
            });
            vi.setSystemTime(2_501);
            expect(await runtimeRepository.deleteExpired(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            )).toBe(1);
            const recreatedOverride = await service.putOverride({
                groupRef: group.group,
                config: { degreeLimit: 4 },
                expiresAtEpochMs: 4_000,
                updatedByPrincipalId: 'owner',
                requestId: 'version-override-2',
            });

            expect([
                firstOverride.override.version,
                recreatedOverride.override.version,
            ]).toEqual([1, 2]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('backfills an expired legacy override generation before recreating it', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const group = createGroupSnapshot(createGroupRef('workspace-1'));
            const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                configRepository.overrideKey(group.group),
                JSON.stringify({
                    groupRef: group.group,
                    config: { ...effectiveTopologyConfig(), degreeLimit: 3 },
                    version: 7,
                    createdAtEpochMs: 1_000,
                    updatedAtEpochMs: 1_000,
                    updatedByPrincipalId: 'legacy-owner',
                    expiresAtEpochMs: 1_500,
                }),
                1_500,
            );
            const service = createService({
                runtimeRepository,
                group,
                configRepository,
                now: () => Date.now(),
                sleep: () => Promise.resolve(),
            });

            await expect(service.readConfig(group.group)).resolves.toMatchObject({
                temporary: null,
            });
            await expect(configRepository.findGenerationEntry(group.group, 'override'))
                .resolves.toMatchObject({ value: { version: 7 } });

            const recreated = await service.putOverride({
                groupRef: group.group,
                config: { degreeLimit: 4 },
                expiresAtEpochMs: 3_000,
                updatedByPrincipalId: 'owner',
                requestId: 'legacy-override-recreated',
            });

            expect(recreated.override.version).toBe(8);
            expect(await configRepository.findGenerationEntry(group.group, 'override'))
                .toMatchObject({ value: { version: 8 } });
        } finally {
            vi.useRealTimers();
        }
    });

    it('rolls state back and retries when the durable generation guard conflicts', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            sleep: () => Promise.resolve(),
        });
        await service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'owner',
            requestId: 'generation-seed',
        });
        const staleGeneration = await configRepository.findGenerationEntry(
            group.group,
            'config',
        );
        expect(staleGeneration).toBeDefined();
        expect(await configRepository.commitGeneration({
            groupRef: group.group,
            target: 'config',
            version: 2,
        }, staleGeneration!.entry.revision)).toMatchObject({ status: 'accepted' });
        returnFirstEntryAs(
            runtimeRepository,
            GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            configRepository.generationKey(group.group, 'config'),
            staleGeneration,
        );

        const result = await service.putConfig({
            groupRef: group.group,
            config: effectiveTopologyConfig('mesh'),
            updatedByPrincipalId: 'owner',
            requestId: 'generation-retry',
        });

        expect(result.config.version).toBe(3);
        expect(await configRepository.findConfig(group.group)).toEqual(result.config);
        expect(await configRepository.findGenerationEntry(group.group, 'config'))
            .toMatchObject({ value: { version: 3 } });
    });

    it('retries when an outside-transaction read observes config ahead of its generation', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            sleep: () => Promise.resolve(),
        });
        const seeded = await service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'owner',
            requestId: 'split-read-seed',
        });
        const staleGeneration = await configRepository.findGenerationEntry(
            group.group,
            'config',
        );
        const currentConfig = await configRepository.findConfigEntry(group.group);
        expect(await configRepository.commitConfig({
            ...seeded.config,
            config: effectiveTopologyConfig('mesh'),
            version: 2,
            updatedAtEpochMs: seeded.config.updatedAtEpochMs + 1,
            requestId: 'split-read-winner',
        }, currentConfig!.entry.revision)).toMatchObject({ status: 'accepted' });
        expect(await configRepository.commitGeneration({
            groupRef: group.group,
            target: 'config',
            version: 2,
        }, staleGeneration!.entry.revision)).toMatchObject({ status: 'accepted' });
        returnFirstEntryAs(
            runtimeRepository,
            GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            configRepository.generationKey(group.group, 'config'),
            staleGeneration,
        );

        const result = await service.putConfig({
            groupRef: group.group,
            config: {
                ...effectiveTopologyConfig('tree'),
                degreeLimit: 4,
            },
            updatedByPrincipalId: 'owner',
            requestId: 'split-read-retry',
        });

        expect(result.config.version).toBe(3);
        expect(await configRepository.findGenerationEntry(group.group, 'config'))
            .toMatchObject({ value: { version: 3 } });
    });

    it('retries when the aggregate invariant token changes across an outside-transaction read', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const retry = vi.fn(async () => {});
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            sleep: retry,
        });
        const seeded = await service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'owner',
            requestId: 'invariant-read-seed',
        });
        const staleInvariant = await configRepository.findInvariantGenerationEntry(
            group.group,
        );
        expect(await configRepository.commitOverride({
            ...seeded.config,
            config: {
                ...effectiveTopologyConfig('tree'),
                degreeLimit: 4,
            },
            version: 1,
            requestId: null,
            expiresAtEpochMs: seeded.config.updatedAtEpochMs + 60_000,
        }, null)).toMatchObject({ status: 'accepted' });
        expect(await configRepository.commitGeneration({
            groupRef: group.group,
            target: 'override',
            version: 1,
        }, null)).toMatchObject({ status: 'accepted' });
        expect(await configRepository.commitInvariantGeneration({
            groupRef: group.group,
            version: 2,
        }, staleInvariant!.entry.revision)).toMatchObject({ status: 'accepted' });
        returnFirstEntryAs(
            runtimeRepository,
            GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            configRepository.invariantGenerationKey(group.group),
            staleInvariant,
        );

        const result = await service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'mesh' },
            updatedByPrincipalId: 'owner',
            requestId: 'invariant-read-retry',
        });

        expect(result.config.version).toBe(2);
        expect(retry).toHaveBeenCalledOnce();
    });

    it('does not let a stale delete remove a refreshed config', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const first = topologyConfig(group.group, 1, 'tree', 'config-1');
        const refreshed = topologyConfig(group.group, 2, 'mesh', 'config-2');
        await configRepository.commitConfig(first, null);
        const staleEntry = await configRepository.findConfigEntry(group.group);
        await configRepository.commitConfig(refreshed, staleEntry!.entry.revision);
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            now: () => 3_000,
        });
        await service.readConfig(group.group);
        returnFirstEntryAs(
            runtimeRepository,
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            configRepository.configKey(group.group),
            staleEntry,
        );

        const result = await service.deleteConfig({
            groupRef: group.group,
            updatedByPrincipalId: 'owner',
            requestId: 'delete-stale-config',
        });

        expect(result).toMatchObject({
            deleted: false,
            receipt: {
                outcome: 'no-op',
                acceptedVersion: 2,
                acceptedStorageRevision: 1,
                outboxId: null,
            },
        });
        expect(await configRepository.findConfig(group.group)).toEqual(refreshed);
    });

    it('recomputes lifecycle authorization and effective-config invariants after conflict', async () => {
        const group = createGroupSnapshot(createGroupRef('workspace-1'));

        const authorizationRuntime = new FakeRuntimeStateRepository();
        const authorizationRepository = new GroupTopologyConfigRepository(
            authorizationRuntime,
        );
        await authorizationRepository.commitConfig(
            topologyConfig(group.group, 1, 'tree', 'winner'),
            null,
        );
        const authorizationService = createService({
            runtimeRepository: authorizationRuntime,
            group,
            configRepository: authorizationRepository,
            sleep: async () => {
                await persistGroupAuthorityMutation(authorizationRuntime, {
                    ...group,
                    group: {
                        ...group.group,
                        status: 'archived',
                        deleted: null,
                        snapshotVersion: group.group.snapshotVersion + 1,
                        updated: audit(2),
                        archived: audit(2),
                    },
                });
            },
        });
        await authorizationService.readConfig(group.group);
        returnFirstEntryAs(
            authorizationRuntime,
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            authorizationRepository.configKey(group.group),
            undefined,
        );
        await expect(authorizationService.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'mesh' },
            updatedByPrincipalId: 'owner',
            requestId: 'fresh-authorization',
        })).rejects.toMatchObject({ status: 403 });

        const invariantRuntime = new FakeRuntimeStateRepository();
        const invariantRepository = new GroupTopologyConfigRepository(invariantRuntime);
        await invariantRepository.commitConfig({
            ...topologyConfig(group.group, 1, 'tree', 'degree-winner'),
            config: {
                ...effectiveTopologyConfig('tree'),
                degreeLimit: 2,
            },
        }, null);
        await invariantRepository.commitOverride({
            ...topologyConfig(group.group, 1, 'tree', 'degree-override'),
            config: {
                ...effectiveTopologyConfig('tree'),
            },
            expiresAtEpochMs: Date.now() + 60_000,
        }, null);
        const invariantService = createService({
            runtimeRepository: invariantRuntime,
            group,
            configRepository: invariantRepository,
        });
        await invariantService.readConfig(group.group);
        returnFirstEntryAs(
            invariantRuntime,
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            invariantRepository.configKey(group.group),
            undefined,
        );
        await expect(invariantService.putConfig({
            groupRef: group.group,
            config: { meshParamK: 3 },
            updatedByPrincipalId: 'owner',
            requestId: 'fresh-config-invariants',
        })).rejects.toMatchObject({
            code: 'group-topology-config-validation-failed',
        });
    });

    it('applies active and unexpired lifecycle policy to platform admins', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const base = createGroupSnapshot(createGroupRef('workspace-1'));
        const group: GroupSnapshot = {
            ...base,
            group: { ...base.group, expiresAtEpochMs: 1_500 },
        };
        const service = createService({
            runtimeRepository,
            group,
            now: () => 2_000,
            adminPrincipalIds: new Set(['platform-admin']),
        });

        await expect(service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'platform-admin',
            requestId: 'expired-admin-group',
        })).rejects.toMatchObject({
            status: 403,
            denial: { code: 'group-not-active' },
        });
        await expect(service.readConfig(group.group)).resolves.toMatchObject({
            durable: null,
        });
    });

    it('rechecks lifecycle time on every non-replay conflict attempt', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const base = createGroupSnapshot(createGroupRef('workspace-1'));
        const group: GroupSnapshot = {
            ...base,
            group: { ...base.group, expiresAtEpochMs: 1_500 },
        };
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const seeded = topologyConfig(group.group, 1, 'tree', 'policy-time-seed');
        await configRepository.commitConfig(seeded, null);
        const now = vi.fn()
            .mockReturnValueOnce(1_000)
            .mockReturnValue(2_000);
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            now,
            sleep: () => Promise.resolve(),
        });
        await service.readConfig(group.group);
        forceFirstTargetGenerationConflict(
            runtimeRepository,
            configRepository.generationKey(group.group, 'config'),
        );

        await expect(service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'mesh' },
            updatedByPrincipalId: 'owner',
            requestId: 'policy-time-retry',
        })).rejects.toMatchObject({
            status: 403,
            denial: { code: 'group-not-active' },
        });
        expect(now).toHaveBeenCalledTimes(2);
        await expect(configRepository.findConfig(group.group)).resolves.toEqual(
            seeded,
        );
    });

    it('keeps write time and relative override expiry stable across conflict retries', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(500);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const base = createGroupSnapshot(createGroupRef('workspace-1'));
            const group: GroupSnapshot = {
                ...base,
                group: { ...base.group, expiresAtEpochMs: 10_000 },
            };
            const configRepository = new GroupTopologyConfigRepository(
                runtimeRepository,
            );
            await configRepository.commitOverride({
                ...topologyConfig(group.group, 1, 'tree', 'stable-time-seed'),
                createdAtEpochMs: 500,
                updatedAtEpochMs: 500,
                expiresAtEpochMs: 50_000,
            }, null);
            const now = vi.fn()
                .mockReturnValueOnce(1_000)
                .mockReturnValue(2_000);
            const service = createService({
                runtimeRepository,
                group,
                configRepository,
                now,
                sleep: () => Promise.resolve(),
            });
            await service.readConfig(group.group);
            forceFirstTargetGenerationConflict(
                runtimeRepository,
                configRepository.generationKey(group.group, 'override'),
            );

            const accepted = await service.putOverride({
                groupRef: group.group,
                config: { topologyKind: 'mesh' },
                ttlMs: 5_000,
                updatedByPrincipalId: 'owner',
                requestId: 'stable-time-retry',
            });

            expect(now).toHaveBeenCalledTimes(3);
            expect(accepted.override).toMatchObject({
                version: 2,
                createdAtEpochMs: 500,
                updatedAtEpochMs: 1_000,
                expiresAtEpochMs: 6_000,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects a stable relative override expiry that elapses before retry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(500);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const base = createGroupSnapshot(createGroupRef('workspace-1'));
            const group: GroupSnapshot = {
                ...base,
                group: { ...base.group, expiresAtEpochMs: 10_000 },
            };
            const configRepository = new GroupTopologyConfigRepository(
                runtimeRepository,
            );
            const seeded = {
                ...topologyConfig(group.group, 1, 'tree', 'elapsed-ttl-seed'),
                createdAtEpochMs: 500,
                updatedAtEpochMs: 500,
                expiresAtEpochMs: 50_000,
            };
            await configRepository.commitOverride(seeded, null);
            const now = vi.fn()
                .mockReturnValueOnce(1_000)
                .mockReturnValue(7_000);
            const service = createService({
                runtimeRepository,
                group,
                configRepository,
                now,
                sleep: () => Promise.resolve(),
            });
            await service.readConfig(group.group);
            forceFirstTargetGenerationConflict(
                runtimeRepository,
                configRepository.generationKey(group.group, 'override'),
            );

            await expect(service.putOverride({
                groupRef: group.group,
                config: { topologyKind: 'mesh' },
                ttlMs: 5_000,
                updatedByPrincipalId: 'owner',
                requestId: 'elapsed-stable-ttl-retry',
            })).rejects.toMatchObject({
                code: 'group-topology-config-validation-failed',
                issues: [expect.objectContaining({
                    code: 'override-expiry-not-in-future',
                })],
            });
            expect(now).toHaveBeenCalledTimes(2);
            await expect(configRepository.findOverride(group.group)).resolves
                .toEqual(seeded);
            await expect(configRepository.findMutationRecord(
                group.group,
                'elapsed-stable-ttl-retry',
            )).resolves.toBeUndefined();
            await expect(
                new StateMutationOutboxRepository(runtimeRepository)
                    .listPendingPage({ limit: 10 }),
            ).resolves.toMatchObject({ records: [] });
        } finally {
            vi.useRealTimers();
        }
    });

    it('makes identical request races first-writer-wins and rejects different command reuse', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const first = createService({ runtimeRepository, group, configRepository });
        const second = createService({ runtimeRepository, group, configRepository });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'same-request',
        };

        const identical = await Promise.all([
            first.putConfig(request),
            second.putConfig({ ...request, config: { topologyKind: 'tree' } }),
        ]);
        expect(identical[0].receipt).toEqual(identical[1].receipt);
        expect(identical[0].config).toEqual(identical[1].config);

        await expect(second.putConfig({
            ...request,
            config: { topologyKind: 'mesh' },
        })).rejects.toBeInstanceOf(GroupTopologyConfigIdempotencyConflictError);
        expect((await configRepository.findConfig(group.group))?.config)
            .toMatchObject({ topologyKind: 'tree' });
    });

    it('replays from the ledger after materializing stable command and current policy time facts', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const now = vi.fn(() => 1_000);
        const service = createService({ runtimeRepository, group, now });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'clock-free-idempotency',
        };
        const accepted = await service.putConfig(request);
        now.mockClear();
        now.mockReturnValue(2_000);

        expect(await service.putConfig(request)).toEqual(accepted);
        await expect(service.putConfig({
            ...request,
            config: { topologyKind: 'mesh' },
        })).rejects.toBeInstanceOf(GroupTopologyConfigIdempotencyConflictError);
        expect(now).toHaveBeenCalledTimes(4);
    });

    it('replays the immutable accepted PUT result after later overwrite and delete', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const service = createService({ runtimeRepository, group });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'immutable-put-result',
        };
        const accepted = await service.putConfig(request);
        await service.putConfig({
            ...request,
            config: { topologyKind: 'mesh' },
            requestId: 'later-overwrite',
        });

        expect(await service.putConfig(request)).toEqual(accepted);

        await service.deleteConfig({
            groupRef: group.group,
            updatedByPrincipalId: 'owner',
            requestId: 'later-delete',
        });
        expect(await service.putConfig(request)).toEqual(accepted);
    });

    it('replays an exact sparse durable patch over nondefault accepted authority', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const service = createService({
            runtimeRepository,
            group,
            serverDefaults: {
                topologyKind: 'star',
                degreeLimit: 9,
                treeMinSize: 4,
                meshMinSize: 12,
                meshParamK: 3,
            },
        });
        await service.putConfig({
            groupRef: group.group,
            config: {
                topologyKind: 'mesh',
                degreeLimit: 8,
                treeMinSize: 6,
                meshMinSize: 18,
                meshParamK: 4,
            },
            updatedByPrincipalId: 'owner',
            requestId: 'durable-base',
        });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'durable-sparse-replay',
        };

        const accepted = await service.putConfig(request);
        const replayed = await service.putConfig(request);

        expect(accepted.config.config).toEqual({
            topologyKind: 'tree',
            degreeLimit: 8,
            treeMinSize: 6,
            meshMinSize: 18,
            meshParamK: 4,
        });
        expect(replayed).toEqual(accepted);
    });

    it('replays an exact sparse override over durable authority and custom defaults', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const service = createService({
            runtimeRepository,
            group,
            now: () => 1_000,
            serverDefaults: {
                topologyKind: 'star',
                degreeLimit: 9,
                treeMinSize: 4,
                meshMinSize: 12,
                meshParamK: 3,
            },
        });
        await service.putConfig({
            groupRef: group.group,
            config: { degreeLimit: 8, meshParamK: 4 },
            updatedByPrincipalId: 'owner',
            requestId: 'override-durable-base',
        });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            expiresAtEpochMs: 60_000,
            updatedByPrincipalId: 'owner',
            requestId: 'override-sparse-replay',
        };

        const accepted = await service.putOverride(request);
        const replayed = await service.putOverride(request);

        expect(accepted.override.config).toEqual({
            topologyKind: 'tree',
            degreeLimit: 8,
            treeMinSize: 4,
            meshMinSize: 12,
            meshParamK: 4,
        });
        expect(replayed).toEqual(accepted);
    });

    it('persists only command identity and a compact reconstructable receipt', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({ runtimeRepository, group, configRepository });

        const accepted = await service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'owner',
            requestId: 'compact-config-ledger',
        });
        const entry = await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            configRepository.mutationKey(group.group, 'compact-config-ledger'),
        );
        const record = JSON.parse(entry!.value) as Record<string, unknown>;

        expect(Object.keys(record).sort()).toEqual([
            'commandHash',
            'groupRef',
            'receipt',
            'requestId',
        ]);
        expect(record).not.toHaveProperty('result');
        expect(accepted.receipt).toMatchObject({
            acceptedCreatedAtEpochMs: accepted.config.createdAtEpochMs,
            acceptedUpdatedAtEpochMs: accepted.config.updatedAtEpochMs,
            acceptedExpiresAtEpochMs: null,
        });
    });

    it('rejects a compact replay receipt whose operation differs from the verified command', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({ runtimeRepository, group, configRepository });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'mismatched-replay-operation',
        };
        const accepted = await service.putConfig(request);
        const key = configRepository.mutationKey(group.group, request.requestId);
        const entry = await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key,
        );
        const record = JSON.parse(entry!.value) as Record<string, unknown>;
        await runtimeRepository.upsert(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key,
            JSON.stringify({
                ...record,
                receipt: {
                    ...accepted.receipt,
                    operation: 'putOverride',
                    target: 'override',
                    acceptedExpiresAtEpochMs:
                        accepted.receipt.acceptedUpdatedAtEpochMs! + 1,
                },
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(service.putConfig(request)).rejects.toThrow(
            'Topology config receipt operation differs from command',
        );
    });

    it('rejects a compact replay receipt whose requestId differs from its record', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({ runtimeRepository, group, configRepository });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'mismatched-replay-request',
        };
        const accepted = await service.putConfig(request);
        const key = configRepository.mutationKey(group.group, request.requestId);
        const entry = await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key,
        );
        if (!entry) {
            throw new Error('Expected the compact topology mutation receipt to exist.');
        }
        const record = JSON.parse(entry.value) as Record<string, unknown>;
        await runtimeRepository.upsert(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key,
            JSON.stringify({
                ...record,
                receipt: {
                    ...accepted.receipt,
                    requestId: 'other-request',
                },
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(service.putConfig(request)).rejects.toBeInstanceOf(
            GroupTopologyConfigRepositoryInvariantCorruptionError,
        );
    });

    it('rejects an attacker-selected compact receipt outboxId at the repository boundary', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({ runtimeRepository, group, configRepository });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'tampered-repository-outbox-id',
        };
        const accepted = await service.putConfig(request);
        const key = configRepository.mutationKey(group.group, request.requestId);
        const entry = await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key,
        );
        const record = JSON.parse(entry!.value) as Record<string, unknown>;
        await runtimeRepository.upsert(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key,
            JSON.stringify({
                ...record,
                receipt: {
                    ...accepted.receipt,
                    outboxId: 'state-mutation-attacker-selected',
                },
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(configRepository.findMutationRecord(
            group.group,
            request.requestId,
        )).rejects.toBeInstanceOf(
            GroupTopologyConfigRepositoryInvariantCorruptionError,
        );
    });

    it('rejects an attacker-selected compact receipt outboxId at service replay', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({ runtimeRepository, group, configRepository });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'tampered-service-outbox-id',
        };
        const accepted = await service.putConfig(request);
        const key = configRepository.mutationKey(group.group, request.requestId);
        const entry = await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key,
        );
        const record = JSON.parse(entry!.value) as Record<string, unknown>;
        await runtimeRepository.upsert(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key,
            JSON.stringify({
                ...record,
                receipt: {
                    ...accepted.receipt,
                    outboxId: 'state-mutation-attacker-selected',
                },
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(service.putConfig(request)).rejects.toBeInstanceOf(
            GroupTopologyConfigRepositoryInvariantCorruptionError,
        );
    });

    it.each(['putConfig', 'putOverride'] as const)(
        'rejects an impossible persisted %s no-op instead of reconstructing replay state',
        async (operation) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const group = createGroupSnapshot(createGroupRef('workspace-1'));
            const configRepository = new GroupTopologyConfigRepository(
                runtimeRepository,
            );
            const now = vi.fn(() => 1_000);
            const service = createService({
                runtimeRepository,
                group,
                configRepository,
                now,
            });
            const requestId = `impossible-replay-${operation}`;
            const replay = operation === 'putConfig'
                ? () => service.putConfig({
                    groupRef: group.group,
                    config: { topologyKind: 'tree' },
                    updatedByPrincipalId: 'owner',
                    requestId,
                })
                : () => service.putOverride({
                    groupRef: group.group,
                    config: { topologyKind: 'tree' },
                    expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP - 1,
                    updatedByPrincipalId: 'owner',
                    requestId,
                });
            const accepted = await replay();
            const key = configRepository.mutationKey(group.group, requestId);
            const entry = await runtimeRepository.findEntry(
                GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                key,
            );
            const record = JSON.parse(entry!.value) as Record<string, unknown>;
            await runtimeRepository.upsert(
                GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                key,
                JSON.stringify({
                    ...record,
                    receipt: {
                        ...accepted.receipt,
                        outcome: 'no-op',
                        acceptedStorageRevision: null,
                        outboxId: null,
                    },
                }),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            now.mockClear();
            now.mockReturnValue(2_000);

            await expect(replay()).rejects.toThrow(
                'Topology config PUT receipt must be applied',
            );
            expect(now).toHaveBeenCalledOnce();
        },
    );

    it('reconstructs an immutable override replay from its compact receipt', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const service = createService({ runtimeRepository, group });
        const request = {
            groupRef: group.group,
            config: { degreeLimit: 4 },
            expiresAtEpochMs: Date.now() + 60_000,
            updatedByPrincipalId: 'owner',
            requestId: 'compact-override-replay',
        };
        const accepted = await service.putOverride(request);
        await service.putOverride({
            ...request,
            config: { degreeLimit: 5 },
            requestId: 'compact-override-overwrite',
        });
        await service.deleteOverride({
            groupRef: group.group,
            updatedByPrincipalId: 'owner',
            requestId: 'compact-override-delete',
        });

        expect(await service.putOverride(request)).toEqual(accepted);
        expect(accepted.receipt).toMatchObject({
            acceptedCreatedAtEpochMs: accepted.override.createdAtEpochMs,
            acceptedUpdatedAtEpochMs: accepted.override.updatedAtEpochMs,
            acceptedExpiresAtEpochMs: accepted.override.expiresAtEpochMs,
        });
    });

    it('revalidates lifecycle and actor authority before replaying a winner', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const service = createService({
            runtimeRepository,
            group,
        });
        const request = {
            groupRef: group.group,
            config: { topologyKind: 'tree' as const },
            updatedByPrincipalId: 'owner',
            requestId: 'replay-authority',
        };
        await service.putConfig(request);

        await persistGroupAuthorityMutation(runtimeRepository, {
            ...group,
            group: {
                ...group.group,
                status: 'archived',
                deleted: null,
                snapshotVersion: group.group.snapshotVersion + 1,
                updated: audit(2),
                archived: audit(2),
            },
        });
        await expect(service.putConfig(request)).rejects.toMatchObject({ status: 403 });

        await persistGroupAuthorityMutation(runtimeRepository, {
            ...group,
            group: {
                ...group.group,
                ownerPrincipalId: 'session-b',
                snapshotVersion: group.group.snapshotVersion + 2,
                rosterVersion: group.group.rosterVersion + 1,
                updated: audit(3),
            },
            members: group.members.map((member) =>
                member.principalId === 'owner'
                    ? {
                        ...member,
                        role: 'member' as const,
                        updated: audit(3),
                    }
                    : member.principalId === 'session-b'
                    ? {
                        ...member,
                        role: 'owner' as const,
                        updated: audit(3),
                    }
                    : member
            ),
        });
        await expect(service.putConfig(request)).rejects.toMatchObject({ status: 403 });
    });

    it('fails closed when the authoritative group-state repository is missing at runtime', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const ordinaryReader = vi.fn(() => group);
        const service = new GroupTopologyManagementService({
            findGroupSnapshotByRef: ordinaryReader,
            configRepository: new GroupTopologyConfigRepository(runtimeRepository),
            topologyService: new RallarRtcTopologyService(),
        } as ConstructorParameters<typeof GroupTopologyManagementService>[0]);

        await expect(service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'owner',
            requestId: 'missing-authoritative-repository',
        })).rejects.toBeInstanceOf(TypeError);
        expect(ordinaryReader).not.toHaveBeenCalled();
    });

    it('records an absent delete winner and rejects later request-id reuse with different semantics', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const service = createService({ runtimeRepository, group, configRepository });

        const deleted = await service.deleteConfig({
            groupRef: group.group,
            updatedByPrincipalId: 'owner',
            requestId: 'absent-delete',
        });
        expect(deleted).toMatchObject({
            deleted: false,
            receipt: { outcome: 'no-op', outboxId: null },
        });
        expect(await configRepository.findMutationRecord(
            group.group,
            'absent-delete',
        )).toMatchObject({ receipt: deleted.receipt });

        await expect(service.putConfig({
            groupRef: group.group,
            config: { topologyKind: 'tree' },
            updatedByPrincipalId: 'owner',
            requestId: 'absent-delete',
        })).rejects.toBeInstanceOf(GroupTopologyConfigIdempotencyConflictError);
        expect(await configRepository.findConfig(group.group)).toBeUndefined();
    });

                it('plans topology from an explicit predecessor without persisting under the graph computation', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const previous = createTopologySnapshot(group.group, {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        });
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        await seedTopologySnapshot(snapshots, previous);
        const topologyService = new RallarRtcTopologyService();
        const service = createService({ runtimeRepository, group, topologyService });

        const result = await service.planGroupTopology(group, previous);

        expect(result.previous).toBe(previous);
        expect(result.snapshot.sourceGroupStateCausalRevision)
            .toEqual(group.causalRevision);
        expect(await snapshots.findSnapshot(group.group)).toEqual(previous);
        expect(topologyService.readSnapshot(group)).toBeUndefined();
    });

    it('plans twice from frozen read facts without accessing the clock during compute', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        let clockReads = 0;
        const topologyService = new RallarRtcTopologyService({
            now: () => {
                clockReads += 1;
                if (clockReads > 1) throw new Error('clock accessed during compute');
                return 123;
            },
        });
        const service = createService({ runtimeRepository, group, topologyService });
        const authority = freezeDeep(await service.readTopologyPlanningAuthority(
            group.group,
        ));

        const first = service.planTopologyFromAuthority(authority, undefined);
        const second = service.planTopologyFromAuthority(authority, undefined);

        expect(second).toEqual(first);
        expect(clockReads).toBe(1);
    });

    it('uses the immutable group update time for a planned removal tombstone', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const active = createGroupSnapshot(createGroupRef('workspace-1'));
        const group: GroupSnapshot = {
            ...active,
            stateRevision: 2,
            causalRevision: { groupRevision: 2, presenceRevision: 0 },
            group: {
                ...active.group,
                status: 'deleted',
                archived: null,
                deleted: audit(123),
                updated: audit(123),
            },
        };
        const service = createService({
            runtimeRepository,
            group,
            now: () => 999,
        });

        const result = await service.planGroupTopology(group, undefined);

        expect(result.snapshot).toMatchObject({
            state: 'removed',
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 0,
            },
            updatedAtEpochMs: 123,
        });
        expect(
            await new RtcTopologySnapshotRepository(runtimeRepository)
                .findSnapshot(group.group),
        ).toBeUndefined();
    });

    it('reads topology views by full group ref without requiring an existing snapshot', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const service = createService({
            runtimeRepository,
            group,
        });

        const view = await service.readTopologyView(group.group);

        expect(view.groupRef).toEqual(group.group);
        expect(view.overlayId).toBe(JSON.stringify(['app-1', 'workspace-1', 'room-1']));
        expect(view.snapshot).toBeNull();
        expect(view.config.effective).toEqual({
            topologyKind: 'auto',
            degreeLimit: 5,
            treeMinSize: 5,
            meshMinSize: 16,
            meshParamK: 2,
        });
    });

    it('resolves effective config and durable RTTs during pure topology computation', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const rttRepository = new RtcRttRepository(runtimeRepository);
        await configRepository.commitConfig({
            groupRef: group.group,
            config: {
                ...effectiveTopologyConfig('tree'),
                degreeLimit: 4,
            },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
            requestId: null,
        }, null);
        await rttRepository.putMeasurementIfNewer({
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 7,
            createdAtEpochMs: 1,
            version: 1,
        }, Date.now() + 60_000);
        vi.spyOn(runtimeRepository, 'lockKey').mockRejectedValue(
            new Error('topology locks are forbidden'),
        );
        const topologyService = new RallarRtcTopologyService({
            now: () => 2_000,
        });
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopologyAt');
        const publisher = vi.fn();
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            rttRepository,
            topologyService,
            publisher,
            serverDefaults: {
                degreeLimit: 5,
                treeMinSize: 5,
                meshMinSize: 16,
                meshParamK: 2,
            },
        });

        const authority = await service.readTopologyPlanningAuthority(
            group.group,
            { degreeLimit: 3 },
            group,
        );
        const measurement = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 7,
            createdAtEpochMs: 1,
            version: 1,
        };
        const computationAuthority = {
            ...authority,
            group,
            rttMeasurements: [measurement],
        };
        const result = service.computeTopologyFromAuthority(
            computationAuthority,
            undefined,
        );

        expect(result.changed).toBe(true);
        expect(authority.config.effective).toEqual({
            topologyKind: 'tree',
            degreeLimit: 3,
            treeMinSize: 5,
            meshMinSize: 16,
            meshParamK: 2,
        });
        expect(planGroupTopology).toHaveBeenCalledWith(
            group,
            [measurement],
            expect.objectContaining({
                previous: undefined,
                topologyOptions: authority.config.effective,
            }),
            2_000,
        );
        expect(await new RtcTopologySnapshotRepository(runtimeRepository)
            .findSnapshot(group.group)).toBeUndefined();
        expect(runtimeRepository.locks).toEqual([]);
        expect(publisher).not.toHaveBeenCalled();
    });

    it('keeps stale candidate computation side-effect free for mutation comparison', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const current = {
            ...createTopologySnapshot(group.group, {
                'session-a': ['session-b'],
                'session-b': ['session-a'],
            }),
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 0,
            },
        };
        const topologySnapshotRepository = new RtcTopologySnapshotRepository(
            runtimeRepository,
        );
        await seedTopologySnapshot(topologySnapshotRepository, current);
        const publisher = vi.fn();
        const service = createService({
            runtimeRepository,
            group,
            topologySnapshotRepository,
            publisher,
        });

        const authority = await service.readTopologyPlanningAuthority(
            group.group,
            {},
            group,
        );
        const result = service.computeTopologyFromAuthority(
            { ...authority, group },
            current,
        );

        expect(result).toMatchObject({
            changed: true,
            snapshot: {
                sourceGroupStateCausalRevision: {
                    groupRevision: 1,
                    presenceRevision: 0,
                },
            },
            previous: current,
        });
        expect(publisher).not.toHaveBeenCalled();
    });

    it('does not let a stale removal delete a newer active topology', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const base = createGroupSnapshot(createGroupRef('workspace-1'));
        const staleRemoval = {
            ...base,
            group: {
                ...base.group,
                status: 'deleted' as const,
                archived: null,
                deleted: audit(1),
            },
        };
        const currentGroup = { ...base, stateRevision: 2 };
        const current = {
            ...createTopologySnapshot(currentGroup.group, {
                'session-a': ['session-b'],
                'session-b': ['session-a'],
            }),
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 0,
            },
            version: 2,
        };
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        await seedTopologySnapshot(snapshots, current);
        const service = createService({ runtimeRepository, group: currentGroup });

        await service.removeGroupTopology(staleRemoval);

        expect(await snapshots.findSnapshot(currentGroup.group)).toEqual(current);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('computes a removal for newer expired active authority', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const base = createGroupSnapshot(createGroupRef('workspace-expired-removal'));
        const expired: GroupSnapshot = {
            ...base,
            stateRevision: 2,
            causalRevision: { ...base.causalRevision, groupRevision: 2 },
            group: {
                ...base.group,
                snapshotVersion: 2,
                expiresAtEpochMs: 100,
                updated: audit(2),
            },
        };
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        const previous = createTopologySnapshot(base.group, {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        });
        await seedTopologySnapshot(snapshots, previous);
        const service = createService({ runtimeRepository, group: expired });

        const authority = await service.readTopologyPlanningAuthority(
            expired.group,
            {},
            expired,
        );
        const result = service.computeTopologyFromAuthority(
            { ...authority, group: expired },
            previous,
        );

        expect(result.snapshot).toMatchObject({
            state: 'removed',
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 0,
            },
        });
        expect(await snapshots.findSnapshot(expired.group)).toEqual(previous);
    });

    it('computes removal from the newer terminal group authority', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const base = createGroupSnapshot(createGroupRef('workspace-terminal-removal'));
        const staleRemoval: GroupSnapshot = {
            ...base,
            group: {
                ...base.group,
                status: 'deleted',
                archived: null,
                deleted: audit(2),
                updated: audit(2),
            },
        };
        const currentGroup: GroupSnapshot = {
            ...staleRemoval,
            stateRevision: 2,
            causalRevision: { ...staleRemoval.causalRevision, groupRevision: 2 },
            group: {
                ...staleRemoval.group,
                status: 'deleted',
                archived: null,
                snapshotVersion: 2,
                deleted: audit(3),
                updated: audit(3),
            },
        };
        const current = createTopologySnapshot(base.group, {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        });
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        await seedTopologySnapshot(snapshots, current);
        const service = createService({ runtimeRepository, group: currentGroup });

        const authority = await service.readTopologyPlanningAuthority(
            currentGroup.group,
            {},
            currentGroup,
        );
        const result = service.computeTopologyFromAuthority(
            { ...authority, group: currentGroup },
            current,
        );

        expect(result.snapshot).toMatchObject({
            state: 'removed',
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 0,
            },
        });
        expect(await snapshots.findSnapshot(currentGroup.group)).toEqual(current);
        expect(runtimeRepository.locks).toEqual([]);
    });

            it('filters stored RTTs that are not reporting edges for the recomputed group', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        await seedTopologySnapshot(
            new RtcTopologySnapshotRepository(runtimeRepository),
            createTopologySnapshot(
                group.group,
                {
                    'session-a': ['session-b'],
                    'session-b': ['session-a', 'session-c'],
                    'session-c': ['session-b', 'session-d'],
                    'session-d': ['session-c', 'session-e'],
                    'session-e': ['session-d'],
                },
                2,
            ),
        );
        const rttRepository = new RtcRttRepository(runtimeRepository);
        await rttRepository.putMeasurementIfNewer({
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-c',
            rttMs: 7,
            createdAtEpochMs: 1,
            version: 1,
        }, Date.now() + 60_000);
        const topologyService = new RallarRtcTopologyService({
            now: () => 2_000,
        });
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopologyAt');
        const service = createService({
            runtimeRepository,
            group,
            rttRepository,
            topologyService,
            serverDefaults: {
                degreeLimit: 5,
                rttReportingDegreeLimit: 1,
            },
        });

        await service.reconfigureGroupTopology({
            groupRef: group.group,
            publish: false,
        });

        expect(planGroupTopology).toHaveBeenCalledWith(
            group,
            [],
            expect.objectContaining({
                topologyOptions: expect.objectContaining({
                    degreeLimit: 5,
                }),
            }),
            expect.any(Number),
        );
    });

    it('does not publish when publish is false and reports unchanged snapshots', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const publisher = vi.fn();
        const service = createService({
            runtimeRepository,
            group,
            publisher,
        });

        const first = await service.reconfigureGroupTopology({
            groupRef: group.group,
            publish: false,
        });
        const second = await service.reconfigureGroupTopology({
            groupRef: group.group,
            publish: false,
        });

        expect(first.changed).toBe(true);
        expect(first.published).toBe(false);
        expect(second.changed).toBe(false);
        expect(second.published).toBe(false);
        expect(publisher).not.toHaveBeenCalled();
    });

    it('rejects invalid computed next-hop maps before persisting or publishing', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const invalidSnapshot = createTopologySnapshot(group.group, {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        });
        const invalidWithMissingRoute = {
            ...invalidSnapshot,
            activeSessionIds: [...invalidSnapshot.activeSessionIds, 'session-z'],
        };
        const topologyService = {
            planGroupTopologyAt: vi.fn(() => ({
                snapshot: invalidWithMissingRoute,
                changed: true,
            })),
            planGroupTopology: vi.fn(() => ({
                snapshot: invalidWithMissingRoute,
                changed: true,
            })),
            readSnapshot: vi.fn(),
            recordTopologyPublishResult: vi.fn(),
            readNowEpochMs: vi.fn(() => 1),
        } as unknown as RallarRtcTopologyService;
        const publisher = vi.fn();
        const service = createService({
            runtimeRepository,
            group,
            topologyService,
            publisher,
        });

        const authority = await service.readTopologyPlanningAuthority(
            group.group,
            {},
            group,
        );
        expect(() => service.computeTopologyFromAuthority(
            authority,
            undefined,
        )).toThrow(GroupTopologyValidationError);
        expect(await new RtcTopologySnapshotRepository(runtimeRepository)
            .findSnapshot(group.group)).toBeUndefined();
        expect(publisher).not.toHaveBeenCalled();
    });

    it('commits config and overrides without invoking invalid synchronous topology work', async () => {
        const configRuntimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(
            configRuntimeRepository,
        );
        const configService = createService({
            runtimeRepository: configRuntimeRepository,
            group,
            configRepository,
            topologyService: createInvalidTopologyService(group.group),
        });

        await expect(configService.putConfig({
            groupRef: group.group,
            config: {
                topologyKind: 'star',
            },
            updatedByPrincipalId: 'owner',
            requestId: 'config-invalid-topology',
        })).resolves.toMatchObject({ config: { version: 1 } });
        expect(await configRepository.findConfig(group.group)).toBeDefined();

        const overrideRuntimeRepository = new FakeRuntimeStateRepository();
        const overrideRepository = new GroupTopologyConfigRepository(
            overrideRuntimeRepository,
        );
        const overrideService = createService({
            runtimeRepository: overrideRuntimeRepository,
            group,
            configRepository: overrideRepository,
            topologyService: createInvalidTopologyService(group.group),
        });

        await expect(overrideService.putOverride({
            groupRef: group.group,
            config: {
                topologyKind: 'mesh',
            },
            updatedByPrincipalId: 'owner',
            requestId: 'override-invalid-topology',
        })).resolves.toMatchObject({ override: { version: 1 } });
        expect(await overrideRepository.findOverride(group.group)).toBeDefined();
    });

    it('deletes config and overrides without synchronous compensation', async () => {
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const existingConfig = {
            groupRef: group.group,
            config: {
                ...effectiveTopologyConfig('tree'),
            },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
            requestId: 'existing-config',
        };
        const configRuntimeRepository = new FakeRuntimeStateRepository();
        const configRepository = new GroupTopologyConfigRepository(
            configRuntimeRepository,
        );
        await configRepository.commitConfig(existingConfig, null);
        const configService = createService({
            runtimeRepository: configRuntimeRepository,
            group,
            configRepository,
            topologyService: createInvalidTopologyService(group.group),
        });

        await expect(configService.deleteConfig({
            groupRef: group.group,
            updatedByPrincipalId: 'owner',
        })).resolves.toMatchObject({ deleted: true });
        expect(await configRepository.findConfig(group.group)).toBeUndefined();

        const existingOverride = {
            ...existingConfig,
            config: {
                ...effectiveTopologyConfig('mesh'),
            },
            requestId: 'existing-override',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        const overrideRuntimeRepository = new FakeRuntimeStateRepository();
        const overrideRepository = new GroupTopologyConfigRepository(
            overrideRuntimeRepository,
        );
        await overrideRepository.commitOverride(existingOverride, null);
        const overrideService = createService({
            runtimeRepository: overrideRuntimeRepository,
            group,
            configRepository: overrideRepository,
            topologyService: createInvalidTopologyService(group.group),
        });

        await expect(overrideService.deleteOverride({
            groupRef: group.group,
            updatedByPrincipalId: 'owner',
        })).resolves.toMatchObject({ deleted: true });
        expect(await overrideRepository.findOverride(group.group))
            .toBeUndefined();
    });

    it('passes effective config into due RTT topology flushes', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        await configRepository.commitConfig({
            groupRef: group.group,
            config: {
                ...effectiveTopologyConfig('tree'),
                degreeLimit: 3,
            },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
            requestId: null,
        }, null);
        const topologyService = new RallarRtcTopologyService({
            now: () => 1_000,
        });
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopologyAt');
        topologyService.queueRttTopologyUpdate(group);
        const service = createService({
            runtimeRepository,
            group,
            configRepository,
            topologyService,
        });

        const result = await service.flushDueGroupTopology({
            groupRef: group.group,
            groupSnapshot: group,
            publish: false,
        });

        expect(result?.config.effective).toEqual({
            topologyKind: 'tree',
            degreeLimit: 3,
            treeMinSize: 5,
            meshMinSize: 16,
            meshParamK: 2,
        });
        expect(planGroupTopology).toHaveBeenCalledWith(
            group,
            [],
            expect.objectContaining({
                topologyOptions: result?.config.effective,
            }),
            1_000,
        );
        expect(topologyService.readSnapshot(group)).toEqual(result?.snapshot);
    });

        it('writes and deletes config and overrides without synchronous reconfigure', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const group = createGroupSnapshot(createGroupRef('workspace-1'));
            const topologyService = new RallarRtcTopologyService({
                now: () => 2_000,
            });
            const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopology');
            const service = createService({
                runtimeRepository,
                group,
                topologyService,
                now: () => 1_000,
            });

            await service.putConfig({
                groupRef: group.group,
                config: {
                    topologyKind: 'tree',
                },
                updatedByPrincipalId: 'owner',
                requestId: 'config-1',
            });
            await service.putOverride({
                groupRef: group.group,
                config: {
                    degreeLimit: 4,
                },
                updatedByPrincipalId: 'owner',
                requestId: 'override-1',
            });
            expect(await service.readOverride(group.group)).toMatchObject({
                config: {
                    degreeLimit: 4,
                },
                expiresAtEpochMs: 901_000,
            });
            await service.deleteOverride({
                groupRef: group.group,
                updatedByPrincipalId: 'owner',
            });
            await service.deleteConfig({
                groupRef: group.group,
                updatedByPrincipalId: 'owner',
            });

            expect(planGroupTopology).not.toHaveBeenCalled();
            expect(await service.readOverride(group.group)).toBeUndefined();
            expect((await service.readConfig(group.group)).durable).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

async function _runTopologyEquivalenceSequence(
    service: GroupTopologyManagementService,
    groupRef: GroupRef,
    nowEpochMs: number,
): Promise<readonly unknown[]> {
    const insertedConfig = await service.putConfig({
        groupRef,
        config: { topologyKind: 'tree' },
        updatedByPrincipalId: 'owner',
        requestId: 'equivalent-config-insert',
    });
    const updatedConfig = await service.putConfig({
        groupRef,
        config: { topologyKind: 'mesh' },
        updatedByPrincipalId: 'owner',
        requestId: 'equivalent-config-update',
    });
    const insertedOverride = await service.putOverride({
        groupRef,
        config: { degreeLimit: 3 },
        expiresAtEpochMs: nowEpochMs + 60_000,
        updatedByPrincipalId: 'owner',
        requestId: 'equivalent-override-insert',
    });
    const updatedOverride = await service.putOverride({
        groupRef,
        config: { degreeLimit: 4 },
        expiresAtEpochMs: nowEpochMs + 120_000,
        updatedByPrincipalId: 'owner',
        requestId: 'equivalent-override-update',
    });
    const deletedOverride = await service.deleteOverride({
        groupRef,
        updatedByPrincipalId: 'owner',
        requestId: 'equivalent-override-delete',
    });
    const deletedConfig = await service.deleteConfig({
        groupRef,
        updatedByPrincipalId: 'owner',
        requestId: 'equivalent-config-delete',
    });
    const claimRequest = {
        groupRef,
        updatedByPrincipalId: 'owner',
        requestId: 'equivalent-absent-delete',
    } as const;
    const claimed = await service.deleteConfig(claimRequest);
    const replayed = await service.deleteConfig(claimRequest);
    return [
        insertedConfig,
        updatedConfig,
        insertedOverride,
        updatedOverride,
        deletedOverride,
        deletedConfig,
        claimed,
        replayed,
    ];
}

function _logicalRuntimeStateRows(
    repository: FakeRuntimeStateRepository,
): readonly Readonly<{
    identity: string;
    key: string;
    value: string;
    expireAtTimestamp: number;
    revision: number;
}>[] {
    return [...repository.data.entries()]
        .map(([identity, entry]) => ({
            identity,
            key: entry.key,
            value: entry.value,
            expireAtTimestamp: entry.expireAtTimestamp,
            revision: entry.revision,
        }))
        .sort((left, right) => left.identity.localeCompare(right.identity));
}

type ExactTopologyWriteBatchInput = Readonly<{
    group: GroupSnapshot;
    repository: GroupTopologyConfigRepository;
    authorityExpectedRevision: number;
    target: RuntimeStateGuardedBatchEffect;
    invariantExpectedRevision: number | null;
    invariantVersion: number;
    generationExpectedRevision: number | null;
    generationTarget: 'config' | 'override';
    generationVersion: number;
    receipt: GroupTopologyConfigMutationReceipt;
    requestId: string;
    createdAtEpochMs: number;
}>;

function exactTopologyAuthorityGuard(
    group: GroupSnapshot,
    expectedRevision: number,
): RuntimeStateGuardedBatchGuard {
    return {
        operation: 'update',
        namespace: 'group-state:groups',
        key: groupStateGroupStorageKey(group.group),
        expectedRevision,
        value: JSON.stringify(group.group),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
    };
}

function _expectExactTopologyWriteBatch(
    batch: RuntimeStateGuardedBatch,
    input: ExactTopologyWriteBatchInput,
): void {
    if (input.receipt.outboxId === null) {
        throw new Error('Expected topology write receipt to own an outbox ID.');
    }
    if (input.receipt.acceptedCausalRevision === null) {
        throw new Error('Expected topology write receipt to carry a causal revision.');
    }
    const groupRef = copyTestGroupRef(input.group.group);
    const invariantGeneration: RuntimeStateGuardedBatchEffect =
        input.invariantExpectedRevision === null
            ? {
                effectId: 'invariant-generation',
                operation: 'insert',
                namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                key: input.repository.invariantGenerationKey(input.group.group),
                value: JSON.stringify({
                    groupRef,
                    version: input.invariantVersion,
                }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            }
            : {
                effectId: 'invariant-generation',
                operation: 'update',
                namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                key: input.repository.invariantGenerationKey(input.group.group),
                expectedRevision: input.invariantExpectedRevision,
                value: JSON.stringify({
                    groupRef,
                    version: input.invariantVersion,
                }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            };
    const generation: RuntimeStateGuardedBatchEffect =
        input.generationExpectedRevision === null
            ? {
                effectId: 'target-generation',
                operation: 'insert',
                namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                key: input.repository.generationKey(
                    input.group.group,
                    input.generationTarget,
                ),
                value: JSON.stringify({
                    groupRef,
                    target: input.generationTarget,
                    version: input.generationVersion,
                }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            }
            : {
                effectId: 'target-generation',
                operation: 'update',
                namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                key: input.repository.generationKey(
                    input.group.group,
                    input.generationTarget,
                ),
                expectedRevision: input.generationExpectedRevision,
                value: JSON.stringify({
                    groupRef,
                    target: input.generationTarget,
                    version: input.generationVersion,
                }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            };
    const receiptRecord = {
        groupRef,
        requestId: input.requestId,
        commandHash: input.receipt.commandHash,
        receipt: input.receipt,
    };
    const outbox = createStateMutationOutboxRecord({
        kind: 'group',
        aggregateRef: groupRef,
        commandId: input.requestId,
        commandHash: input.receipt.commandHash,
        createdAtEpochMs: input.createdAtEpochMs,
        acceptedCausalRevision: {
            kind: 'group',
            ...input.receipt.acceptedCausalRevision,
        },
        effects: ['rtc-topology-recompute'],
        event: { kind: 'none' },
    });

    expect(batch).toEqual({
        guard: exactTopologyAuthorityGuard(
            input.group,
            input.authorityExpectedRevision,
        ),
        effects: [
            input.target,
            invariantGeneration,
            generation,
            {
                effectId: 'receipt',
                operation: 'insert',
                namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                key: input.repository.mutationKey(
                    input.group.group,
                    input.requestId,
                ),
                value: JSON.stringify(receiptRecord),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            },
            {
                effectId: 'outbox',
                operation: 'insert',
                namespace: STATE_MUTATION_OUTBOX_NAMESPACE,
                key: `intent:${input.receipt.outboxId}`,
                value: JSON.stringify(outbox),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            },
        ],
    });
}

function copyTestGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
    };
}

class _GuardedBatchFakeRuntimeStateRepository extends FakeRuntimeStateRepository {
    readonly batches: RuntimeStateGuardedBatch[] = [];
    beginCount = 0;
    private transactionDepth = 0;
    private readonly forcedConflicts: string[] = [];

    get activeTransactionDepth(): number {
        return this.transactionDepth;
    }

    forceNextConflict(target: 'guard' | string): void {
        this.forcedConflicts.push(target);
    }

    get runtimeStateGuardedBatchCapability(): boolean {
        return this.transactionDepth > 0;
    }

    override async begin<T>(
        fn: (
            repository: RuntimeStateOptimisticTransactionalRepositoryLike,
        ) => Promise<T>,
    ): Promise<T> {
        this.beginCount += 1;
        return await super.begin(async () => {
            this.transactionDepth += 1;
            try {
                return await fn(this);
            } finally {
                this.transactionDepth -= 1;
            }
        });
    }

    async executeGuardedBatch(
        input: RuntimeStateGuardedBatch,
    ): Promise<RuntimeStateGuardedBatchResult> {
        if (!this.runtimeStateGuardedBatchCapability) {
            throw new Error('Guarded batch fake requires an active transaction.');
        }
        const batch = validateRuntimeStateGuardedBatch(input);
        this.batches.push(batch);
        const guard = this.consumeForcedConflict('guard')
            ? guardedBatchGuardConflict(batch.guard)
            : await applyGuardedBatchGuard(this, batch.guard);
        if (guard.status === 'conflict') {
            return validateRuntimeStateGuardedBatchResult(batch, {
                guard,
                effects: batch.effects.map((effect) => ({
                    status: 'skipped',
                    effectId: effect.effectId,
                    operation: effect.operation,
                    namespace: effect.namespace,
                    key: effect.key,
                    reason: 'guard-conflict',
                })),
            });
        }
        const effects: RuntimeStateGuardedBatchEffectResult[] = [];
        for (const effect of batch.effects) {
            effects.push(this.consumeForcedConflict(effect.effectId)
                ? guardedBatchEffectConflict(effect)
                : await applyGuardedBatchEffect(this, effect));
        }
        return validateRuntimeStateGuardedBatchResult(batch, { guard, effects });
    }

    private consumeForcedConflict(target: string): boolean {
        const index = this.forcedConflicts.indexOf(target);
        if (index < 0) return false;
        this.forcedConflicts.splice(index, 1);
        return true;
    }
}

function guardedBatchGuardConflict(
    guard: RuntimeStateGuardedBatchGuard,
): RuntimeStateGuardedBatchGuardResult {
    return {
        status: 'conflict',
        operation: guard.operation,
        namespace: guard.namespace,
        key: guard.key,
        reason: 'condition-not-met',
    };
}

function guardedBatchEffectConflict(
    effect: RuntimeStateGuardedBatchEffect,
): RuntimeStateGuardedBatchEffectResult {
    if (effect.operation === 'put') {
        throw new Error('Guarded batch put effects cannot be forced to conflict.');
    }
    return {
        status: 'conflict',
        effectId: effect.effectId,
        operation: effect.operation,
        namespace: effect.namespace,
        key: effect.key,
        reason: 'condition-not-met',
    };
}

async function applyGuardedBatchGuard(
    repository: FakeRuntimeStateRepository,
    guard: RuntimeStateGuardedBatchGuard,
): Promise<RuntimeStateGuardedBatchGuardResult> {
    const result = guard.operation === 'insert'
        ? await repository.insertIfAbsent(
            guard.namespace,
            guard.key,
            guard.value,
            guard.expireAtTimestamp,
        )
        : guard.operation === 'update'
        ? await repository.upsertIfRevision(
            guard.namespace,
            guard.key,
            guard.value,
            guard.expireAtTimestamp,
            guard.expectedRevision,
        )
        : await repository.deleteIfRevision(
            guard.namespace,
            guard.key,
            guard.expectedRevision,
        );
    if (result.status === 'conflict') {
        return {
            status: 'conflict',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            reason: 'condition-not-met',
        };
    }
    return guard.operation === 'delete'
        ? {
            status: 'applied',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            matchedRevision: guard.expectedRevision,
        }
        : {
            status: 'applied',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            resultingRevision: result.revision,
        };
}

async function applyGuardedBatchEffect(
    repository: FakeRuntimeStateRepository,
    effect: RuntimeStateGuardedBatchEffect,
): Promise<RuntimeStateGuardedBatchEffectResult> {
    if (effect.operation === 'put') {
        await repository.upsert(
            effect.namespace,
            effect.key,
            effect.value,
            effect.expireAtTimestamp,
        );
        const stored = await repository.findEntry(effect.namespace, effect.key);
        if (!stored) throw new Error('Guarded batch fake put result is missing.');
        return {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            resultingRevision: stored.revision,
        };
    }
    const result = effect.operation === 'insert'
        ? await repository.insertIfAbsent(
            effect.namespace,
            effect.key,
            effect.value,
            effect.expireAtTimestamp,
        )
        : effect.operation === 'update'
        ? await repository.upsertIfRevision(
            effect.namespace,
            effect.key,
            effect.value,
            effect.expireAtTimestamp,
            effect.expectedRevision,
        )
        : await repository.deleteIfRevision(
            effect.namespace,
            effect.key,
            effect.expectedRevision,
        );
    if (result.status === 'conflict') {
        return {
            status: 'conflict',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            reason: 'condition-not-met',
        };
    }
    return effect.operation === 'delete'
        ? {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            matchedRevision: effect.expectedRevision,
        }
        : {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            resultingRevision: result.revision,
        };
}

function createService(options: {
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly group: GroupSnapshot;
    readonly additionalGroups?: readonly GroupSnapshot[];
    readonly readGroup?: () => GroupSnapshot;
    readonly authoritativeReadGroup?: () => GroupSnapshot;
    readonly configRepository?: GroupTopologyConfigRepository;
    readonly rttRepository?: RtcRttRepository;
    readonly topologyService?: RallarRtcTopologyService;
    readonly topologySnapshotRepository?: RtcTopologySnapshotRepository;
    readonly publisher?: (message: unknown) => void;
    readonly serverDefaults?: ConstructorParameters<typeof GroupTopologyManagementService>[0]['serverDefaults'];
    readonly now?: () => number;
    readonly sleep?: (delayMs: number) => Promise<void>;
    readonly timing?: (event: RallarTimingEvent) => void;
    readonly wakeStateMutationOutbox?: () => void;
    readonly adminPrincipalIds?: ReadonlySet<string>;
}): GroupTopologyManagementService {
    const groups = [options.group, ...(options.additionalGroups ?? [])];
    groups.forEach((group) => seedGroupAuthorityState(options.runtimeRepository, group));
    const service = new GroupTopologyManagementService({
        findGroupSnapshotByRef: (ref) => {
            const group = groups.find((candidate) =>
                ref.applicationId === candidate.group.applicationId &&
                ref.workspaceId === candidate.group.workspaceId &&
                ref.groupId === candidate.group.groupId
            );
            return Promise.resolve(
                group === undefined
                    ? undefined
                    : group === options.group
                    ? options.readGroup?.() ?? options.group
                    : group,
            );
        },
        groupStateRepository: new GroupStateRepository(options.runtimeRepository),
        configRepository: options.configRepository ??
            new GroupTopologyConfigRepository(options.runtimeRepository),
        topologyService: options.topologyService ?? new RallarRtcTopologyService({
            now: () => 2_000,
        }),
        topologySnapshotRepository: options.topologySnapshotRepository,
        rttRepository: options.rttRepository,
        publisher: options.publisher,
        serverDefaults: options.serverDefaults,
        processRttReader: () => [],
        now: options.now,
        sleep: options.sleep,
        timing: options.timing,
        wakeStateMutationOutbox: options.wakeStateMutationOutbox,
        adminPrincipalIds: options.adminPrincipalIds,
    });
    let anonymousCommandSequence = 0;
    const execute = async (
        command: GroupTopologyConfigMutationCommand,
    ): Promise<GroupTopologyConfigMutationExecution> =>
        await executeTopologyConfigThroughTestInbox(
            service,
            options.runtimeRepository,
            command,
            options.now,
            options.sleep,
        );
    service.putConfig = async (input: PutGroupTopologyConfigInput) => {
        const requestId = input.requestId ?? null;
        const execution = await execute({
            operation: 'putConfig',
            aggregateRef: input.groupRef,
            commandId: requestId ?? `anonymous-${++anonymousCommandSequence}`,
            requestId,
            input: {
                config: input.config,
                updatedByPrincipalId: input.updatedByPrincipalId,
                ttlMs: null,
                expiresAtEpochMs: null,
            },
        });
        if (!execution.config) throw new TypeError('Expected topology config result');
        return { config: execution.config, receipt: execution.receipt };
    };
    service.deleteConfig = async (input: DeleteGroupTopologyConfigInput) => {
        const requestId = input.requestId ?? null;
        const execution = await execute({
            operation: 'deleteConfig',
            aggregateRef: input.groupRef,
            commandId: requestId ?? `anonymous-${++anonymousCommandSequence}`,
            requestId,
            input: {
                config: null,
                updatedByPrincipalId: input.updatedByPrincipalId,
                ttlMs: null,
                expiresAtEpochMs: null,
            },
        });
        return {
            deleted: execution.receipt.outcome === 'applied',
            receipt: execution.receipt,
        };
    };
    service.putOverride = async (input: PutGroupTopologyOverrideInput) => {
        const requestId = input.requestId ?? null;
        const execution = await execute({
            operation: 'putOverride',
            aggregateRef: input.groupRef,
            commandId: requestId ?? `anonymous-${++anonymousCommandSequence}`,
            requestId,
            input: {
                config: input.config,
                updatedByPrincipalId: input.updatedByPrincipalId,
                ttlMs: input.ttlMs ?? null,
                expiresAtEpochMs: input.expiresAtEpochMs ?? null,
            },
        });
        if (!execution.override) throw new TypeError('Expected topology override result');
        return { override: execution.override, receipt: execution.receipt };
    };
    service.deleteOverride = async (input: DeleteGroupTopologyConfigInput) => {
        const requestId = input.requestId ?? null;
        const execution = await execute({
            operation: 'deleteOverride',
            aggregateRef: input.groupRef,
            commandId: requestId ?? `anonymous-${++anonymousCommandSequence}`,
            requestId,
            input: {
                config: null,
                updatedByPrincipalId: input.updatedByPrincipalId,
                ttlMs: null,
                expiresAtEpochMs: null,
            },
        });
        return {
            deleted: execution.receipt.outcome === 'applied',
            receipt: execution.receipt,
        };
    };
    return service;
}

async function executeTopologyConfigThroughTestInbox(
    service: GroupTopologyManagementService,
    runtime: FakeRuntimeStateRepository,
    command: GroupTopologyConfigMutationCommand,
    now: (() => number) | undefined,
    onRetry: ((delayMs: number) => Promise<void>) | undefined,
): Promise<GroupTopologyConfigMutationExecution> {
    const preparation = await service.prepareTopologyConfigMutation({
        command,
        commandHash: await hashStateMutationCommand(command),
        capturedAtEpochMs: now?.() ?? Date.now(),
    });
    for (let attemptCount = 1; attemptCount <= 20; attemptCount += 1) {
        try {
            const read = await service.readTopologyConfigMutation(command);
            const computed = service.computeTopologyConfigMutation(
                preparation,
                read,
                attemptCount,
            );
            service.validateTopologyConfigMutation(
                preparation,
                read,
                attemptCount,
                computed,
            );
            if (computed.outcome === 'idempotency-conflict') {
                throw new GroupTopologyConfigIdempotencyConflictError(
                    computed.existingCommandHash,
                    computed.receivedCommandHash,
                );
            }
            if (computed.outcome === 'write' || computed.outcome === 'claim') {
                await runtime.begin(async (transaction) =>
                    await writeTopologyConfigThroughTestTransaction(
                        transaction,
                        computed,
                    )
                );
            }
            return service.toTopologyConfigMutationResult(computed);
        } catch (error) {
            if (
                error instanceof RuntimeStateWriteConflictError &&
                attemptCount < 20
            ) {
                await onRetry?.(0);
                continue;
            }
            throw error;
        }
    }
    throw new RuntimeStateWriteConflictError();
}

async function writeTopologyConfigThroughTestTransaction(
    transaction: RuntimeStateOptimisticTransactionalRepositoryLike,
    computed: Extract<
        GroupTopologyConfigMutationComputed,
        { outcome: 'write' | 'claim' }
    >,
): Promise<void> {
    const authority = await new GroupStateRepository(transaction)
        .advanceAuthorityFence(computed.groupAuthorityGuard);
    if (
        authority.status === 'conflict' ||
        authority.revision !== computed.groupAuthorityGuard.entry.revision + 1
    ) {
        throw new RuntimeStateWriteConflictError();
    }
    const repository = new GroupTopologyConfigRepository(transaction);
    if (computed.outcome === 'write') {
        const guard = computed.guard;
        const state = guard.operation === 'delete'
            ? guard.target === 'config'
                ? await repository.deleteConfig(
                    computed.receipt.groupRef,
                    guard.expectedRevision,
                )
                : await repository.deleteOverride(
                    computed.receipt.groupRef,
                    guard.expectedRevision,
                )
            : guard.target === 'config'
            ? await repository.commitConfig(guard.value, guard.expectedRevision)
            : await repository.commitOverride(guard.value, guard.expectedRevision);
        requireTestTopologyWrite(state);
        requireTestTopologyWrite(await repository.commitInvariantGeneration(
            computed.invariantGenerationGuard.value,
            computed.invariantGenerationGuard.expectedRevision,
        ));
        requireTestTopologyWrite(await repository.commitGeneration(
            computed.generationGuard.value,
            computed.generationGuard.expectedRevision,
        ));
    }
    if (computed.idempotency) {
        requireTestTopologyWrite(
            await repository.insertMutationRecord(computed.idempotency),
        );
    }
}

function requireTestTopologyWrite(
    result: Readonly<{ status: 'accepted' | 'conflict' }>,
): void {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}

function seedGroupAuthorityState(
    runtime: FakeRuntimeStateRepository,
    snapshot: GroupSnapshot,
): void {
    const putIfMissing = (namespace: string, key: string, value: unknown): void => {
        const compositeKey = `${namespace}::${key}`;
        if (runtime.data.has(compositeKey)) return;
        runtime.data.set(compositeKey, {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            updatedTimestamp: new Date(0).toISOString(),
            revision: 0,
        });
    };
    putIfMissing(
        'group-state:groups',
        groupStateGroupStorageKey(snapshot.group),
        snapshot.group,
    );
    for (const member of snapshot.members) {
        putIfMissing(
            'group-state:members',
            groupStateMemberStorageKey(member),
            member,
        );
    }
}

async function persistGroupAuthorityMutation(
    runtime: FakeRuntimeStateRepository,
    snapshot: GroupSnapshot,
): Promise<void> {
    const repository = new GroupStateRepository(runtime);
    const current = await repository.findGroupEntry(snapshot.group);
    if (!current) throw new Error('Expected seeded group authority row');
    const written = await repository.updateGroup(
        snapshot.group,
        current.entry.revision,
    );
    if (written.status !== 'applied') {
        throw new Error('Expected group authority mutation to apply');
    }
    for (const member of snapshot.members) {
        await repository.putMember(member);
    }
}

function topologyConfig(
    groupRef: GroupRef,
    version: number,
    topologyKind: 'tree' | 'mesh',
    requestId: string,
) {
    return {
        groupRef: {
            applicationId: groupRef.applicationId,
            workspaceId: groupRef.workspaceId,
            groupId: groupRef.groupId,
        },
        config: effectiveTopologyConfig(topologyKind),
        version,
        createdAtEpochMs: 1,
        updatedAtEpochMs: version,
        updatedByPrincipalId: 'owner',
        requestId,
    };
}

function returnFirstEntryAs(
    runtime: FakeRuntimeStateRepository,
    namespace: string,
    key: string,
    entry: Readonly<{ entry: RuntimeStateEntry; value: unknown }> | undefined,
): void {
    const findEntry = runtime.findEntry.bind(runtime);
    let first = true;
    runtime.findEntry = async (candidateNamespace, candidateKey) => {
        if (first && candidateNamespace === namespace && candidateKey === key) {
            first = false;
            return entry?.entry;
        }
        return await findEntry(candidateNamespace, candidateKey);
    };
}

function forceFirstTargetGenerationConflict(
    runtime: FakeRuntimeStateRepository,
    key: string,
): void {
    const upsertIfRevision = runtime.upsertIfRevision.bind(runtime);
    let first = true;
    runtime.upsertIfRevision = async (
        namespace,
        candidateKey,
        value,
        expireAtTimestamp,
        expectedRevision,
    ) => {
        if (
            first &&
            namespace === GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE &&
            candidateKey === key
        ) {
            first = false;
            return { status: 'conflict' };
        }
        return await upsertIfRevision(
            namespace,
            candidateKey,
            value,
            expireAtTimestamp,
            expectedRevision,
        );
    };
}

function blockFirstReadsTogether(
    runtime: FakeRuntimeStateRepository,
    namespace: string,
    key: string,
    count: number,
    skip: number = 0,
): void {
    const findEntry = runtime.findEntry.bind(runtime);
    let seen = 0;
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
    });
    runtime.findEntry = async (candidateNamespace, candidateKey) => {
        const entry = await findEntry(candidateNamespace, candidateKey);
        if (
            candidateNamespace === namespace &&
            candidateKey === key &&
            ++seen > skip &&
            waiting < count
        ) {
            waiting += 1;
            if (waiting === count) release();
            await barrier;
        }
        return entry;
    };
}

function createGroupRef(workspaceId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId,
        groupId: 'room-1',
    };
}

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}

function effectiveTopologyConfig(
    topologyKind: EffectiveGroupTopologyConfig['topologyKind'] = 'auto',
): EffectiveGroupTopologyConfig {
    return {
        topologyKind,
        degreeLimit: 5,
        treeMinSize: 5,
        meshMinSize: 16,
        meshParamK: 2,
    };
}

function createGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
    const sessionIds = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'];
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: {
            ...groupRef,
            slug: null,
            displayName: groupRef.groupId,
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId: 'owner',
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            created: audit(1),
            updated: audit(1),
        },
        members: sessionIds.map((sessionId, index) => ({
            ...groupRef,
            principalId: index === 0 ? 'owner' : sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: audit(1),
            updated: audit(1),
        })),
        activeSessions: sessionIds.map((sessionId, index) => ({
            ...groupRef,
            sessionId,
            principalId: index === 0 ? 'owner' : sessionId,
            generationId: `${sessionId}-generation`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function createTopologySnapshot(
    groupRef: GroupRef,
    nextHopsBySessionId: Record<string, readonly string[]>,
    degreeLimit = 5,
): RallarOverlayTopologySnapshot {
    const canonicalGroupRef: GroupRef = {
        applicationId: groupRef.applicationId,
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId,
    };
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: 1,
            presenceRevision: 0,
        },
        state: 'active',
        overlayId: JSON.stringify([
            groupRef.applicationId,
            groupRef.workspaceId ?? '',
            groupRef.groupId,
        ]),
        groupRef: canonicalGroupRef,
        name: groupRef.groupId,
        topology: 'tree',
        activeSessionIds: Object.keys(nextHopsBySessionId).sort(),
        nextHopsBySessionId,
        degreeLimit,
        version: 1,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
    };
}

function createInvalidTopologyService(groupRef: GroupRef): RallarRtcTopologyService {
    const invalidSnapshot = createTopologySnapshot(groupRef, {
        'session-a': ['session-b'],
        'session-b': ['session-a'],
    });
    const invalidWithMissingRoute = {
        ...invalidSnapshot,
        activeSessionIds: [...invalidSnapshot.activeSessionIds, 'session-z'],
    };

    return {
        planGroupTopologyAt: vi.fn(() => ({
            snapshot: invalidWithMissingRoute,
            changed: true,
        })),
        planGroupTopology: vi.fn(() => ({
            snapshot: invalidWithMissingRoute,
            changed: true,
        })),
        readSnapshot: vi.fn(),
        recordTopologyPublishResult: vi.fn(),
        readNowEpochMs: vi.fn(() => 1),
    } as unknown as RallarRtcTopologyService;
}

async function seedTopologySnapshot(
    repository: RtcTopologySnapshotRepository,
    snapshot: RallarOverlayTopologySnapshot,
): Promise<void> {
    const current = await repository.findSnapshotEntry(snapshot.groupRef);
    const result = await repository.commitSnapshotGuard(
        snapshot,
        current?.entry.revision ?? null,
    );
    if (result.status !== 'accepted') {
        throw new Error('Expected topology snapshot seed to be accepted');
    }
}

function freezeDeep<T>(value: T): T {
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Map) {
        for (const [key, child] of value) {
            freezeDeep(key);
            freezeDeep(child);
        }
    }
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
}
