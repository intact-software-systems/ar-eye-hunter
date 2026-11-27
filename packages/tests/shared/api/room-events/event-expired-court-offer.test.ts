import { expect, it } from 'vitest';
import { decodeRoomEvent } from '@shared/api/room-events/decode-room-event.ts';
import { decodeRoomEventView } from '@shared/api/room-events/decode-room-event-view.ts';
import { changeRoomEvent, createRoomEvent, projectRoomEvent, type RoomEvent } from '@shared/api/room-events/room-event.ts';

it('recovers only the returning player’s expired offer after the next player claims, until the returning player rejoins', () => {
    let event = createRoomEvent({ lobby: { applicationId: 'a', workspaceId: 'w', groupId: 'lobby' }, organizerId: 'host',
        nowEpochMs: 0, command: { action: 'create', courts: [{ groupId: 'court', capacity: 1 }], closesAt: 100, claimWindowMs: 10 } });
    const change = (principalId: string, command: RoomEvent.Command, nowEpochMs: number) => {
        event = decodeRoomEvent(changeRoomEvent({ event, command, principalId, nowEpochMs }));
    };
    const read = (principal: string) => decodeRoomEventView(projectRoomEvent(event, principal));
    const propose = (player: string, partyId: string, now: number) => change(player, { action: 'propose', partyId, players: [player] }, now);
    propose('alex', 'a1', 1);
    propose('sam', 's1', 2);
    const first = read('alex').offer!;
    expect(decodeRoomEventView(projectRoomEvent(event, 'alex', 11))).toMatchObject({ lastExpiredOffer: first, offer: null });
    change('host', { action: 'settle' }, 11);
    const second = read('sam').offer!;
    change('sam', { action: 'claim', ...second }, 12);
    expect(read('alex')).toMatchObject({ lastExpiredOffer: first, offer: null });
    expect(read('sam').lastExpiredOffer).toBeNull();
    expect(read('host').lastExpiredOffer).toBeNull();
    expect(() => decodeRoomEventView({ ...read('alex'), lastExpiredOffer: { ...first, deadline: null } })).toThrow();
    propose('alex', 'a2', 13);
    expect(read('alex')).toMatchObject({ lastExpiredOffer: null, queue: { id: 'a2' } });
    change('host', { action: 'release', groupId: 'court', occurrence: second.occurrence, requeue: false }, 14);
    const later = read('alex').offer!;
    change('alex', { action: 'decline-offer', ...later }, 15);
    expect(read('alex').lastExpiredOffer).toBeNull();
    propose('alex', 'a3', 16);
    change('host', { action: 'settle' }, 26);
    expect(read('alex').lastExpiredOffer).toMatchObject({ partyId: 'a3', deadline: 26 });
    const removed = changeRoomEvent({ event, command: { action: 'remove', targetId: 'alex' }, principalId: 'host', nowEpochMs: 27 });
    expect(decodeRoomEvent(removed).expiredOffers).toBeUndefined();
    change('host', { action: 'close' }, 27);
    expect(read('alex').lastExpiredOffer).toBeNull();
});
