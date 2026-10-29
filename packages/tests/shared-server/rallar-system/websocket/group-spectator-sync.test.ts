import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { newALEventRoute, newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { describe, expect, it } from 'vitest';
import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

const snapshot = createGroupSnapshot(2, ['watcher']);
const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' };
const sync = {
    protocol: 'rallar.director.relay.v1',
    topicId: 'game.match',
    typeId: 'rallar.game.snapshot-request.v1',
    roomId: 'group-1',
    epoch: 1,
    sentAtEpochMs: 100,
    payload: {
        protocol: 'test.game.v1',
        kind: 'sync-request',
        roomRef,
        senderId: 'watcher',
        seq: 1,
        sentAtEpochMs: 100,
        directorEpoch: 1,
        payload: { reason: 'watch' }
    }
};

async function authorize(resource: object, typeId = sync.typeId) {
    const authorizer = createGroupRoomWsAuthorizer({
        readGroupSnapshot: async () => ({
            ...snapshot,
            members: snapshot.members.map((member) =>
                member.principalId === 'principal-watcher'
                    ? { ...member, role: 'spectator' as const }
                    : member
            )
        }),
        readPreActivationAppData: async () => 'allowed' as const,
        nowEpochMs: () => 100
    });
    return authorizer({
        message: newALMulticastMessage('watcher', newALEventRoute('game.match', 'group-1', 'request'), roomRef, typeId, resource),
        roomId: 'group-1',
        roomRef,
        senderId: 'watcher',
        topicId: 'game.match',
        typeId
    });
}

describe('spectator snapshot request admission', () => {
    it('admits the exact read-only protocol and keeps the current live room audience', async () => {
        expect(await authorize(sync)).toMatchObject({ authorized: true, audience: { sessions: snapshot.activeSessions } });
    });

    it.each([
        { ...sync, typeId: 'game.match.intent.v1' },
        { ...sync, payload: { ...sync.payload, kind: 'intent' } },
        { ...sync, payload: { ...sync.payload, senderId: 'another-session' } },
        { ...sync, payload: { ...sync.payload, roomRef: { ...roomRef, workspaceId: 'other' } } },
        { ...sync, payload: { ...sync.payload, payload: { action: 'start' } } },
        { ...sync, payload: { ...sync.payload, directorEpoch: 2 } }
    ])('refuses a forged or state-changing request', async (resource) => {
        expect(await authorize(resource)).toMatchObject({ authorized: false });
    });

    it('does not grant permission to an application-selected sync type', async () => {
        expect(await authorize(sync, 'game.match.sync-request.v1')).toMatchObject({ authorized: false });
    });
});
