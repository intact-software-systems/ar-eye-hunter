import { describe, expect, it } from 'vitest';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('runtime-state hierarchical prefix isolation', () => {
    it('keeps sibling workspace identifiers isolated', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const clients = new ClientStateRepository(runtime);
        const groups = new GroupStateRepository(runtime);

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
        const repository = new ClientStateRepository(new FakeRuntimeStateRepository());

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
        const repository = new GroupStateRepository(new FakeRuntimeStateRepository());

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

const clientPrincipal = (workspaceId: string, principalId: string) => ({ ...scope(workspaceId), principalId, presenceVersion: 1 }) as never;
const clientInstance = (principalId: string, clientInstanceId: string) => ({ ...instanceRef(principalId, clientInstanceId), presenceVersion: 1 }) as never;
const clientSession = (principalId: string, clientInstanceId: string, sessionId: string) => ({ ...instanceRef(principalId, clientInstanceId), sessionId, expiresAtEpochMs: Date.now() + 60_000 }) as never;
const group = (workspaceId: string, groupId: string) => ({
    ...scope(workspaceId),
    groupId,
    status: 'active',
    ownerPrincipalId: 'owner',
    activeMemberCount: 1,
}) as never;
const groupMember = (
    groupId: string,
    principalId: string,
    workspaceId = 'workspace',
) => ({
    ...scope(workspaceId),
    groupId,
    principalId,
    role: 'owner',
    status: 'active',
}) as never;
const groupSession = (groupId: string, sessionId: string) => ({ ...groupRef(groupId), sessionId, expiresAtEpochMs: Date.now() + 60_000 }) as never;
