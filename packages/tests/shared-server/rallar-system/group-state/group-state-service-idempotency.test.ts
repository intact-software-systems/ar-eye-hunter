import { groupStateMaintenanceRequestId } from '@shared-server/rallar-system/group-state/group-presence-mutation-command.ts';
import { GroupAlreadyExistsError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { describe, expect, it, vi } from 'vitest';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateRuntime, createTestGroupStateService as createGroupStateService } from './group-state-test-runtime.ts';
import { SCOPE, seedGroup, toGroupRef } from './presence/group-presence-retry-test-runtime.ts';

describe('GroupStateService command idempotency', () => {
    it('records timing for group state service methods when a timing sink is supplied', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const service = createGroupStateService({
            runtimeRepository: new FakeRuntimeStateRepository(),
            now: () => 1_000,
            serviceId: 'group-service',
            timing: (event) => timingEvents.push(event)
        });

        await service.createGroup(SCOPE, {
            groupId: 'timed-room',
            displayName: 'Timed Room',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'create-timed-room'
        });

        expect(timingEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    component: 'group-state-service',
                    operation: 'read',
                    status: 'ok',
                    serviceId: 'group-service',
                    requestId: 'create-timed-room',
                    applicationId: SCOPE.applicationId,
                    workspaceId: SCOPE.workspaceId,
                    groupId: 'timed-room'
                })
            ])
        );
        expect(typeof timingEvents[0]?.durationMs).toBe('number');
    });

    it('retries createGroup with the same requestId without creating duplicate state or events', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createGroupStateService({
            runtimeRepository,
            now: () => 1_000,
            serviceId: 'group-service'
        });
        const groupRef = toGroupRef('room-1');
        const request = {
            groupId: groupRef.groupId,
            displayName: 'Room 1',
            kind: 'room' as const,
            joinMode: 'open' as const,
            createdByPrincipalId: 'alice',
            requestId: 'create-room-1'
        };

        await expect(service.createGroup(SCOPE, request)).resolves.toMatchObject({
            status: 'created',
            result: {
                snapshot: {
                    group: {
                        ...groupRef,
                        snapshotVersion: 1
                    }
                }
            }
        });
        await expect(service.createGroup(SCOPE, request)).resolves.toMatchObject({
            status: 'created',
            result: {
                snapshot: {
                    group: {
                        ...groupRef,
                        snapshotVersion: 1
                    }
                }
            }
        });

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect((await repository.listEvents(groupRef)).map((event) => event.eventType)).toEqual([
            'group-created'
        ]);
        expect((await repository.readSnapshot(groupRef))?.group.snapshotVersion).toBe(1);
    });

    it('returns a group-already-exists conflict when createGroup uses a different requestId', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const runtime = createTestGroupStateRuntime({
            runtimeRepository,
            now: () => 1_000,
            serviceId: 'group-service'
        });
        const service = runtime.service;
        const groupRef = toGroupRef('room-6');

        await service.createGroup(SCOPE, {
            groupId: groupRef.groupId,
            displayName: 'Room 6',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'create-room-6-a'
        });

        try {
            await service.createGroup(SCOPE, {
                groupId: groupRef.groupId,
                displayName: 'Room 6',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                requestId: 'create-room-6-b'
            });
            throw new TypeError('Expected duplicate group creation to be rejected');
        }
        catch (error) {
            expect(error).toBeInstanceOf(GroupAlreadyExistsError);
            if (!(error instanceof GroupAlreadyExistsError)) {
                throw error;
            }
            expect(error.code).toBe('group-already-exists');
            expect(error.status).toBe(409);
            expect(error.message).toBe('Group already exists: room-6');
        }

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect((await repository.listEvents(groupRef)).map((event) => event.eventType)).toEqual([
            'group-created'
        ]);
    });

    it('returns the stored revisioned createGroup snapshot', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createGroupStateService({
            runtimeRepository,
            now: () => 1_000,
            serviceId: 'group-service'
        });

        await expect(
            service.createGroup(SCOPE, {
                groupId: 'room-no-readback',
                displayName: 'Room no readback',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                requestId: 'create-room-no-readback'
            })
        ).resolves.toMatchObject({
            status: 'created',
            result: {
                snapshot: {
                    causalRevision: { groupRevision: 1, presenceRevision: 0 },
                    members: [
                        {
                            principalId: 'alice',
                            role: 'owner',
                            status: 'active'
                        }
                    ],
                    activeSessions: [],
                    memberCount: 1,
                    onlineMemberCount: 0
                }
            }
        });
    });

    it('rejects createGroup reuse with the same requestId and different semantic content', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createGroupStateService({
            runtimeRepository,
            now: () => 1_000,
            serviceId: 'group-service'
        });

        await service.createGroup(SCOPE, {
            groupId: 'room-3',
            displayName: 'Room 3',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'create-room-3'
        });

        await expect(
            service.createGroup(SCOPE, {
                groupId: 'room-3',
                displayName: 'Room 3 with different payload',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                requestId: 'create-room-3'
            })
        ).rejects.toMatchObject({
            code: 'group-mutation-idempotency-conflict',
            status: 409
        });

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect((await repository.readSnapshot(toGroupRef('room-3')))?.group).toMatchObject({
            displayName: 'Room 3',
            snapshotVersion: 1
        });
    });

    it('replays updateGroup with the same requestId without bumping versions twice', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-2');

        const service = createGroupStateService({
            runtimeRepository,
            now: () => 2_000,
            serviceId: 'group-service'
        });
        const groupRef = toGroupRef('room-2');
        const request = {
            displayName: 'Room 2 renamed',
            actorPrincipalId: 'alice',
            requestId: 'rename-room-2'
        };

        const first = await service.updateGroup(SCOPE, groupRef.groupId, request);
        const second = await service.updateGroup(SCOPE, groupRef.groupId, request);

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                snapshot: {
                    group: {
                        displayName: 'Room 2 renamed',
                        snapshotVersion: 2
                    }
                }
            }
        });
        expect(first.result?.event?.eventType).toBe('group-updated');
        expect(second.result?.event).toEqual(first.result?.event);

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect((await repository.readSnapshot(groupRef))?.group.snapshotVersion).toBe(2);
        expect((await repository.listEvents(groupRef)).map((event) => event.eventType)).toEqual([
            'group-created',
            'group-updated'
        ]);
    });

    it('replays upsertMember with the same requestId without adding duplicate roster events', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-5');

        const service = createGroupStateService({
            runtimeRepository,
            now: () => 3_000,
            serviceId: 'group-service'
        });
        const groupRef = toGroupRef('room-5');
        const request = {
            role: 'member' as const,
            status: 'active' as const,
            actorPrincipalId: 'alice',
            requestId: 'join-bob-room-5'
        };

        const first = await service.upsertMember(SCOPE, groupRef.groupId, 'bob', request);
        const second = await service.upsertMember(SCOPE, groupRef.groupId, 'bob', request);

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                snapshot: {
                    group: {
                        snapshotVersion: 2,
                        rosterVersion: 2
                    },
                    memberCount: 2
                }
            }
        });
        expect(first.result?.event?.eventType).toBe('member-joined');
        expect(second.result?.event).toEqual(first.result?.event);

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect((await repository.listEvents(groupRef)).map((event) => event.eventType)).toEqual([
            'group-created',
            'member-joined'
        ]);
        expect(
            (await repository.readSnapshot(groupRef))?.members.map((member) => member.principalId).sort()
        ).toEqual(['alice', 'bob']);
    });
});
