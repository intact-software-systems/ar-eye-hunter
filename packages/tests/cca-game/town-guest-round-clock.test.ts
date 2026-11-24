import { expect, it } from 'vitest';
import { writeGuestRoundClock } from '../../../apps/cca-2d/src/match/guest-round-clock.ts';

it('binds only the starting players and includes the countdown in the server deadline', async () => {
    const writes: unknown[] = [];
    const room = { applicationId: 'game', workspaceId: 'friends', groupId: 'square' };
    await writeGuestRoundClock({
        advanceTimeline: async (_room, change) => { writes.push(change); },
        extendTimeline: async () => { throw new Error('unexpected extension'); }
    }, {
        room, matchId: 'round-a', directorEpoch: 2, timeline: null,
        action: { kind: 'start', durationMs: 183000, players: ['owner', 'guest'] }
    });
    expect(writes).toEqual([{ name: 'guest-play', phase: 'round-a', expectedRevision: 0, expectedDirectorEpoch: 2,
        durationMs: 183000, participantPrincipalIds: ['owner', 'guest'] }]);
});
