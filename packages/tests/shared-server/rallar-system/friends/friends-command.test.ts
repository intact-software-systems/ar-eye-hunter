import { describe, expect, it } from 'vitest';

import { decodeFriendsCommand, decodeFriendsResult } from '@shared-server/rallar-system/friends/friends-command.ts';
import { decodeFriendsRequest } from '@shared/api/friends/friends-request.ts';

const command = {
    principalId: 'alice',
    sessionId: 'session-a',
    sessionIssuedAtEpochMs: 1,
    sessionExpiresAtEpochMs: 1000,
    requestId: 'request-1',
    capturedAtEpochMs: null,
    request: { action: 'request', username: 'bob' }
};

describe('friends command and replay boundaries', () => {
    it('accepts exact commands while rejecting authority injection and malformed actions', () => {
        expect(decodeFriendsCommand(command)).toEqual(command);
        for (
            const request of [
                { action: 'request', username: 'bob', principalId: 'admin' },
                { action: 'visibility', shareOnline: 'false' },
                { action: 'accept', principalId: '' },
                { action: 'promote', principalId: 'bob' },
                { action: 'invite', principalId: 'bob', kind: 'room', roomRef: { groupId: 'arena' } }
            ]
        ) {
            expect(() => decodeFriendsRequest(request)).toThrow();
        }
        expect(() => decodeFriendsCommand({ ...command, capturedAtEpochMs: -1 })).toThrow();
        expect(() => decodeFriendsCommand({ ...command, sessionExpiresAtEpochMs: 1 })).toThrow();
    });

    it('binds durable results to the original actor and request without accepting extra fields', () => {
        const decoded = decodeFriendsCommand(command);
        const result = { principalId: 'alice', requestId: 'request-1', status: 'applied' };
        expect(decodeFriendsResult(result, decoded)).toEqual(result);
        expect(() => decodeFriendsResult({ ...result, principalId: 'bob' }, decoded)).toThrow();
        expect(() => decodeFriendsResult({ ...result, requestId: 'other' }, decoded)).toThrow();
        expect(() => decodeFriendsResult({ ...result, contacts: [] }, decoded)).toThrow();
        expect(() => decodeFriendsResult({ ...result, status: 'refused', code: 'made-up' }, decoded)).toThrow();
    });
});
