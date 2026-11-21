import { assertRoomDeadlineChange, readRoomDeadline } from '@shared/api/group-deadlines/room-deadline.ts';
import { expect, it } from 'vitest';

const deadline = { name: 'round.close', atEpochMs: 3_000, revision: 2 };

it('distinguishes missing names from corrupt records in the published collection', () => {
    expect(readRoomDeadline({}, deadline.name)).toBeNull();
    expect(readRoomDeadline({ rallarRoomDeadlines: [deadline] }, 'vote')).toBeNull();
    expect(readRoomDeadline({ rallarRoomDeadlines: [deadline] }, deadline.name)).toEqual(deadline);
    for (const corrupt of [
        [deadline, deadline],
        [{ ...deadline, revision: 0 }],
        [{ ...deadline, name: '../round/close' }],
        [{ ...deadline, atEpochMs: -1 }],
        [{ ...deadline, privateData: true }]
    ]) {
        expect(() => readRoomDeadline({ rallarRoomDeadlines: corrupt }, 'vote')).toThrow(TypeError);
    }
});

it('requires the published instant to be representable as an epoch date', () => {
    const atEpochMs = 8_640_000_000_000_001;
    expect(() => assertRoomDeadlineChange({ name: 'vote', expectedRevision: 0, atEpochMs })).toThrow(TypeError);
    expect(() => readRoomDeadline({ rallarRoomDeadlines: [{ ...deadline, atEpochMs }] }, deadline.name)).toThrow(TypeError);
});
