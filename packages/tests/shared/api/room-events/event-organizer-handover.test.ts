import { expect, it } from 'vitest';
import { changeRoomEvent, createRoomEvent, projectRoomEvent, type RoomEvent } from '@shared/api/room-events/room-event.ts';

const lobby = { applicationId: 'club', workspaceId: 'venue', groupId: 'pickup' };
const initial = createRoomEvent({ lobby, organizerId: 'alex', nowEpochMs: 1, command: {
    action: 'create', courts: [{ groupId: 'west', capacity: 2 }], closesAt: 900_000
} });
function change(event: RoomEvent, principalId: string, command: RoomEvent.Command, nowEpochMs = 10) {
    return changeRoomEvent({ event, principalId, command, nowEpochMs, handoverWindowMs: 50 });
}
it('only the named recipient can accept the current private offer before expiry', () => {
    const event = change(initial, 'alex', { action: 'offer-handover', recipientId: 'sam' });
    const offer = projectRoomEvent(event, 'sam').handover!;
    expect(offer).toMatchObject({ offeredBy: 'alex', recipientId: 'sam', expiresAt: 60 });
    expect(projectRoomEvent(event, 'alex').handover).toEqual(offer);
    expect(projectRoomEvent(event, 'outsider').handover).toBeNull();
    const accept = { action: 'accept-handover', offerId: offer.offerId } as const;
    expect(() => change(event, 'outsider', accept)).toThrow();
    expect(() => change(event, 'sam', accept, 60)).toThrow();
    expect(change(event, 'sam', accept, 59)).toMatchObject({ organizerId: 'sam', courts: initial.courts });
    const cancelled = change(event, 'alex', { action: 'cancel-handover', offerId: offer.offerId });
    const replacement = change(cancelled, 'alex', { action: 'offer-handover', recipientId: 'sam' });
    expect(() => change(replacement, 'sam', accept)).toThrow();
    expect(projectRoomEvent(change(event, 'alex', { action: 'remove', targetId: 'sam' }), 'alex').handover).toBeNull();
});
