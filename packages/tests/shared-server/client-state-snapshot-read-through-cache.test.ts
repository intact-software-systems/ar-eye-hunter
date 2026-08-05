import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    AuditStamp,
    ClientInstance,
    ClientPrincipal,
    ClientSession,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import {
    findClientStateSnapshotByRef,
    findClientStateSnapshotByPrincipalId,
} from '@shared/repository/client-state-snapshots-repository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import {
    createClientStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('ClientStateSnapshotReadThroughCache', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

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
            .resolves.toEqual({ ...snapshot, stateRevision: 1 });

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
            .resolves.toEqual({ ...stale, stateRevision: 1 });
        expect(
            findClientStateSnapshotByPrincipalId('alice')?.principal.snapshotVersion,
        ).toBe(1);

        await putClientSnapshot(clientRepository, current);

        await expect(
            readThroughCache.findOrLoadByRef(current.principal, {
                minStateRevision: 2,
            }),
        ).resolves.toEqual({ ...current, stateRevision: 2 });

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
            .resolves.toEqual({ ...workspaceA, stateRevision: 1 });
        await expect(readThroughCache.findOrLoadByRef(workspaceB.principal))
            .resolves.toEqual({ ...workspaceB, stateRevision: 1 });

        expect(readThroughCache.peek(workspaceA.principal))
            .toEqual({ ...workspaceA, stateRevision: 1 });
        expect(readThroughCache.peek(workspaceB.principal))
            .toEqual({ ...workspaceB, stateRevision: 1 });
        expect(findClientStateSnapshotByRef(workspaceA.principal))
            .toEqual({ ...workspaceA, stateRevision: 1 });
        expect(findClientStateSnapshotByRef(workspaceB.principal))
            .toEqual({ ...workspaceB, stateRevision: 1 });
    });

    it('refreshes a warm snapshot when its embedded session has expired', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(0);
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(runtimeRepository);
        const snapshot = createClientSnapshot(
            'alice',
            'app-1',
            'workspace-a',
            3,
            1_000,
        );
        const readThroughCache = createClientStateSnapshotReadThroughCache({
            clientsRepository: clientRepository,
        });
        await putClientSnapshot(clientRepository, snapshot);
        await expect(readThroughCache.findOrLoadByRef(snapshot.principal))
            .resolves.toEqual({ ...snapshot, stateRevision: 1 });

        vi.setSystemTime(1_001);

        await expect(readThroughCache.findOrLoadByRef(snapshot.principal))
            .resolves.toMatchObject({
                activeSessions: [],
                activeSessionCount: 0,
                isOnline: false,
            });
        expect(
            findClientStateSnapshotByPrincipalId('alice')?.activeSessions,
        ).toEqual([]);
    });

    it('observes revisioned snapshots monotonically and rejects conflicts', () => {
        configureTestCacheRepositories();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(runtimeRepository);
        const readThroughCache = createClientStateSnapshotReadThroughCache({
            clientsRepository: clientRepository,
        });
        const base = createClientSnapshot('alice', 'app-1', 'workspace-a', 1);
        const revisionTwo = { ...base, stateRevision: 2 };
        const revisionOne = {
            ...createClientSnapshot('alice', 'app-1', 'workspace-a', 99),
            stateRevision: 1,
        };

        expect(readThroughCache.observe(revisionTwo)).toBe('inserted');
        expect(readThroughCache.observe(revisionOne)).toBe('stale');
        expect(readThroughCache.observe(revisionTwo)).toBe('duplicate');
        expect(() => readThroughCache.observe({
            ...revisionTwo,
            activeSessionCount: 0,
        })).toThrow('Client snapshot revision conflict');
        expect(readThroughCache.peek(base.principal)).toEqual(revisionTwo);
    });
});

async function putClientSnapshot(
    repository: ClientStateRepository,
    snapshot: ClientSnapshot,
): Promise<void> {
    const principalEntry = await repository.findPrincipalEntry(snapshot.principal);
    const principalResult = principalEntry
        ? await repository.updatePrincipal(
            snapshot.principal,
            principalEntry.entry.revision,
        )
        : await repository.insertPrincipal(snapshot.principal);
    expect(principalResult).toMatchObject({ status: 'applied' });
    const instances = await Promise.all(
        snapshot.instances.map(async (instance) => {
            const entry = await repository.findInstanceEntry(instance);
            return entry
                ? await repository.updateInstance(instance, entry.entry.revision)
                : await repository.insertInstance(instance);
        }),
    );
    const sessions = await Promise.all(
        snapshot.activeSessions.map(async (session) => {
            const entry = await repository.findSessionEntry(session);
            return entry
                ? await repository.updateSession(session, entry.entry.revision)
                : await repository.insertSession(session);
        }),
    );
    expect(instances.every((result) => result.status === 'applied')).toBe(true);
    expect(sessions.every((result) => result.status === 'applied')).toBe(true);
}

function createClientSnapshot(
    principalId: string,
    applicationId: string,
    workspaceId: string,
    snapshotVersion: number,
    expiresAtEpochMs = 4_000_000_000_000,
): ClientSnapshot {
    const principal: ClientPrincipal = {
        applicationId,
        workspaceId,
        principalId,
        username: principalId,
        displayName: principalId,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        status: 'active',
        disabled: null,
        deleted: null,
        roles: [],
        metadata: {},
        snapshotVersion,
        profileVersion: snapshotVersion,
        presenceVersion: snapshotVersion,
        created: audit(1),
        updated: audit(snapshotVersion),
        lastSeenAtEpochMs: snapshotVersion,
    };
    const instance: ClientInstance = {
        applicationId,
        workspaceId,
        principalId,
        clientInstanceId: `${principalId}-instance`,
        status: 'active',
        revoked: null,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        registered: audit(1),
        updated: audit(snapshotVersion),
    };
    const session: ClientSession = {
        applicationId,
        workspaceId,
        principalId,
        clientInstanceId: instance.clientInstanceId,
        sessionId: `${principalId}-${workspaceId}-session`,
        generationId: `${principalId}-${workspaceId}-generation`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: snapshotVersion,
        expiresAtEpochMs,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };

    return {
        stateRevision: snapshotVersion,
        principal,
        instances: [instance],
        activeSessions: [session],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: snapshotVersion,
    };
}

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
