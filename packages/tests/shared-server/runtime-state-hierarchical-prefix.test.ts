import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { createTestClientStateRepository, createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { ClientInstance, ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceSession } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../create-test-group.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('runtime-state hierarchical prefix isolation', () => {
    it('keeps sibling workspace identifiers isolated', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const clients = createTestClientStateRepository(runtime);
        const groups = createTestGroupStateRepository(runtime);

        await expect(clients.insertPrincipal(clientPrincipal('foo', 'alice')))
            .resolves.toMatchObject({ status: 'applied' });
        await expect(clients.insertPrincipal(clientPrincipal('foobar', 'bob')))
            .resolves.toMatchObject({ status: 'applied' });
        await groups.putGroup(group('foo', 'room'));
        await groups.putGroup(group('foobar', 'room'));
        await groups.putMember(groupMember('room', 'owner', 'foo'));
        await groups.putMember(groupMember('room', 'owner', 'foobar'));

        expect((await clients.listPrincipals(scope('foo'))).map((item) => item.workspaceId)).toEqual(['foo']);
        expect((await clients.listSnapshots(scope('foo'))).map((item) => item.principal.workspaceId)).toEqual(['foo']);
        expect((await groups.listGroups(scope('foo'))).map((item) => item.workspaceId)).toEqual(['foo']);
        expect((await groups.listSnapshots(scope('foo'))).map((item) => item.group.workspaceId)).toEqual(['foo']);
    });

    it('keeps sibling principal and client-instance identifiers isolated', async () => {
        const repository = createTestClientStateRepository(new FakeRuntimeStateRepository());

        await expect(repository.insertInstance(clientInstance('alice', 'phone')))
            .resolves.toMatchObject({ status: 'applied' });
        await expect(repository.insertInstance(clientInstance('alice-2', 'tablet')))
            .resolves.toMatchObject({ status: 'applied' });
        await expect(repository.insertSession(clientSession('alice', 'phone', 'session')))
            .resolves.toMatchObject({ status: 'applied' });
        await expect(repository.insertSession(clientSession('alice', 'phone-2', 'session-2')))
            .resolves.toMatchObject({ status: 'applied' });
        await expect(repository.insertSession(clientSession('alice-2', 'phone', 'session-3')))
            .resolves.toMatchObject({ status: 'applied' });

        expect((await repository.listInstances(principalRef('alice'))).map((item) => item.principalId)).toEqual(['alice']);
        expect((await repository.listSessionsForPrincipal(principalRef('alice'))).map((item) => item.principalId)).toEqual(['alice', 'alice']);
        expect((await repository.listSessions(instanceRef('alice', 'phone'))).map((item) => item.clientInstanceId)).toEqual(['phone']);
    });

    it('keeps sibling group identifiers isolated for members and sessions', async () => {
        const repository = createTestGroupStateRepository(new FakeRuntimeStateRepository());

        await repository.putMember(groupMember('room', 'alice'));
        await repository.putMember(groupMember('room-2', 'bob'));
        await repository.putPresenceSession(groupSession('room', 'session'));
        await repository.putPresenceSession(groupSession('room-2', 'session-2'));

        expect((await repository.listMembers(groupRef('room'))).map((item) => item.groupId)).toEqual(['room']);
        expect((await repository.listPresenceSessions(groupRef('room'))).map((item) => item.groupId)).toEqual(['room']);
    });
});

const scope = (workspaceId: string) => ({ applicationId: 'app', workspaceId });
const principalRef = (principalId: string) => ({ ...scope('workspace'), principalId });
const instanceRef = (principalId: string, clientInstanceId: string) => ({ ...principalRef(principalId), clientInstanceId });
const groupRef = (groupId: string) => ({ ...scope('workspace'), groupId });

function clientPrincipal(
    workspaceId: string,
    principalId: string
): ClientPrincipal {
    return {
        ...scope(workspaceId),
        principalId,
        username: principalId,
        displayName: null,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        status: 'active',
        roles: [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: auditStamp,
        updated: auditStamp,
        disabled: null,
        deleted: null,
        lastSeenAtEpochMs: null
    };
}

function clientInstance(
    principalId: string,
    clientInstanceId: string
): ClientInstance {
    return {
        ...instanceRef(principalId, clientInstanceId),
        platform: 'unknown',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        status: 'active',
        registered: auditStamp,
        updated: auditStamp,
        revoked: null
    };
}

function clientSession(
    principalId: string,
    clientInstanceId: string,
    sessionId: string
): ClientSession {
    return {
        ...instanceRef(principalId, clientInstanceId),
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 4_102_444_800_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function group(workspaceId: string, groupId: string): Group {
    return createTestGroup({
        ...scope(workspaceId),
        groupId,
        displayName: groupId,
        ownerPrincipalId: 'owner',
        activeMemberCount: 1,
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: auditStamp,
        updated: auditStamp
    });
}

function groupMember(
    groupId: string,
    principalId: string,
    workspaceId = 'workspace'
): GroupMember {
    return {
        ...scope(workspaceId),
        groupId,
        principalId,
        role: 'owner',
        status: 'active',
        joined: auditStamp,
        updated: auditStamp,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

function groupSession(groupId: string, sessionId: string): GroupPresenceSession {
    return {
        ...groupRef(groupId),
        sessionId,
        principalId: 'alice',
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 4_102_444_800_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

const auditStamp: AuditStamp = {
    atEpochMs: 1,
    actor: { kind: 'service', serviceId: 'hierarchy-prefix-test' },
    reason: null,
    traceId: null,
    requestId: null
};
