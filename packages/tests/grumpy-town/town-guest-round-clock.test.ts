import type { GroupRef } from '@shared/api/group-types.ts';
import type { RoomTimelineAdvance, RoomTimelineExtension } from '@shared/api/group-deadlines/room-timeline.ts';
import { expect, it } from 'vitest';
import { permitsFinishingGuestAction, writeGuestRoundClock } from '../../../apps/grumpy-town/src/match/guest-round-clock.ts';

it('binds only the starting players and includes the countdown in the server deadline', async () => {
    const writes: RoomTimelineAdvance[] = [];
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

it('retries a round extension using the same request identity and stops once the room reflects it', async () => {
    const requests: string[] = [];
    const port = {
        advanceTimeline: async () => { throw new Error('unexpected advance'); },
        extendTimeline: async (_room: GroupRef, _change: RoomTimelineExtension, requestId: string) => {
            requests.push(requestId);
            if (requests.length === 1) throw new Error('lost acknowledgement');
        }
    };
    const change = {
        room: { applicationId: 'game', workspaceId: 'friends', groupId: 'square' }, matchId: 'round-a', directorEpoch: 2,
        timeline: { name: 'guest-play', revision: 4, phase: 'round-a', startedAtRevision: 3, startedAtEpochMs: 1000,
            startedBy: 'director', status: 'running', endsAtEpochMs: 184000 },
        action: { kind: 'extend', durationMs: 60000, totalDurationMs: 243000 }
    } as const;
    await expect(writeGuestRoundClock(port, change)).rejects.toThrow('lost acknowledgement');
    await writeGuestRoundClock(port, change);
    await writeGuestRoundClock(port, { ...change, timeline: { ...change.timeline, revision: 5, endsAtEpochMs: 244000 } });
    expect(requests).toEqual(['grumpy-town-guest-round-extend-round-a-243000', 'grumpy-town-guest-round-extend-round-a-243000']);
});

it('allows a finishing guest to exchange controls and checkpoints only in the admitted round', () => {
    for (const kind of ['controls', 'proposal', 'ack', 'commit']) {
        expect(permitsFinishingGuestAction('round-a', { matchId: 'round-a', action: { kind } })).toBe(true);
        expect(permitsFinishingGuestAction('round-a', { matchId: 'round-b', action: { kind } })).toBe(false);
    }
    for (const kind of ['ready', 'extend', 'start', 'rematch']) {
        expect(permitsFinishingGuestAction('round-a', { matchId: 'round-a', action: { kind } })).toBe(false);
    }
});
