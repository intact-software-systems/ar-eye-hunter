import { describe, expect, it, vi } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    GroupTopologyConfigRepository,
    RtcRttRepository,
    RtcTopologySnapshotRepository,
} from '@shared-server/mod.ts';
import {
    GroupTopologyManagementService,
    GroupTopologyValidationError,
} from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('GroupTopologyManagementService', () => {
    it('plans topology from an explicit predecessor without persisting under the graph computation', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const previous = createTopologySnapshot(group.group, {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        });
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        await snapshots.putSnapshot(previous);
        const topologyService = new RallarRtcTopologyService();
        const service = createService({ runtimeRepository, group, topologyService });

        const result = await service.planGroupTopology(group, previous);

        expect(result.previous).toBe(previous);
        expect(result.snapshot.sourceGroupStateRevision).toBe(group.stateRevision);
        expect(await snapshots.findSnapshot(group.group)).toEqual(previous);
        expect(topologyService.readSnapshot(group)).toBeUndefined();
    });

    it('uses the immutable group update time for a planned removal tombstone', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const active = createGroupSnapshot(createGroupRef('workspace-1'));
        const group = {
            ...active,
            stateRevision: 2,
            group: {
                ...active.group,
                status: 'deleted' as const,
                updated: { atEpochMs: 123, byPrincipalId: 'owner' },
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
            sourceGroupStateRevision: 2,
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
        expect(view.snapshot).toBeUndefined();
        expect(view.config.effective).toEqual({
            topologyKind: 'auto',
            degreeLimit: 5,
            treeMinSize: 5,
            meshMinSize: 16,
            meshParamK: 2,
        });
    });

    it('resolves effective config, reads durable RTTs, locks snapshots, persists, and publishes changed topology', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        const rttRepository = new RtcRttRepository(runtimeRepository);
        await configRepository.putConfig({
            groupRef: group.group,
            config: {
                topologyKind: 'tree',
                degreeLimit: 4,
            },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
        });
        await rttRepository.putMeasurementIfNewer({
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 7,
            createdAtEpochMs: 1,
            version: 1,
        }, Date.now() + 60_000);
        const topologyService = new RallarRtcTopologyService({
            now: () => 2_000,
        });
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopology');
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

        const result = await service.reconfigureGroupTopology({
            groupRef: group.group,
            requestOptions: {
                degreeLimit: 3,
            },
        });

        expect(result.changed).toBe(true);
        expect(result.published).toBe(true);
        expect(result.config.effective).toEqual({
            topologyKind: 'tree',
            degreeLimit: 3,
            treeMinSize: 5,
            meshMinSize: 16,
            meshParamK: 2,
        });
        expect(planGroupTopology).toHaveBeenCalledWith(
            group,
            [
                {
                    sessionIdFrom: 'session-a',
                    sessionIdTo: 'session-b',
                    rttMs: 7,
                    createdAtEpochMs: 1,
                    version: 1,
                },
            ],
            expect.objectContaining({
                previous: undefined,
                topologyOptions: result.config.effective,
            }),
        );
        expect(await new RtcTopologySnapshotRepository(runtimeRepository)
            .findSnapshot(group.group)).toEqual(result.snapshot);
        expect(runtimeRepository.locks).toContainEqual({
            namespace: RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            key: new RtcTopologySnapshotRepository(runtimeRepository).snapshotKey(group.group),
        });
        expect(publisher).toHaveBeenCalledTimes(1);
        expect(publisher.mock.calls[0][0].payload.typeId).toBe(AppTopics.overlayTopology);
    });

    it('returns the authoritative topology and skips publication when a stale group is superseded', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const current = {
            ...createTopologySnapshot(group.group, {
                'session-a': ['session-b'],
                'session-b': ['session-a'],
            }),
            sourceGroupStateRevision: 2,
        };
        const topologySnapshotRepository = new RtcTopologySnapshotRepository(
            runtimeRepository,
        );
        await topologySnapshotRepository.putSnapshot(current);
        const publisher = vi.fn();
        const service = createService({
            runtimeRepository,
            group,
            topologySnapshotRepository,
            publisher,
        });

        const result = await service.reconfigureGroupTopology({
            groupRef: group.group,
        });

        expect(result).toMatchObject({
            changed: false,
            published: false,
            snapshot: current,
            previous: current,
        });
        expect(publisher).not.toHaveBeenCalled();
    });

    it('replans outside the transaction when the durable predecessor moves', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const baseGroup = createGroupSnapshot(createGroupRef('workspace-1'));
        const group = { ...baseGroup, stateRevision: 3 };
        const previous = createTopologySnapshot(group.group, {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        });
        const moved = {
            ...previous,
            sourceGroupStateRevision: 2,
            version: 2,
            updatedAtEpochMs: 3,
        };
        const topologySnapshotRepository = new RtcTopologySnapshotRepository(
            runtimeRepository,
        );
        await topologySnapshotRepository.putSnapshot(previous);
        const originalCommit = topologySnapshotRepository.commitSnapshot
            .bind(topologySnapshotRepository);
        const commitSnapshot = vi.spyOn(
            topologySnapshotRepository,
            'commitSnapshot',
        ).mockImplementationOnce(async () => {
            await topologySnapshotRepository.putSnapshot(moved);
            return { status: 'retry', current: moved };
        }).mockImplementation(originalCommit);
        const topologyService = new RallarRtcTopologyService({ now: () => 4 });
        const planGroupTopology = vi.spyOn(
            topologyService,
            'planGroupTopology',
        );
        const publisher = vi.fn();
        const service = createService({
            runtimeRepository,
            group,
            topologyService,
            topologySnapshotRepository,
            publisher,
        });

        const result = await service.reconfigureGroupTopology({
            groupRef: group.group,
        });

        expect(commitSnapshot).toHaveBeenCalledTimes(2);
        expect(planGroupTopology).toHaveBeenCalledTimes(2);
        expect(result.snapshot.sourceGroupStateRevision).toBe(3);
        expect(result.previous).toEqual(moved);
        expect(result.published).toBe(true);
        expect(publisher).toHaveBeenCalledTimes(1);
        expect(publisher.mock.calls[0][1]).toEqual(result.snapshot);
    });

    it('filters stored RTTs that are not reporting edges for the recomputed group', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        await new RtcTopologySnapshotRepository(runtimeRepository).putSnapshot(
            createTopologySnapshot(
                group.group,
                {
                    'session-a': ['session-b'],
                    'session-b': ['session-a'],
                    'session-c': ['session-d'],
                    'session-d': ['session-c'],
                    'session-e': [],
                },
                1,
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
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopology');
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
        const topologyService = {
            planGroupTopology: vi.fn(() => ({
                snapshot: invalidSnapshot,
                changed: true,
            })),
            readSnapshot: vi.fn(),
            recordTopologyPublishResult: vi.fn(),
        } as unknown as RallarRtcTopologyService;
        const publisher = vi.fn();
        const service = createService({
            runtimeRepository,
            group,
            topologyService,
            publisher,
        });

        await expect(service.reconfigureGroupTopology({
            groupRef: group.group,
        })).rejects.toThrow(GroupTopologyValidationError);
        expect(await new RtcTopologySnapshotRepository(runtimeRepository)
            .findSnapshot(group.group)).toBeUndefined();
        expect(publisher).not.toHaveBeenCalled();
    });

    it('does not persist config or overrides when reconfigure validation fails', async () => {
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
        })).rejects.toThrow(GroupTopologyValidationError);
        expect(await configRepository.findConfig(group.group)).toBeUndefined();

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
        })).rejects.toThrow(GroupTopologyValidationError);
        expect(await overrideRepository.findOverride(group.group)).toBeUndefined();
    });

    it('restores config or overrides when delete reconfigure validation fails', async () => {
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const existingConfig = {
            groupRef: group.group,
            config: {
                topologyKind: 'tree' as const,
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
        await configRepository.putConfig(existingConfig);
        const configService = createService({
            runtimeRepository: configRuntimeRepository,
            group,
            configRepository,
            topologyService: createInvalidTopologyService(group.group),
        });

        await expect(configService.deleteConfig({
            groupRef: group.group,
            updatedByPrincipalId: 'owner',
        })).rejects.toThrow(GroupTopologyValidationError);
        expect(await configRepository.findConfig(group.group)).toEqual(existingConfig);

        const existingOverride = {
            ...existingConfig,
            config: {
                topologyKind: 'mesh' as const,
            },
            requestId: 'existing-override',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        const overrideRuntimeRepository = new FakeRuntimeStateRepository();
        const overrideRepository = new GroupTopologyConfigRepository(
            overrideRuntimeRepository,
        );
        await overrideRepository.putOverride(
            existingOverride,
            existingOverride.expiresAtEpochMs,
        );
        const overrideService = createService({
            runtimeRepository: overrideRuntimeRepository,
            group,
            configRepository: overrideRepository,
            topologyService: createInvalidTopologyService(group.group),
        });

        await expect(overrideService.deleteOverride({
            groupRef: group.group,
            updatedByPrincipalId: 'owner',
        })).rejects.toThrow(GroupTopologyValidationError);
        expect(await overrideRepository.findOverride(group.group))
            .toEqual(existingOverride);
    });

    it('passes effective config into due RTT topology flushes', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createGroupSnapshot(createGroupRef('workspace-1'));
        const configRepository = new GroupTopologyConfigRepository(runtimeRepository);
        await configRepository.putConfig({
            groupRef: group.group,
            config: {
                topologyKind: 'tree',
                degreeLimit: 3,
            },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
        });
        const topologyService = new RallarRtcTopologyService({
            now: () => 1_000,
        });
        const updateGroupTopology = vi.spyOn(topologyService, 'updateGroupTopology');
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
        expect(updateGroupTopology).toHaveBeenCalledWith(
            group,
            [],
            expect.objectContaining({
                topologyOptions: result?.config.effective,
            }),
        );
    });

    it('writes and deletes config and overrides with default reconfigure enabled', async () => {
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

            expect(planGroupTopology).toHaveBeenCalledTimes(4);
            expect(await service.readOverride(group.group)).toBeUndefined();
            expect((await service.readConfig(group.group)).durable).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });
});

function createService(options: {
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly group: GroupSnapshot;
    readonly configRepository?: GroupTopologyConfigRepository;
    readonly rttRepository?: RtcRttRepository;
    readonly topologyService?: RallarRtcTopologyService;
    readonly topologySnapshotRepository?: RtcTopologySnapshotRepository;
    readonly publisher?: (message: unknown) => void;
    readonly serverDefaults?: ConstructorParameters<typeof GroupTopologyManagementService>[0]['serverDefaults'];
    readonly now?: () => number;
}): GroupTopologyManagementService {
    return new GroupTopologyManagementService({
        findGroupSnapshotByRef: async (ref) =>
            ref.applicationId === options.group.group.applicationId &&
                ref.workspaceId === options.group.group.workspaceId &&
                ref.groupId === options.group.group.groupId
                ? options.group
                : undefined,
        configRepository: options.configRepository ??
            new GroupTopologyConfigRepository(options.runtimeRepository),
        topologyService: options.topologyService ?? new RallarRtcTopologyService({
            now: () => 2_000,
        }),
        topologySnapshotRepository: options.topologySnapshotRepository ??
            new RtcTopologySnapshotRepository(options.runtimeRepository),
        rttRepository: options.rttRepository,
        publisher: options.publisher,
        serverDefaults: options.serverDefaults,
        processRttReader: () => [],
        now: options.now,
    });
}

function createGroupRef(workspaceId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId,
        groupId: 'room-1',
    };
}

function createGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
    const sessionIds = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'];
    return {
        stateRevision: 1,
        group: {
            ...groupRef,
            displayName: groupRef.groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        },
        members: sessionIds.map((sessionId) => ({
            ...groupRef,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            ...groupRef,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
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
    return {
        sourceGroupStateRevision: 1,
        state: 'active',
        overlayId: JSON.stringify([
            groupRef.applicationId,
            groupRef.workspaceId ?? '',
            groupRef.groupId,
        ]),
        groupRef,
        name: groupRef.groupId,
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'],
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

    return {
        planGroupTopology: vi.fn(() => ({
            snapshot: invalidSnapshot,
            changed: true,
        })),
        readSnapshot: vi.fn(),
        recordTopologyPublishResult: vi.fn(),
    } as unknown as RallarRtcTopologyService;
}
