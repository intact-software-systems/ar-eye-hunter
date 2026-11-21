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

it('rejects invalid occurrence identity and director intent on next-occurrence writes', () => {
    for (const startedAtRevision of [1, 3, 1.5, null]) {
        expect(() => readRoomDeadline({ rallarRoomDeadlines: [{ ...deadline, startedAtRevision }] }, deadline.name))
            .toThrow(TypeError);
    }
    const start = { name: deadline.name, expectedRevision: 2, atEpochMs: 9_000, operation: 'start-next-occurrence' };
    expect(() => assertRoomDeadlineChange({ ...start, expectedDirectorEpoch: 1 })).toThrow(TypeError);
    expect(() => assertRoomDeadlineChange({ ...start, expectedRevision: 0 })).toThrow(TypeError);
});
