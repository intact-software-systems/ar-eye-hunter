import { describe, expect, it } from 'vitest';

import {
    AL_MESSAGE_ENVELOPE_VERSION,
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    toALGroupTargetKey
} from '@shared/al-contracts/al-contract.ts';
import { decodeALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROUTE = newALRoute('room.app.command', 'room-1', 'resource-1');

describe('a room send stamped with its sender roster', () => {
    it('carries the roster beside the snapshot floor on a multicast, and no ordering epoch', () => {
        const message = newALMulticastMessage('a', ROUTE, ROOM, 'app.command.v1', { go: true }, {
            minSnapshotVersion: 7,
            rosterVersion: 4,
            seq: 1
        });

        expect(message.id.v).toBe(AL_MESSAGE_ENVELOPE_VERSION);
        expect(message.targets).toMatchObject({ mode: 'multicast', groupRef: ROOM, minSnapshotVersion: 7, rosterVersion: 4 });
        expect(message.ordering).toEqual({ orderingKey: toALGroupTargetKey(ROOM), seq: 1 });
        expect(decodeALMessage(JSON.stringify(message)).right).toEqual(JSON.parse(JSON.stringify(message)));
    });

    it('opens no ordering section on an unordered multicast', () => {
        const message = newALMulticastMessage('a', ROUTE, ROOM, 'app.command.v1', {}, { rosterVersion: 4 });

        expect(message.ordering).toBeUndefined();
    });

    it('carries the roster beside the snapshot floor on a room broadcast', () => {
        const message = newALBroadcastMessage('a', ROUTE, 'room', 'app.command.v1', {}, {
            groupRef: ROOM,
            minSnapshotVersion: 7,
            rosterVersion: 4
        });

        expect(message.id.v).toBe(AL_MESSAGE_ENVELOPE_VERSION);
        expect(message.targets).toMatchObject({ mode: 'broadcast', scope: 'room', minSnapshotVersion: 7, rosterVersion: 4 });
        expect(decodeALMessage(JSON.stringify(message)).left).toBeUndefined();
    });
});
