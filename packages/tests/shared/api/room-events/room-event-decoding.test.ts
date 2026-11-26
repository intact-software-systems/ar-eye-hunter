import { expect, it } from 'vitest';
import { decodeRoomEvent, decodeRoomEventCommand } from '@shared/api/room-events/decode-room-event.ts';
import { createRoomEvent } from '@shared/api/room-events/room-event.ts';

it('rejects inconsistent persisted room assignments and unrecognized command authority', () => {
    const event = createRoomEvent({ lobby: { applicationId: 'a', workspaceId: 'w', groupId: 'lobby' }, organizerId: 'host',
        nowEpochMs: 1, command: { action: 'create', closesAt: 100, courts: [{ groupId: 'a', capacity: 2 }] } });
    expect(decodeRoomEvent(event)).toEqual(event);
    const seat = { principalId: 'a', partyId: 'party', offerRevision: 1, deadline: 99 };
    expect(() => decodeRoomEvent({ ...event, courts: [{ ...event.courts[0], seats: [seat, seat] }] })).toThrow();
    expect(() => decodeRoomEvent({ ...event, removed: ['a'], queue: [{ id: 'party', players: ['a'] }] })).toThrow();
    expect(() => decodeRoomEventCommand({ action: 'claim', groupId: 'a', occurrence: 1, partyId: 'party', offerRevision: 1, organizerId: 'host' })).toThrow();
    expect(decodeRoomEventCommand({ action: 'release', groupId: 'a', occurrence: 1 })).toEqual({
        action: 'release', groupId: 'a', occurrence: 1, requeue: true
    });
});
