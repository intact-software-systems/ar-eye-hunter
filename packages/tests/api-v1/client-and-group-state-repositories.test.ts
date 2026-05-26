import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type {
    ClientEvent,
    ClientInstance,
    ClientPrincipal,
    ClientSession,
} from '@shared/api/client-types.ts';
import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
} from '@shared/api/group-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

describe('ClientStateRepository', () => {
    it('stores durable client records, expires sessions, and assembles snapshots', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository);
        const now = Date.now();

        const principal = createClientPrincipal();
        const instanceA = createClientInstance('instance-a');
        const instanceB = createClientInstance('instance-b');
        const activeSession = createClientSession('instance-a', 'session-a', {
            expiresAtEpochMs: now + 60_000,
            lastHeartbeatAtEpochMs: now - 500,
            presenceState: 'busy',
        });
        const expiredSession = createClientSession('instance-b', 'session-b', {
            expiresAtEpochMs: now - 1,
            lastHeartbeatAtEpochMs: now - 1_000,
        });

        await clientRepository.putPrincipal(principal);
        await clientRepository.putInstance(instanceA);
        await clientRepository.putInstance(instanceB);
        await clientRepository.putSession(activeSession);
        await clientRepository.putSession(expiredSession);
        await clientRepository.appendEvent(createClientEvent('evt-2', now + 2_000));
        await clientRepository.appendEvent(createClientEvent('evt-1', now + 1_000));

        expect(
            await clientRepository.findSession({
                applicationId: principal.applicationId,
                workspaceId: principal.workspaceId,
                principalId: principal.principalId,
                clientInstanceId: 'instance-b',
                sessionId: 'session-b',
            }),
        ).toEqual(expiredSession);

        expect(
            await clientRepository.listPrincipals({
                applicationId: principal.applicationId,
                workspaceId: principal.workspaceId,
            }),
        ).toEqual([principal]);

        const presence = await clientRepository.readPresenceSnapshot({
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId,
        });

        expect(presence).toEqual({
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId,
            presenceVersion: principal.presenceVersion,
            isOnline: true,
            presenceState: 'busy',
            activeSessions: [activeSession],
            lastSeenAtEpochMs: activeSession.lastHeartbeatAtEpochMs,
        });

        const snapshot = await clientRepository.readSnapshot({
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId,
        });

        expect(snapshot?.principal).toEqual(principal);
        expect(snapshot?.instances).toEqual([instanceA, instanceB]);
        expect(snapshot?.activeSessions).toEqual([activeSession]);
        expect(snapshot?.activeSessionCount).toBe(1);
        expect(snapshot?.isOnline).toBe(true);
        expect(
            await clientRepository.listEvents({
                applicationId: principal.applicationId,
                workspaceId: principal.workspaceId,
                principalId: principal.principalId,
            }),
        ).toEqual([
            createClientEvent('evt-1', now + 1_000),
            createClientEvent('evt-2', now + 2_000),
        ]);

        expect(repository.findStoredEntry('client-state:principals')).toMatchObject({
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
        });
    });
});

describe('GroupStateRepository', () => {
    it('stores groups by scope, supports slug lookup, and assembles group snapshots', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository);
        const now = Date.now();

        const group = createGroup();
        const activeMember = createGroupMember('principal-a', 'active');
        const invitedMember = createGroupMember('principal-b', 'invited');
        const activeSession = createGroupSession('principal-a', 'session-a', {
            expiresAtEpochMs: now + 60_000,
        });
        const disconnectedSession = createGroupSession('principal-b', 'session-b', {
            expiresAtEpochMs: now + 60_000,
            disconnectedAtEpochMs: now - 10,
            disconnectReason: 'closed',
        });
        const expiredSession = createGroupSession('principal-c', 'session-c', {
            expiresAtEpochMs: now - 1,
        });

        await groupRepository.putGroup(group);
        await groupRepository.putMember(activeMember);
        await groupRepository.putMember(invitedMember);
        await groupRepository.putPresenceSession(activeSession);
        await groupRepository.putPresenceSession(disconnectedSession);
        await groupRepository.putPresenceSession(expiredSession);
        await groupRepository.appendEvent(createGroupEvent('evt-2', now + 2_000));
        await groupRepository.appendEvent(createGroupEvent('evt-1', now + 1_000));

        expect(
            await groupRepository.findPresenceSession({
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                groupId: group.groupId,
                sessionId: 'session-c',
            }),
        ).toEqual(expiredSession);

        expect(
            await groupRepository.findGroupBySlug(
                {
                    applicationId: group.applicationId,
                    workspaceId: group.workspaceId,
                },
                'party-1',
            ),
        ).toEqual(group);

        const snapshot = await groupRepository.readSnapshot({
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            groupId: group.groupId,
        });

        expect(snapshot).toEqual({
            group,
            members: [activeMember, invitedMember],
            activeSessions: [activeSession],
            memberCount: 1,
            onlineMemberCount: 1,
        });

        expect(
            await groupRepository.listEvents({
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                groupId: group.groupId,
            }),
        ).toEqual([createGroupEvent('evt-1', now + 1_000), createGroupEvent('evt-2', now + 2_000)]);
    });
});

function createClientPrincipal(): ClientPrincipal {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        username: 'alice',
        displayName: 'Alice',
        status: 'active',
        roles: ['member'],
        metadata: {},
        snapshotVersion: 3,
        profileVersion: 1,
        presenceVersion: 2,
        created: { atEpochMs: 1, byServiceId: 'seed' },
        updated: { atEpochMs: 2, byServiceId: 'seed' },
    };
}

function createClientInstance(clientInstanceId: string): ClientInstance {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        clientInstanceId,
        status: 'active',
        platform: 'web',
        capabilities: ['rtc'],
        registered: { atEpochMs: 1, byServiceId: 'seed' },
        updated: { atEpochMs: 2, byServiceId: 'seed' },
    };
}

function createClientSession(
    clientInstanceId: string,
    sessionId: string,
    overrides: Partial<ClientSession> = {},
): ClientSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        clientInstanceId,
        sessionId,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        authenticatedAtEpochMs: 10,
        connectedAtEpochMs: 20,
        lastHeartbeatAtEpochMs: 30,
        expiresAtEpochMs: Date.now() + 60_000,
        ...overrides,
    };
}

function createClientEvent(eventId: string, occurredAtEpochMs: number): ClientEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        eventId,
        eventType: 'session-connected',
        clientInstanceId: 'instance-a',
        sessionId: 'session-a',
        snapshotVersion: occurredAtEpochMs,
        occurredAtEpochMs,
        actor: { serviceId: 'seed' },
    };
}

function createGroup(): Group {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        slug: 'party-1',
        displayName: 'Party 1',
        kind: 'party',
        status: 'active',
        joinMode: 'invite-only',
        metadata: {},
        snapshotVersion: 6,
        metadataVersion: 1,
        rosterVersion: 2,
        presenceVersion: 3,
        created: { atEpochMs: 1, byServiceId: 'seed' },
        updated: { atEpochMs: 2, byServiceId: 'seed' },
    };
}

function createGroupMember(principalId: string, status: GroupMember['status']): GroupMember {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        principalId,
        role: 'member',
        status,
        joined: { atEpochMs: 1, byServiceId: 'seed' },
        updated: { atEpochMs: 2, byServiceId: 'seed' },
    };
}

function createGroupSession(
    principalId: string,
    sessionId: string,
    overrides: Partial<GroupPresenceSession> = {},
): GroupPresenceSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        principalId,
        sessionId,
        connectedAtEpochMs: 10,
        lastHeartbeatAtEpochMs: 20,
        expiresAtEpochMs: Date.now() + 60_000,
        ...overrides,
    };
}

function createGroupEvent(eventId: string, occurredAtEpochMs: number): GroupEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        eventId,
        eventType: 'session-connected',
        snapshotVersion: occurredAtEpochMs,
        occurredAtEpochMs,
        actor: { serviceId: 'seed' },
    };
}

class FakeRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return await fn(this);
    }

    async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toKey(namespace, key));
        return entry ? { ...entry } : undefined;
    }

    async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return [...this.data.entries()]
            .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        return [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix),
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0,
        });
    }

    async deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
    }

    async deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;

        for (const [compositeKey, entry] of this.data.entries()) {
            if (this.toNamespace(compositeKey) !== namespace) {
                continue;
            }

            if (entry.expireAtTimestamp > Date.now()) {
                continue;
            }

            this.data.delete(compositeKey);
            deleted += 1;
        }

        return deleted;
    }

    async lockKey(_namespace: string, _key: string): Promise<void> {}

    findStoredEntry(namespace: string): RuntimeStateEntry | undefined {
        return [...this.data.entries()].find(
            ([compositeKey]) => this.toNamespace(compositeKey) === namespace,
        )?.[1];
    }

    private toKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    private toNamespace(compositeKey: string): string {
        return compositeKey.split('::', 1)[0] ?? '';
    }

    private toStoreKey(compositeKey: string): string {
        return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
    }
}
