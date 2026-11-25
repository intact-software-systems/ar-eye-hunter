import { expect, it } from 'vitest';

import { TownMatchRecoveryWindow } from '../../../apps/grumpy-town/src/match/agreement/town-match-recovery-window.ts';
import { createTownMatch } from '../../../apps/grumpy-town/src/match/town-match.ts';

it('starts the active checkpoint deadline at countdown after players wait in a ready lobby', () => {
    const lobby = createTownMatch('town-round', [
        { id: 'alice', sessionId: 'alice-session', displayName: 'Alice' },
        { id: 'guest', sessionId: 'guest-session', displayName: 'Guest' }
    ]).right!;
    const recovery = new TownMatchRecoveryWindow();
    const ready = { epoch: 1, sequence: 2, digest: 'a'.repeat(64), state: lobby };
    recovery.confirm(ready, 1000, 'alice', true);
    const countdown = { ...lobby, phase: 'countdown' as const };
    const current = { match: countdown, available: true, authorityAligned: true, recoveryRequired: false };
    expect(recovery.status({ ...current, now: 31000 }).recovering).toBe(false);
    recovery.confirm({ ...ready, sequence: 3, state: countdown }, 31000, 'alice', true);
    expect(recovery.status({ ...current, now: 32500 }).recovering).toBe(true);
    recovery.expire(countdown.matchId, 32500);
    expect(recovery.status({ ...current, now: 42499 }).interruption).toBeUndefined();
    recovery.expire(countdown.matchId, 42500);
    expect(recovery.status({ ...current, now: 42500 }).interruption).toContain('recovery could not be confirmed');
});

it('shows the agreed final scores when the final commit arrives after the local recovery timeout', () => {
    const lobby = createTownMatch('round', [{ id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }]).right!;
    const match = { ...lobby, phase: 'playing' as const };
    const recovery = new TownMatchRecoveryWindow();
    const state = { match, available: true, authorityAligned: true, recoveryRequired: false };
    recovery.confirm({ epoch: 1, sequence: 1, digest: 'a'.repeat(64), state: match }, 0, 'bob', false);
    recovery.expire(match.matchId, 12000);
    expect(recovery.status({ ...state, now: 12000 }).interruption).toBeDefined();
    const finished = { ...match, phase: 'finished' as const };
    recovery.confirm({ epoch: 1, sequence: 2, digest: 'b'.repeat(64), state: finished }, 12001, 'bob', false);
    expect(recovery.status({ ...state, match: finished, now: 12001 }).interruption).toBeUndefined();
});

it('starts a fresh recovery interval when the players confirm progress between two stalls near the end', () => {
    const lobby = createTownMatch('round', [{ id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }]).right!;
    const match = { ...lobby, phase: 'playing' as const, tick: 5380, remainingTicks: 20 };
    const recovery = new TownMatchRecoveryWindow();
    const state = { match, available: true, authorityAligned: true, recoveryRequired: false };
    const first = { epoch: 1, sequence: 1, digest: 'a'.repeat(64), state: match };
    recovery.confirm(first, 0, 'bob', true);
    recovery.expire(match.matchId, 1500);
    const next = { ...match, tick: 5395, remainingTicks: 5 };
    recovery.confirm({ epoch: 1, sequence: 2, digest: 'b'.repeat(64), state: next }, 9000, 'bob', true);
    // A delayed host pump first wakes after the second stall has already started.
    recovery.expire(match.matchId, 12000);
    expect(recovery.status({ ...state, match: next, now: 12000 }).interruption).toBeUndefined();
    recovery.expire(match.matchId, 20500);
    expect(recovery.status({ ...state, match: next, now: 20500 }).interruption).toBeDefined();
});
