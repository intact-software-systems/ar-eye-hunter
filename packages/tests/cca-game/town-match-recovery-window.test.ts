import { expect, it } from 'vitest';

import { TownMatchRecoveryWindow } from '../../../apps/cca-2d/src/match/agreement/town-match-recovery-window.ts';
import { createTownMatch } from '../../../apps/cca-2d/src/match/town-match.ts';

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
