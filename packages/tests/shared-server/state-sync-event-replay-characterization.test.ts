import { describe, expect, it } from 'vitest';
import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
    createLegacyClientStateTestDriver as createClientStateService,
} from './client-state-phase-test-driver.ts';
import { createTestGroupStateService as createGroupStateService } from './group-state/group-state-test-runtime.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};

describe('state sync event replay characterization', () => {
    it('keeps durable group events readable after mutations for manual recovery', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        let now = 1_000;
        const service = createGroupStateService({
            runtimeRepository,
            syncPublisher: createPublisher(),
            now: () => now,
            serviceId: 'group-service',
        });
        const groupRef = toGroupRef('room-1');

        await service.createGroup(SCOPE, {
            groupId: groupRef.groupId,
            displayName: 'Room 1',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            actorPrincipalId: 'alice',
            requestId: 'create-room-1',
        });
        now = 2_000;
        await service.updateGroup(SCOPE, groupRef.groupId, {
            displayName: 'Room 1 renamed',
            actorPrincipalId: 'alice',
            requestId: 'rename-room-1',
        });

        const events = await service.listEvents(groupRef);

        expect(events.map((event) => event.eventType)).toEqual([
            'group-created',
            'group-updated',
        ]);
        expect(events.map((event) => event.occurredAtEpochMs)).toEqual([
            1_000,
            2_000,
        ]);
        expect(events.map((event) => event.snapshotVersion)).toEqual([1, 2]);
    });

    it('keeps durable client events readable after mutations for manual recovery', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        let now = 1_000;
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: createPublisher(),
            now: () => now,
            serviceId: 'client-service',
        });
        const principalRef = toClientPrincipalRef('alice');

        await service.upsertPrincipal(SCOPE, principalRef.principalId, {
            username: 'alice',
            displayName: 'Alice',
            actorPrincipalId: 'alice',
            requestId: 'create-alice',
        });
        now = 2_000;
        await service.upsertPrincipal(SCOPE, principalRef.principalId, {
            username: 'alice',
            displayName: 'Alice renamed',
            actorPrincipalId: 'alice',
            requestId: 'rename-alice',
        });

        const events = await service.listEvents(principalRef);

        expect(events.map((event) => event.eventType)).toEqual([
            'principal-created',
            'principal-updated',
        ]);
        expect(events.map((event) => event.occurredAtEpochMs)).toEqual([
            1_000,
            2_000,
        ]);
        expect(events.map((event) => event.snapshotVersion)).toEqual([1, 2]);
    });

    it('uses aggregate snapshot version as the replay order for equal timestamps', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(runtimeRepository);
        const clientRepository = new ClientStateRepository(runtimeRepository);
        const groupRef = toGroupRef('room-1');
        const principalRef = toClientPrincipalRef('alice');

        await groupRepository.appendEvent(createGroupEvent('group-event-a', 1_000, 2));
        await groupRepository.appendEvent(createGroupEvent('group-event-b', 1_000, 1));
        await clientRepository.appendEvent(createClientEvent('client-event-a', 1_000, 2));
        await clientRepository.appendEvent(createClientEvent('client-event-b', 1_000, 1));

        const groupEvents = await groupRepository.listEvents(groupRef);
        const clientEvents = await clientRepository.listEvents(principalRef);

        expect(groupEvents.map((event) => event.eventId)).toEqual([
            'group-event-b',
            'group-event-a',
        ]);
        expect(clientEvents.map((event) => event.eventId)).toEqual([
            'client-event-b',
            'client-event-a',
        ]);
        expect(groupEvents.map((event) => event.snapshotVersion)).toEqual([1, 2]);
        expect(clientEvents.map((event) => event.snapshotVersion)).toEqual([1, 2]);
    });
});

function toGroupRef(groupId: string): GroupRef {
    return {
        ...SCOPE,
        groupId,
    };
}

function toClientPrincipalRef(principalId: string): ClientPrincipalRef {
    return {
        ...SCOPE,
        principalId,
    };
}

function createGroupEvent(
    eventId: string,
    occurredAtEpochMs: number,
    snapshotVersion = 1,
): GroupEvent {
    return {
        ...toGroupRef('room-1'),
        eventId,
        eventType: 'group-updated',
        snapshotVersion,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion,
        },
        occurredAtEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
    };
}

function createClientEvent(
    eventId: string,
    occurredAtEpochMs: number,
    snapshotVersion = 1,
): ClientEvent {
    return {
        ...toClientPrincipalRef('alice'),
        eventId,
        eventType: 'principal-updated',
        snapshotVersion,
        occurredAtEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        clientInstanceId: null,
        sessionId: null,
        payload: {},
    };
}

function createPublisher(): StateSyncPublisher {
    return {
        publishClientSnapshot: async () => undefined,
        publishClientEvent: async () => undefined,
        publishGroupSnapshot: async () => undefined,
        publishGroupEvent: async () => undefined,
    };
}
