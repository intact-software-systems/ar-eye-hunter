import { describe, expect, it } from 'vitest';

import {
    isRoomScopedALMessage,
    newALRoute,
    newALUnicastMessage,
    readALTargetGroupRef
} from '@shared/al-contracts/al-contract.ts';
import {
    decodeALMessage,
    decodePersistedALMessage
} from '@shared/al-contracts/al-message-persistence-validation.ts';
import { isALUnicastAddressedTo } from '@shared/al-contracts/is-al-unicast-addressed-to.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROUTE = newALRoute('app.command', 'room-1', 'resource-1');

describe('a unicast that names its room (D53, S3c-i C1)', () => {
    it('carries the room and the delivery it was built with, and is room-scoped', () => {
        const message = newALUnicastMessage('a', ROUTE, 'b', 'app.command.v1', { go: true }, {
            groupRef: ROOM,
            ttlMs: 30_000,
            reliability: 'at-least-once',
            ack: 'receiver',
            ownership: 'shared'
        });

        expect(message.targets).toEqual({ mode: 'unicast', toPeerId: 'b', groupRef: ROOM });
        expect(message.delivery).toEqual({
            ownership: 'shared',
            reliability: 'at-least-once',
            ack: 'receiver'
        });
        expect(readALTargetGroupRef(message)).toEqual(ROOM);
        expect(isRoomScopedALMessage(message)).toBe(true);
    });

    it('keeps a unicast built without a room or a delivery exactly as before', () => {
        const message = newALUnicastMessage('a', ROUTE, 'b', 'app.command.v1', { go: true }, {
            ttlMs: 30_000
        });

        expect(message.targets).toEqual({ mode: 'unicast', toPeerId: 'b' });
        expect(message.delivery).toBeUndefined();
        expect(readALTargetGroupRef(message)).toBeUndefined();
        expect(isRoomScopedALMessage(message)).toBe(false);
    });

    it('decodes a room-naming unicast live and persisted, and refuses one whose room is not canonical', () => {
        const message = newALUnicastMessage('a', ROUTE, 'b', 'app.command.v1', {}, {
            groupRef: ROOM,
            ttlMs: 30_000
        });
        const serialized = JSON.stringify(message);
        const loose = JSON.stringify({
            ...message,
            targets: { mode: 'unicast', toPeerId: 'b', groupRef: { groupId: 'room-1' } }
        });

        expect(decodeALMessage(serialized).right).toEqual(message);
        expect(decodePersistedALMessage(serialized)).toEqual(message);
        expect(decodeALMessage(loose).left).toEqual({
            code: 'malformed',
            message: 'Persisted AL group workspace id is missing'
        });
    });

    it('names a unicast addressed to exactly one peer', () => {
        const toServer = newALUnicastMessage('a', ROUTE, 'server', 'app.command.v1', {}, {
            groupRef: ROOM
        });

        expect(isALUnicastAddressedTo(toServer, 'server')).toBe(true);
        expect(isALUnicastAddressedTo(toServer, 'b')).toBe(false);
        expect(
            isALUnicastAddressedTo({
                ...toServer,
                targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM }
            }, 'server')
        )
            .toBe(false);
    });
});
