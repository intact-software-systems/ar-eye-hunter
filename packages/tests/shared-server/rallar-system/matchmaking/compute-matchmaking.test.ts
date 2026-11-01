import { describe, expect, it } from 'vitest';

import { computeMatchmaking } from '../../../../shared-server/rallar-system/matchmaking/compute-matchmaking.ts';
import type { MatchmakingPool, MatchmakingTransition } from '../../../../shared-server/rallar-system/matchmaking/matchmaking-pool.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const policy = { players: 2, searchTimeoutMs: 120_000, confirmationTimeoutMs: 30_000, maxSearching: 256 };
const sessionLifetime = { sessionIssuedAtEpochMs: 1, sessionExpiresAtEpochMs: 8_000_000_000_000 };

function emptyPool(): MatchmakingPool {
    return { scope, searching: [], proposals: [] };
}

function start(pool: MatchmakingPool, principalId: string, at: number): MatchmakingTransition {
    return computeMatchmaking({
        pool,
        policy,
        nowEpochMs: at,
        command: {
            action: 'start',
            principalId,
            sessionId: `session-${principalId}`,
            ...sessionLifetime,
            searchId: `search-${principalId}`,
            capturedAtEpochMs: at
        }
    });
}

interface CommandInput {
    readonly pool: MatchmakingPool;
    readonly action: 'confirm' | 'cancel';
    readonly principalId: string;
    readonly nowEpochMs: number;
    readonly searchId?: string;
}

function command(input: CommandInput): MatchmakingTransition {
    const { pool, action, principalId, nowEpochMs, searchId = `search-${input.principalId}` } = input;
    return computeMatchmaking({
        pool,
        policy,
        nowEpochMs,
        command: { action, principalId, sessionId: `session-${principalId}`, ...sessionLifetime, searchId, capturedAtEpochMs: nowEpochMs }
    });
}

describe('matchmaking cohort intent', () => {
    it('waits explicitly, then reserves one cohort without admitting either player', () => {
        const first = start(emptyPool(), 'alice', 1000);
        expect(first.pool.searching).toMatchObject([{ principalId: 'alice', expiresAtEpochMs: 121_000 }]);
        expect(first.admission).toBeNull();
        const second = start(first.pool, 'bob', 2000);
        expect(second.pool.searching).toEqual([]);
        expect(second.pool.proposals).toMatchObject([{
            leaderPrincipalId: 'alice',
            expiresAtEpochMs: 32_000,
            participants: [
                { principalId: 'alice', confirmedAtEpochMs: null },
                { principalId: 'bob', confirmedAtEpochMs: null }
            ]
        }]);
        expect(second.admission).toBeNull();
        expect(second.finished).toEqual([]);
    });

    it('requires every confirmation before proposing atomic room admission', () => {
        const paired = start(start(emptyPool(), 'alice', 1000).pool, 'bob', 2000);
        const alice = command({ pool: paired.pool, action: 'confirm', principalId: 'alice', nowEpochMs: 3000 });
        expect(alice.admission).toBeNull();
        const bob = command({ pool: alice.pool, action: 'confirm', principalId: 'bob', nowEpochMs: 4000 });
        expect(bob.admission).toMatchObject({
            leaderPrincipalId: 'alice',
            roomRef: { ...scope, groupId: 'match-search-alice' },
            participants: [
                { principalId: 'alice', confirmedAtEpochMs: 3000 },
                { principalId: 'bob', confirmedAtEpochMs: 4000 }
            ]
        });
    });

    it('keeps an account in exactly one search across tabs', () => {
        const first = start(emptyPool(), 'alice', 1000);
        const duplicate = computeMatchmaking({
            pool: first.pool,
            policy,
            nowEpochMs: 2000,
            command: { action: 'start', principalId: 'alice', sessionId: 'another-tab', ...sessionLifetime, searchId: 'duplicate', capturedAtEpochMs: 2000 }
        });
        expect(duplicate.pool).toEqual(first.pool);
        expect(duplicate.searchId).toBe('search-alice');
        expect(duplicate.admission).toBeNull();
    });

    it('refuses another account reusing an active search identity without changing the first search', () => {
        const first = start(emptyPool(), 'alice', 1000);
        const duplicate = computeMatchmaking({
            pool: first.pool,
            policy,
            nowEpochMs: 2000,
            command: { action: 'start', principalId: 'bob', sessionId: 'session-bob', ...sessionLifetime, searchId: 'search-alice', capturedAtEpochMs: 2000 }
        });
        expect(duplicate.rejection).toBe('search-not-current');
        expect(duplicate.pool).toEqual(first.pool);
        expect(duplicate.admission).toBeNull();
    });

    it('releases every reservation on decline without silently requeuing the partner', () => {
        const paired = start(start(emptyPool(), 'alice', 1000).pool, 'bob', 2000);
        const declined = command({ pool: paired.pool, action: 'cancel', principalId: 'bob', nowEpochMs: 3000 });
        expect(declined.pool).toEqual(emptyPool());
        expect(declined.finished).toMatchObject([
            { searchId: 'search-alice', reason: 'declined' },
            { searchId: 'search-bob', reason: 'declined' }
        ]);
        expect(declined.admission).toBeNull();
    });

    it('expires confirmation at the exact deadline before accepting the last confirmation', () => {
        const paired = start(start(emptyPool(), 'alice', 1000).pool, 'bob', 2000);
        const alice = command({ pool: paired.pool, action: 'confirm', principalId: 'alice', nowEpochMs: 3000 });
        const late = command({ pool: alice.pool, action: 'confirm', principalId: 'bob', nowEpochMs: 32_000 });
        expect(late.pool).toEqual(emptyPool());
        expect(late.admission).toBeNull();
        expect(late.finished.map((result) => result.reason)).toEqual(['confirmation-timeout', 'confirmation-timeout']);
    });

    it('does not pair an expired search with a new arrival', () => {
        const first = start(emptyPool(), 'alice', 1000);
        const late = start(first.pool, 'bob', 121_000);
        expect(late.pool.searching.map((search) => search.principalId)).toEqual(['bob']);
        expect(late.pool.proposals).toEqual([]);
        expect(late.finished).toMatchObject([{ searchId: 'search-alice', reason: 'search-timeout' }]);
    });

    it('fences delayed cancellation of an earlier search identity', () => {
        const first = start(emptyPool(), 'alice', 1000);
        const stale = command({ pool: first.pool, action: 'cancel', principalId: 'alice', nowEpochMs: 2000, searchId: 'old-search' });
        expect(stale.pool).toEqual(first.pool);
        expect(stale.finished).toEqual([]);
        expect(stale.rejection).toBe('search-not-current');
    });

    it('forms the configured cohort size in FIFO order', () => {
        const four = { ...policy, players: 4 };
        let pool = emptyPool();
        for (const [index, principalId] of ['zoe', 'bob', 'alice', 'dan'].entries()) {
            pool = computeMatchmaking({
                pool,
                policy: four,
                nowEpochMs: 1000 + index,
                command: { action: 'start', principalId, sessionId: principalId, ...sessionLifetime, searchId: principalId, capturedAtEpochMs: 1000 + index }
            }).pool;
        }
        expect(pool.proposals[0].participants.map((player) => player.principalId)).toEqual(['zoe', 'bob', 'alice', 'dan']);
        expect(pool.proposals[0].leaderPrincipalId).toBe('zoe');
    });
    it('rejects duplicate accounts in persisted pool state instead of matching them twice', () => {
        const first = start(emptyPool(), 'alice', 1000).pool;
        const corrupt = { ...first, searching: [first.searching[0], { ...first.searching[0], searchId: 'duplicate' }] };
        expect(() => start(corrupt, 'bob', 2000)).toThrow(/duplicate/i);
    });

    it('rejects a proposed destination in another workspace', () => {
        const paired = start(start(emptyPool(), 'alice', 1000).pool, 'bob', 2000).pool;
        const corrupt = {
            ...paired,
            proposals: [{ ...paired.proposals[0], roomRef: { ...paired.proposals[0].roomRef, workspaceId: 'other' } }]
        };
        expect(() => command({ pool: corrupt, action: 'confirm', principalId: 'alice', nowEpochMs: 3000 })).toThrow(/scope/i);
    });

    it('rejects a persisted confirmation outside its offer window', () => {
        const paired = start(start(emptyPool(), 'alice', 1000).pool, 'bob', 2000).pool;
        const proposal = paired.proposals[0];
        const corrupt = {
            ...paired,
            proposals: [{ ...proposal, participants: proposal.participants.map((player) => ({ ...player, confirmedAtEpochMs: 32_000 })) }]
        };
        expect(() => command({ pool: corrupt, action: 'confirm', principalId: 'alice', nowEpochMs: 3000 })).toThrow(/confirmation/i);
    });

    it('rejects invalid configuration rather than silently clamping a cohort or timeout', () => {
        for (const invalid of [{ ...policy, players: 1 }, { ...policy, players: 2.5 }, { ...policy, confirmationTimeoutMs: 0 }]) {
            expect(() => computeMatchmaking({ pool: emptyPool(), policy: invalid, nowEpochMs: 1000, command: { action: 'expire' } })).toThrow();
        }
    });

    it('sweeps abandoned searches without requiring an authenticated browser', () => {
        const waiting = start(emptyPool(), 'alice', 1000).pool;
        const expired = computeMatchmaking({ pool: waiting, policy, nowEpochMs: 121_000, command: { action: 'expire' } });
        expect(expired.pool).toEqual(emptyPool());
        expect(expired.finished).toMatchObject([{ principalId: 'alice', reason: 'search-timeout' }]);
    });
    it('does not recreate an expired search when its original start arrives late', () => {
        const waiting = start(emptyPool(), 'alice', 1000).pool;
        const late = computeMatchmaking({
            pool: waiting,
            policy,
            nowEpochMs: 121_000,
            command: {
                action: 'start',
                principalId: 'alice',
                sessionId: 'session-alice',
                ...sessionLifetime,
                searchId: 'search-alice',
                capturedAtEpochMs: 1000
            }
        });
        expect(late.finished).toHaveLength(1);
        expect(late.pool).toEqual(emptyPool());
    });
    it('rebinds confirmation to the new authenticated session after reload', () => {
        const paired = start(start(emptyPool(), 'alice', 1000).pool, 'bob', 2000).pool;
        const confirmed = computeMatchmaking({
            pool: paired,
            policy,
            nowEpochMs: 3000,
            command: {
                action: 'confirm',
                principalId: 'alice',
                searchId: 'search-alice',
                sessionId: 'recovered-session',
                ...sessionLifetime,
                sessionIssuedAtEpochMs: 2500,
                sessionExpiresAtEpochMs: 60000,
                capturedAtEpochMs: 3000
            }
        });
        expect(confirmed.pool.proposals[0].participants[0]).toMatchObject({
            sessionId: 'recovered-session',
            ...sessionLifetime,
            sessionIssuedAtEpochMs: 2500,
            sessionExpiresAtEpochMs: 60000
        });
    });
    it('uses ordinal search identity to break timestamp ties consistently across replicas', () => {
        let pool = emptyPool();
        for (const searchId of ['a', 'Z']) {
            pool = computeMatchmaking({
                pool,
                policy,
                nowEpochMs: 1000,
                command: { action: 'start', principalId: searchId, sessionId: searchId, ...sessionLifetime, searchId, capturedAtEpochMs: 1000 }
            }).pool;
        }
        expect(pool.proposals[0].leaderPrincipalId).toBe('Z');
    });
});
