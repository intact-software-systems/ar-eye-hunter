import { decodeMatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import { describe, expect, it } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const view = { scope, principalId: 'alice', observedAtEpochMs: 1000 };

describe('matchmaking response boundary', () => {
    it('decodes private searching, confirmation and committed destination views', () => {
        for (
            const state of [
                { status: 'idle' },
                { status: 'searching', searchId: 'alice-search', expiresAtEpochMs: 121000 },
                {
                    status: 'confirming',
                    searchId: 'alice-search',
                    expiresAtEpochMs: 31000,
                    leaderPrincipalId: 'alice',
                    players: [{ principalId: 'alice', confirmed: true }, { principalId: 'bob', confirmed: false }]
                },
                { status: 'matched', searchId: 'alice-search', roomRef: { ...scope, groupId: 'match-alice-search' }, leaderPrincipalId: 'alice' },
                { status: 'ended', searchId: 'alice-search', reason: 'declined' }
            ]
        ) {
            expect(decodeMatchmakingSnapshot({ ...view, state })).toEqual({ ...view, state });
        }
    });

    it('rejects wrong-scope destinations, unrelated cohorts and leaked authority', () => {
        for (
            const state of [
                { status: 'matched', searchId: 'alice-search', roomRef: { ...scope, applicationId: 'other', groupId: 'room' }, leaderPrincipalId: 'alice' },
                {
                    status: 'confirming',
                    searchId: 'alice-search',
                    expiresAtEpochMs: 31000,
                    leaderPrincipalId: 'bob',
                    players: [{ principalId: 'bob', confirmed: false }, { principalId: 'carol', confirmed: false }]
                },
                { status: 'searching', searchId: 'alice-search', expiresAtEpochMs: 121000, sessionId: 'private' },
                { status: 'ended', searchId: 'alice-search', reason: 'matched' }
            ]
        ) {
            expect(() => decodeMatchmakingSnapshot({ ...view, state })).toThrow();
        }
    });
});
