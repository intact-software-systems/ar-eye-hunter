import {
    describe,
    expect,
    it
} from 'vitest';

import { resolveBlackBoxRallarMessagePeer } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/resolve-black-box-rallar-message-peer.ts';

import { toRoomRosterSession } from './browser-runtime-facade-test-double.ts';

describe('the lane role a messages.send addresses (C11)', () => {
    const nowMs = Date.now();
    const input = { serverPeerId: 'server-peer', ownSessionId: 'sender-session', nowMs };

    it('names the server by the peer id it answers as', () => {
        expect(
            resolveBlackBoxRallarMessagePeer({
                ...input,
                toPeer: 'server',
                roomSessions: undefined
            }).right
        )
            .toBe('server-peer');
    });

    it('names the receiver as the one other live session of the room, whatever principal it logged in as', () => {
        const roomSessions = [
            toRoomRosterSession('sender-session'),
            toRoomRosterSession('receiver-session'),
            toRoomRosterSession('left-session', { status: 'disconnected' }),
            toRoomRosterSession('lapsed-session', { expiresAtEpochMs: nowMs })
        ];

        expect(
            resolveBlackBoxRallarMessagePeer({ ...input, toPeer: 'receiver', roomSessions }).right
        )
            .toBe('receiver-session');
    });

    it('states, as a value, a role that no one peer answers', () => {
        const withoutServer = resolveBlackBoxRallarMessagePeer({
            ...input,
            serverPeerId: undefined,
            toPeer: 'server',
            roomSessions: undefined
        });
        const withoutRoster = resolveBlackBoxRallarMessagePeer({
            ...input,
            toPeer: 'receiver',
            roomSessions: undefined
        });
        const twoOthers = resolveBlackBoxRallarMessagePeer({
            ...input,
            toPeer: 'receiver',
            roomSessions: ['sender-session', 'receiver-session', 'recipient-b-session'].map((id) => toRoomRosterSession(id))
        });

        expect(withoutServer.left).toBe('the WS server named no peer id');
        expect(withoutRoster.left).toBe('the room holds 0 other live sessions, not exactly one');
        expect(twoOthers.left).toBe('the room holds 2 other live sessions, not exactly one');
    });
});
