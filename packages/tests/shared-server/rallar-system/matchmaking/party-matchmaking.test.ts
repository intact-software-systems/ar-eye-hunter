import { computeMatchmaking } from '@shared-server/rallar-system/matchmaking/compute-matchmaking.ts';
import type { MatchmakingInput, MatchmakingTransition } from '@shared-server/rallar-system/matchmaking/matchmaking-pool.ts';
import { describe, expect, it } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const policy = { players: 4, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 };

function actor(principalId: string) {
    return { principalId, sessionId: `session-${principalId}`, sessionIssuedAtEpochMs: 1, sessionExpiresAtEpochMs: 1_000_000 };
}

function initial(): MatchmakingInput {
    return { pool: { scope, searching: [], proposals: [] }, partySearches: [], policy, nowEpochMs: 1000, command: { action: 'expire' } };
}

function after(transition: MatchmakingTransition): MatchmakingInput {
    return { ...initial(), pool: transition.pool, partySearches: transition.partySearches };
}

function startParty(input: MatchmakingInput, partyId: string, principals: readonly string[]) {
    const leader = principals[0]!;
    return computeMatchmaking({
        ...input,
        command: {
            ...actor(leader),
            action: 'start-party',
            searchId: `search-${partyId}`,
            capturedAtEpochMs: input.nowEpochMs,
            party: { ref: { ...scope, partyId }, rosterRevision: 2, leaderPrincipalId: leader, members: principals.map(actor) }
        }
    });
}

function startSolo(input: MatchmakingInput, principalId: string) {
    return computeMatchmaking({
        ...input,
        command: {
            ...actor(principalId),
            action: 'start',
            searchId: `search-${principalId}`,
            capturedAtEpochMs: input.nowEpochMs
        }
    });
}

describe('indivisible party matchmaking', () => {
    it('fills a two-person party with solo players and requires every account confirmation', () => {
        const party = startParty(initial(), 'friends', ['alice', 'bob']);
        expect(party.rejection).toBeNull();
        expect(party.pool.searching.map((search) => search.principalId)).toEqual(['alice', 'bob']);
        const charlie = startSolo({ ...after(party), nowEpochMs: 1001 }, 'charlie');
        const formed = startSolo({ ...after(charlie), nowEpochMs: 1002 }, 'dan');
        expect(formed.pool.searching).toEqual([]);
        expect(formed.pool.proposals).toHaveLength(1);
        const proposal = formed.pool.proposals[0]!;
        expect(proposal.participants.map((player) => player.principalId).sort()).toEqual(['alice', 'bob', 'charlie', 'dan']);
        expect(proposal.leaderPrincipalId).toBe('alice');
        let current = formed;
        for (const [index, player] of proposal.participants.entries()) {
            current = computeMatchmaking({
                ...after(current),
                nowEpochMs: 1003,
                command: { ...actor(player.principalId), action: 'confirm', searchId: player.searchId, capturedAtEpochMs: 1001 }
            });
            expect(current.admission !== null).toBe(index === 3);
        }
        expect(current.finished.map((search) => search.principalId).sort()).toEqual(['alice', 'bob', 'charlie', 'dan']);
        expect(current.partySearches).toEqual([]);
    });

    it('sends a full party directly to confirmation and never splits a party that cannot fit', () => {
        const full = startParty({ ...initial(), policy: { ...policy, players: 2 } }, 'full', ['alice', 'bob']);
        expect(full.pool.proposals).toHaveLength(1);
        expect(full.pool.searching).toEqual([]);
        const three = startParty(initial(), 'three', ['a', 'b', 'c']);
        const two = startParty({ ...after(three), nowEpochMs: 1001 }, 'two', ['d', 'e']);
        expect(two.pool.proposals).toHaveLength(0);
        const anotherTwo = startParty({ ...after(two), nowEpochMs: 1002 }, 'another-two', ['f', 'g']);
        expect(anotherTwo.pool.proposals[0]?.participants.map((player) => player.principalId).sort()).toEqual(['d', 'e', 'f', 'g']);
        expect(anotherTwo.pool.searching.map((search) => search.principalId).sort()).toEqual(['a', 'b', 'c']);
    });

    it('cancels the whole waiting party and times out all its accounts at the exact deadline', () => {
        const waiting = startParty(initial(), 'friends', ['alice', 'bob']);
        const bob = waiting.pool.searching.find((search) => search.principalId === 'bob')!;
        const cancelled = computeMatchmaking({
            ...after(waiting),
            command: { ...actor('bob'), action: 'cancel', searchId: bob.searchId, capturedAtEpochMs: 1001 }
        });
        expect(cancelled.pool.searching).toEqual([]);
        expect(cancelled.finished.map((search) => search.principalId).sort()).toEqual(['alice', 'bob']);
        expect(cancelled.finished.every((search) => search.reason === 'cancelled')).toBe(true);
        expect(cancelled.partySearches).toEqual([]);
        const expired = computeMatchmaking({ ...after(waiting), nowEpochMs: 121000, command: { action: 'expire' } });
        expect(expired.finished).toHaveLength(2);
        expect(expired.pool.searching).toEqual([]);
        expect(expired.partySearches).toEqual([]);
    });

    it('starts a replacement party search while expiring the old search in the same attempt', () => {
        const waiting = startParty(initial(), 'friends', ['alice', 'bob']);
        const replacement = computeMatchmaking({
            ...after(waiting),
            nowEpochMs: 121000,
            command: {
                ...actor('alice'),
                action: 'start-party',
                searchId: 'new-search',
                capturedAtEpochMs: 121000,
                party: { ref: { ...scope, partyId: 'friends' }, rosterRevision: 2, leaderPrincipalId: 'alice', members: [actor('alice'), actor('bob')] }
            }
        });
        expect(replacement.rejection).toBeNull();
        expect(replacement.finished).toHaveLength(2);
        expect(replacement.pool.searching).toHaveLength(2);
        expect(replacement.partySearches).toHaveLength(1);
        expect(replacement.partySearches[0]?.searchIds).toContain('new-search');
    });

    it('invalidates the full proposed match when a party roster changes and rejects stale confirmation', () => {
        const party = startParty(initial(), 'friends', ['alice', 'bob']);
        const formed = startSolo(after(startSolo(after(party), 'charlie')), 'dan');
        const cancelled = computeMatchmaking({ ...after(formed), command: { action: 'invalidate', principalIds: ['bob'] } });
        expect(cancelled.pool.proposals).toEqual([]);
        expect(cancelled.finished).toHaveLength(4);
        expect(cancelled.partySearches).toEqual([]);
        const stale = computeMatchmaking({
            ...after(cancelled),
            command: { ...actor('alice'), action: 'confirm', searchId: 'search-friends', capturedAtEpochMs: 1001 }
        });
        expect(stale.admission).toBeNull();
        expect(stale.rejection).toBe('search-not-current');
    });

    it('validates complete party bindings before considering expired searches', () => {
        const waiting = startParty(initial(), 'friends', ['alice', 'bob']);
        const binding = waiting.partySearches[0]!;
        for (
            const corrupted of [
                { ...binding, ref: { ...binding.ref, workspaceId: 'foreign' } },
                { ...binding, searchIds: ['missing'] },
                { ...binding, searchIds: [binding.searchIds[0]!, binding.searchIds[0]!] },
                { ...binding, leaderPrincipalId: 'mallory' }
            ]
        ) {
            expect(() => computeMatchmaking({ ...after(waiting), partySearches: [corrupted], nowEpochMs: 200000, command: { action: 'expire' } })).toThrow();
        }
        const searching = waiting.pool.searching.map((search) =>
            search.principalId === 'bob'
                ? { ...search, expiresAtEpochMs: search.expiresAtEpochMs + 1 }
                : search
        );
        expect(() => computeMatchmaking({ ...after(waiting), pool: { ...waiting.pool, searching }, nowEpochMs: 200000, command: { action: 'expire' } }))
            .toThrow(/lifetimes/);
    });

    it('refuses the complete party if a member already searches or the queue cannot hold everyone', () => {
        const solo = startSolo(initial(), 'bob');
        const conflicted = startParty(after(solo), 'friends', ['alice', 'bob']);
        expect(conflicted.rejection).toBe('search-not-current');
        expect(conflicted.pool).toEqual(solo.pool);
        let crowded = initial();
        for (let index = 0; index < 15; index++) {
            crowded = after(startSolo({ ...crowded, policy: { ...policy, players: 16, maxSearching: 16 } }, `solo-${index}`));
        }
        const overflow = startParty({ ...crowded, policy: { ...policy, players: 16, maxSearching: 16 } }, 'friends', ['alice', 'bob']);
        expect(overflow.rejection).toBe('search-capacity');
        expect(overflow.pool.searching).toHaveLength(15);
    });
});
