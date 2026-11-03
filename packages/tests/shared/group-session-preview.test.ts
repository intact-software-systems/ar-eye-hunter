import { decodeGroupSessionPage, decodeGroupSessionPreview } from '@shared/api/group-sessions/decode-group-session-preview.ts';
import { toGroupSessionTiming, type GroupSessionPreview } from '@shared/api/group-sessions/group-session-schedule.ts';
import { describe, expect, it } from 'vitest';

const schedule = { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null };
const preview: GroupSessionPreview = {
    roomRef: { applicationId: 'game', workspaceId: 'default', groupId: 'session' },
    displayName: 'Friday game',
    schedule,
    timing: toGroupSessionTiming(schedule, 1_000),
    serverNowEpochMs: 1_000,
    maxPlayers: 4,
    availableSeats: 3,
    participation: 'none',
    isOrganizer: false,
    canReserve: true,
    canEnter: false,
    admissionDenial: null
};

describe('scheduled-session read boundary', () => {
    it('decodes the complete safe preview and caller-index page', () => {
        expect(decodeGroupSessionPreview(preview)).toEqual(preview);
        expect(decodeGroupSessionPage({ sessions: [preview], nextKey: 'account-cursor' }))
            .toEqual({ sessions: [preview], nextKey: 'account-cursor' });
    });

    it.each([
        { ...preview, principalIds: ['private-account'] },
        { ...preview, roomRef: { ...preview.roomRef, principalId: 'private-account' } },
        { ...preview, timing: { ...preview.timing, phase: 'start-ready' } },
        { ...preview, timing: { ...preview.timing, startsAtEpochMs: 4_000_000 } },
        { ...preview, availableSeats: 5 },
        { ...preview, availableSeats: -1 },
        { ...preview, maxPlayers: 65 },
        { ...preview, canReserve: 'yes' },
        { ...preview, participation: 'owner' },
        { ...preview, admissionDenial: 'unexpected' },
        { ...preview, schedule: { ...schedule, revision: 0 } }
    ])('rejects malformed or inconsistent preview %j', (value) => {
        expect(() => decodeGroupSessionPreview(value)).toThrow(TypeError);
    });

    it.each([
        { sessions: [preview], nextKey: null, privateRows: [] },
        { sessions: [preview], nextKey: 5 },
        { sessions: Array.from({ length: 33 }, () => preview), nextKey: null },
        { sessions: [preview, preview], nextKey: null }
    ])('rejects malformed, duplicate or unbounded pages', (value) => {
        expect(() => decodeGroupSessionPage(value)).toThrow(TypeError);
    });
});
