import { describe, expect, it } from 'vitest';
import type {
    ClientInstance,
    ClientPrincipal,
    ClientSession,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import {
    findClientStateSnapshotByPrincipalId,
} from '@shared/repository/client-state-snapshots-repository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import {
    createClientStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('ClientStateSnapshotReadThroughCache', () => {
    it('hydrates a cold client snapshot cache from durable state', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(runtimeRepository);
        const snapshot = createClientSnapshot(
            'alice',
            'app-1',
            'workspace-a',
            3,
        );
        await putClientSnapshot(clientRepository, snapshot);

        const readThroughCache = createClientStateSnapshotReadThroughCache({
            clientsRepository: clientRepository,
        });

        expect(findClientStateSnapshotByPrincipalId('alice')).toBeUndefined();

        await expect(readThroughCache.findOrLoadByRef(snapshot.principal))
            .resolves.toEqual(snapshot);

        expect(
            findClientStateSnapshotByPrincipalId('alice')?.principal.snapshotVersion,
        ).toBe(3);
    });

    it('refreshes a stale loaned client snapshot when a newer version is required', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(runtimeRepository);
        const stale = createClientSnapshot('alice', 'app-1', 'workspace-a', 1);
        const current = createClientSnapshot('alice', 'app-1', 'workspace-a', 4);
        const readThroughCache = createClientStateSnapshotReadThroughCache({
            clientsRepository: clientRepository,
        });

        await putClientSnapshot(clientRepository, stale);
        await expect(readThroughCache.findOrLoadByRef(stale.principal))
            .resolves.toEqual(stale);
        expect(
            findClientStateSnapshotByPrincipalId('alice')?.principal.snapshotVersion,
        ).toBe(1);

        await putClientSnapshot(clientRepository, current);

        await expect(
            readThroughCache.findOrLoadByRef(current.principal, {
                minSnapshotVersion: 4,
            }),
        ).resolves.toEqual(current);

        expect(
            findClientStateSnapshotByPrincipalId('alice')?.principal.snapshotVersion,
        ).toBe(4);
    });

    it('keeps same-principal snapshots isolated inside the scoped loaned cache', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(runtimeRepository);
        const workspaceA = createClientSnapshot('alice', 'app-1', 'workspace-a', 1);
        const workspaceB = createClientSnapshot('alice', 'app-1', 'workspace-b', 2);
        const readThroughCache = createClientStateSnapshotReadThroughCache({
            clientsRepository: clientRepository,
        });

        await putClientSnapshot(clientRepository, workspaceA);
        await putClientSnapshot(clientRepository, workspaceB);

        await expect(readThroughCache.findOrLoadByRef(workspaceA.principal))
            .resolves.toEqual(workspaceA);
        await expect(readThroughCache.findOrLoadByRef(workspaceB.principal))
            .resolves.toEqual(workspaceB);

        expect(readThroughCache.findByRef(workspaceA.principal)).toEqual(workspaceA);
        expect(readThroughCache.findByRef(workspaceB.principal)).toEqual(workspaceB);
    });
});

async function putClientSnapshot(
    repository: ClientStateRepository,
    snapshot: ClientSnapshot,
): Promise<void> {
    await repository.putPrincipal(snapshot.principal);
    await Promise.all(snapshot.instances.map((instance) => repository.putInstance(instance)));
    await Promise.all(snapshot.activeSessions.map((session) => repository.putSession(session)));
}

function createClientSnapshot(
    principalId: string,
    applicationId: string,
    workspaceId: string,
    snapshotVersion: number,
): ClientSnapshot {
    const principal: ClientPrincipal = {
        applicationId,
        workspaceId,
        principalId,
        username: principalId,
        displayName: principalId,
        status: 'active',
        roles: [],
        metadata: {},
        snapshotVersion,
        profileVersion: snapshotVersion,
        presenceVersion: snapshotVersion,
        created: {
            atEpochMs: 1,
        },
        updated: {
            atEpochMs: snapshotVersion,
        },
    };
    const instance: ClientInstance = {
        applicationId,
        workspaceId,
        principalId,
        clientInstanceId: `${principalId}-instance`,
        status: 'active',
        platform: 'web',
        capabilities: [],
        registered: {
            atEpochMs: 1,
        },
        updated: {
            atEpochMs: snapshotVersion,
        },
    };
    const session: ClientSession = {
        applicationId,
        workspaceId,
        principalId,
        clientInstanceId: instance.clientInstanceId,
        sessionId: `${principalId}-${workspaceId}-session`,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: snapshotVersion,
        expiresAtEpochMs: 4_000_000_000_000,
    };

    return {
        principal,
        instances: [instance],
        activeSessions: [session],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: snapshotVersion,
    };
}
