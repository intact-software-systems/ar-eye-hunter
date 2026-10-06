import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey, toALSequenceMintTrackKey } from '@shared/al-contracts/al-runtime.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROUTE = newALRoute('room.app.event', 'room-1', 'game-1:2');

describe('a room broadcast that names its ordering', () => {
    it('writes the key, the epoch and the sequence it names', () => {
        const message = newALBroadcastMessage('server', ROUTE, 'room', 'app.event.v1', {}, {
            groupRef: ROOM,
            ordering: { orderingKey: 'game-1', epoch: 2, seq: 5 }
        });

        expect(message.ordering).toEqual({ orderingKey: 'game-1', epoch: 2, seq: 5 });
        expect(toALOrderingTrackKey(message)).toBe('game-1:server:2');
        expect(toALSequenceMintTrackKey(message)).toBeUndefined();
        expect(decodeALMessage(JSON.stringify(message)).left).toBeUndefined();
    });

    it('leaves the sequence to its outbound when it names only the key and the epoch', () => {
        const message = newALBroadcastMessage('server', ROUTE, 'room', 'app.event.v1', {}, {
            groupRef: ROOM,
            ordering: { orderingKey: 'game-1', epoch: 2 }
        });

        expect(JSON.parse(JSON.stringify(message.ordering))).toEqual({ orderingKey: 'game-1', epoch: 2 });
        expect(toALOrderingTrackKey(message)).toBeUndefined();
        expect(toALSequenceMintTrackKey(message)).toBe('game-1:server:2');
        expect(decodeALMessage(JSON.stringify(message)).left).toBeUndefined();
    });

    it('names epoch 0 for a track whose message states no epoch', () => {
        const message = newALBroadcastMessage('server', ROUTE, 'room', 'app.event.v1', {}, {
            groupRef: ROOM,
            ordering: { orderingKey: 'game-1' }
        });

        expect(toALSequenceMintTrackKey(message)).toBe('game-1:server:0');
    });
});
