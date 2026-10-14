import {
    describe,
    expect,
    it
} from 'vitest';

import {
    resolveBlackBoxRallarMessagePeer,
    resolveBlackBoxRallarRecipientPeer
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/resolve-black-box-rallar-message-peer.ts';

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
        const nobodyElse = resolveBlackBoxRallarMessagePeer({
            ...input,
            toPeer: 'receiver',
            roomSessions: [toRoomRosterSession('sender-session')]
        });
        const twoOthers = resolveBlackBoxRallarMessagePeer({
            ...input,
            toPeer: 'receiver',
            roomSessions: ['sender-session', 'receiver-session', 'recipient-b-session'].map((id) => toRoomRosterSession(id))
        });

        expect(withoutServer.left).toBe('the WS server named no peer id');
        expect(withoutRoster.left).toBe('the page holds no snapshot of the room');
        expect(nobodyElse.left).toBe('the room holds 0 other live sessions, not exactly one');
        expect(twoOthers.left).toBe('the room holds 2 other live sessions, not exactly one');
    });
});

describe('the lane role a messages.send lists as its fixed audience', () => {
    const nowMs = Date.now();
    const input = {
        recipientPeer: 'receiver' as const,
        ownSessionId: 'sender-session',
        ownPrincipalId: 'alice',
        leaderSessionId: undefined,
        nowMs
    };
    const sibling = toRoomRosterSession('sibling-session', { principalId: 'alice' });

    it('names the receiver as the one other live session of another principal, beside a second session of the sender\'s', () => {
        const roomSessions = [
            toRoomRosterSession('sender-session', { principalId: 'alice' }),
            sibling,
            toRoomRosterSession('receiver-session', { principalId: 'bob' }),
            toRoomRosterSession('left-session', { principalId: 'carol', status: 'disconnected' })
        ];

        expect(resolveBlackBoxRallarRecipientPeer({ ...input, roomSessions }).right).toBe('receiver-session');
    });

    it('states, as a value, a list that no one session of another principal answers', () => {
        const withoutRoster = resolveBlackBoxRallarRecipientPeer({ ...input, roomSessions: undefined });
        const onlyTheSibling = resolveBlackBoxRallarRecipientPeer({ ...input, roomSessions: [sibling] });
        const twoOthers = resolveBlackBoxRallarRecipientPeer({
            ...input,
            roomSessions: [
                sibling,
                toRoomRosterSession('receiver-session', { principalId: 'bob' }),
                toRoomRosterSession('recipient-b-session', { principalId: 'carol' })
            ]
        });

        expect(withoutRoster.left).toBe('the page holds no snapshot of the room');
        expect(onlyTheSibling.left).toBe('the room holds 0 other live sessions of another principal, not exactly one');
        expect(twoOthers.left).toBe('the room holds 2 other live sessions of another principal, not exactly one');
    });

    it('names recipient-b as the one other live session of another principal that is not the room\'s leader', () => {
        const roomSessions = [
            toRoomRosterSession('sender-session', { principalId: 'alice' }),
            toRoomRosterSession('receiver-session', { principalId: 'bob' }),
            toRoomRosterSession('recipient-b-session', { principalId: 'carol' })
        ];
        const recipientB = { ...input, recipientPeer: 'recipient-b' as const, roomSessions };

        expect(resolveBlackBoxRallarRecipientPeer({ ...recipientB, leaderSessionId: 'receiver-session' }).right)
            .toBe('recipient-b-session');
        expect(resolveBlackBoxRallarRecipientPeer({ ...recipientB, leaderSessionId: undefined }).left)
            .toBe('the room holds 2 other live sessions of another principal beside its leader, not exactly one');
        expect(resolveBlackBoxRallarRecipientPeer({ ...input, roomSessions, leaderSessionId: 'receiver-session' }).left)
            .toBe('the room holds 2 other live sessions of another principal, not exactly one');
    });
});
