import { computeMatchmaking } from '@shared-server/rallar-system/matchmaking/compute-matchmaking.ts';
import type { MatchmakingIntent } from '@shared-server/rallar-system/matchmaking/matchmaking-pool.ts';
import { MatchmakingReader } from '@shared-server/rallar-system/matchmaking/matchmaking-reader.ts';
import type { MatchmakingRepository } from '@shared-server/rallar-system/matchmaking/matchmaking-repository.ts';
import { describe, expect, it } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const policy = { players: 2, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 };

describe('private matchmaking recovery view', () => {
    it('exposes only the requesting account cohort and never session authority or a prospective room', async () => {
        let pool: MatchmakingRepository.Current['pool'] = { scope, searching: [], proposals: [] };
        for (const principalId of ['alice', 'bob', 'carol']) {
            pool = computeMatchmaking({ pool, policy, nowEpochMs: 1000, command: start(principalId) }).pool;
        }
        const reader = new MatchmakingReader({ readCurrent: async () => ({ pool, searchId: 'alice-search', finished: null }) }, () => 1001);
        const snapshot = await reader.read({ scope, principalId: 'alice' });
        expect(snapshot.state).toEqual({
            status: 'confirming',
            searchId: 'alice-search',
            expiresAtEpochMs: 31000,
            leaderPrincipalId: 'alice',
            players: [{ principalId: 'alice', confirmed: false }, { principalId: 'bob', confirmed: false }]
        });
        expect(JSON.stringify(snapshot)).not.toMatch(/session|carol|match-alice-search/);
    });

    it('shows expiry at the deadline even if the durable worker has not run', async () => {
        const pool = computeMatchmaking({ pool: { scope, searching: [], proposals: [] }, policy, nowEpochMs: 1000, command: start('alice') }).pool;
        const reader = new MatchmakingReader({ readCurrent: async () => ({ pool, searchId: 'alice-search', finished: null }) }, () => 121000);
        expect((await reader.read({ scope, principalId: 'alice' })).state).toEqual({ status: 'ended', searchId: 'alice-search', reason: 'search-timeout' });
        expect(pool.searching).toHaveLength(1);
    });
});

function start(principalId: string): MatchmakingIntent {
    return {
        action: 'start',
        searchId: `${principalId}-search`,
        principalId,
        sessionId: `secret-session-${principalId}`,
        sessionIssuedAtEpochMs: 1,
        sessionExpiresAtEpochMs: 600000,
        capturedAtEpochMs: 1000
    };
}
