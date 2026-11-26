import { expect, it } from 'vitest';
import { changeRoomEvent, createRoomEvent, projectRoomEvent, type RoomEvent } from '@shared/api/room-events/room-event.ts';

const lobby = { applicationId: 'pickup', workspaceId: 'park', groupId: 'lobby' };
const create = (capacities: number[]) => createRoomEvent({
    lobby, organizerId: 'organizer', nowEpochMs: 10,
    command: { action: 'create', closesAt: 1_000_000,
        courts: capacities.map((capacity, index) => ({ groupId: 'court-' + index, capacity })) }
});
const change = (event: RoomEvent, principalId: string, command: RoomEvent.Command, nowEpochMs = 20) =>
    changeRoomEvent({ event, principalId, command, nowEpochMs });

it('reserves a whole consenting group together and releases only an unclaimed seat at its deadline', () => {
    let event = create([2]);
    event = change(event, 'ann', { action: 'propose', partyId: 'friends', players: ['ann', 'bo'] });
    expect(event.courts[0].seats).toEqual([]);
    event = change(event, 'bo', { action: 'accept', partyId: 'friends', proposalRevision: event.proposals.find(p => p.id === 'friends')!.proposalRevision }, 100);
    expect(event.courts[0].seats.map(seat => seat.deadline)).toEqual([120100, 120100]);
    expect(projectRoomEvent(event, 'ann').offer?.groupId).toBe('court-0');
    const occurrence = event.courts[0].occurrence;
    event = change(event, 'ann', { action: 'claim', groupId: 'court-0', occurrence, offerRevision: 3, partyId: 'friends' }, 120099);
    expect(() => change(event, 'bo', { action: 'claim', groupId: 'court-0', occurrence, offerRevision: 3, partyId: 'friends' }, 120100)).toThrow();
    event = change(event, 'worker', { action: 'settle' }, 120100);
    expect(event.courts[0].seats).toEqual([{ principalId: 'ann', partyId: 'friends', offerRevision: 3, deadline: null }]);
    expect(projectRoomEvent(event, 'bo').offer).toBeNull();
});

it('gives the next suitable court to the oldest group and fences a replayed release', () => {
    let event = create([1, 2]);
    for (const id of ['a', 'b', 'c']) {
        event = change(event, id, { action: 'propose', partyId: id, players: [id] });
    }
    event = change(event, 'd', { action: 'propose', partyId: 'duo', players: ['d', 'e'] });
    event = change(event, 'e', { action: 'accept', partyId: 'duo', proposalRevision: event.proposals.find(p => p.id === 'duo')!.proposalRevision });
    event = change(event, 'f', { action: 'propose', partyId: 'solo', players: ['f'] });
    const release = { action: 'release', groupId: 'court-0', occurrence: event.courts[0].occurrence, requeue: false } as const;
    event = change(event, 'organizer', release);
    expect(event.courts[0].seats.map(seat => seat.principalId)).toEqual(['f']);
    expect(() => change(event, 'organizer', release)).toThrow();
    event = change(event, 'organizer', { ...release, groupId: 'court-1', occurrence: event.courts[1].occurrence });
    expect(event.courts[1].seats.map(seat => seat.principalId)).toEqual(['d', 'e']);
});

it('requires a choice if an accepted friend receives another offer before the new party forms', () => {
    let event = create([2]);
    for (const id of ['a','b','c']) event = change(event, id, { action: 'propose', partyId: id, players: [id] });
    event = change(event, 'c', { action: 'propose', partyId: 'new', players: ['c','d'] });
    event = change(event, 'organizer', { action: 'release', groupId: 'court-0', occurrence: 1, requeue: false });
    expect(() => change(event, 'd', { action: 'accept', partyId: 'new', proposalRevision: event.proposals.find(p => p.id === 'new')!.proposalRevision })).toThrow('outstanding assignment');
    event = change(event, 'c', { action: 'decline-offer', groupId: 'court-0', occurrence: 2, partyId: 'c', offerRevision: event.courts[0].seats[0].offerRevision });
    event = change(event, 'd', { action: 'accept', partyId: 'new', proposalRevision: event.proposals.find(p => p.id === 'new')!.proposalRevision });
    expect(event.courts[0].seats.map(seat => seat.principalId)).toEqual(['c','d']);
});

it('stores the event return window and creation time independently of the latest admission', () => {
    const lobby = { applicationId: 'app', workspaceId: 'ws', groupId: 'park' };
    const command = { action: 'create', courts: [{ groupId: 'court', capacity: 2 }], closesAt: 10000 } as const;
    expect(createRoomEvent({ lobby, command, nowEpochMs: 10, organizerId: 'host' })).toMatchObject({
        createdAt: 10, emptyReturnWindowMs: 900000, closesAt: 10000
    });
    expect(createRoomEvent({ lobby, command:{ ...command, emptyReturnWindowMs: 5000 }, nowEpochMs: 10, organizerId: 'host' }).emptyReturnWindowMs).toBe(5000);
});

it('keeps the remaining friends in place on departure and puts a replacement at the back on fresh consent', () => {
    let event = create([3]);
    for (const id of ['a','b','c']) event = change(event, id, { action: 'propose', partyId: id, players: [id] });
    event = change(event,'d',{action:'propose',partyId:'old',players:['d','e','f']});
    event = change(event,'e',{action:'accept',partyId:'old', proposalRevision: event.proposals.find(p => p.id === 'old')!.proposalRevision});
    event = change(event,'f',{action:'accept',partyId:'old', proposalRevision: event.proposals.find(p => p.id === 'old')!.proposalRevision});
    event = change(event,'g',{action:'propose',partyId:'other',players:['g']});
    event = change(event,'f',{action:'leave-queue'});
    expect(event.queue.map(p => p.players)).toEqual([['d','e'],['g']]);
    event = change(event,'d',{action:'propose',partyId:'new',players:['d','e','h']});
    event = change(event,'h',{action:'accept',partyId:'new', proposalRevision: event.proposals.find(p => p.id === 'new')!.proposalRevision});
    expect(event.queue[0].players).toEqual(['d','e']);
    event = change(event,'e',{action:'accept',partyId:'new', proposalRevision: event.proposals.find(p => p.id === 'new')!.proposalRevision});
    expect(event.queue.map(p => p.players)).toEqual([['g'],['d','e','h']]);
});

it('requeues seated players by party after waiting players, and removes a player from all pending commitments', () => {
    let event = create([1]);
    event = change(event,'a',{action:'propose',partyId:'first',players:['a']});
    event = change(event,'a',{action:'claim',groupId:'court-0',occurrence:1,partyId:'first',offerRevision:event.courts[0].seats[0].offerRevision});
    event = change(event,'b',{action:'propose',partyId:'second',players:['b']});
    event = change(event,'organizer',{action:'release',groupId:'court-0',occurrence:1,requeue:true});
    expect(event.courts[0].seats[0].principalId).toBe('b');
    expect(event.queue).toEqual([{id:'first',players:['a']}]);
    event = change(event,'organizer',{action:'remove',targetId:'b'});
    expect(event.courts[0].seats[0].principalId).toBe('a');
    expect(() => projectRoomEvent(event,'b')).toThrow('access has ended');
    expect(() => change(event,'b',{action:'propose',partyId:'back',players:['b']})).toThrow('access has ended');
});

it('fences delayed decisions after the same party receives another offer in the same occurrence', () => {
    const propose = { action: 'propose', partyId: 'friends', players: ['ann'] } as const;
    let event = change(create([2]), 'bo', { action: 'propose', partyId: 'solo', players: ['bo'] });
    event = change(event, 'ann', propose);
    const old = projectRoomEvent(event, 'ann').offer!;
    const decision = { groupId: old.groupId, occurrence: old.occurrence, partyId: old.partyId, offerRevision: old.offerRevision };
    event = change(event, 'ann', { ...decision, action: 'decline-offer' });
    event = change(event, 'ann', propose);
    for (const action of ['claim', 'decline-offer'] as const) {
        expect(() => change(event, 'ann', { ...decision, action })).toThrow(/offer/);
    }
    const current = projectRoomEvent(event, 'ann').offer!;
    expect(current.offerRevision).toBeGreaterThan(old.offerRevision);
    expect(projectRoomEvent(change(event, 'ann', { ...decision, action: 'claim', offerRevision: current.offerRevision }), 'ann').offer?.deadline).toBeNull();
});

it('reserves numeric capacity for the administrative membership at a full court', () => {
    expect(() => create([Number.MAX_SAFE_INTEGER])).toThrow(/capacity/i);
});

it('requires fresh consent when the same party ID is used to invite a different set of players', () => {
    let event = change(create([3]), 'ann', { action: 'propose', partyId: 'friends', players: ['ann', 'bo'] });
    const old = event.proposals[0]!;
    event = change(event, 'ann', { action: 'leave-queue' });
    event = change(event, 'ann', { action: 'propose', partyId: 'friends', players: ['ann', 'bo', 'cal'] });
    expect(() => change(event, 'bo', { action: 'accept', partyId: old.id, proposalRevision: old.proposalRevision })).toThrow(/invitation/);
    const current = event.proposals[0]!;
    event = change(event, 'bo', { action: 'accept', partyId: current.id, proposalRevision: current.proposalRevision });
    expect(event.proposals[0]!.accepted).toEqual(['ann', 'bo']);
});

it.each(['remove', 'decline', 'expire'] as const)('rejects a delayed release after %s empties a court and its next player claims', departure => {
    let event = create([1]);
    event = change(event, 'a', { action: 'propose', partyId: 'a', players: ['a'] });
    const first = projectRoomEvent(event, 'a').offer!;
    const delayed = { action: 'release', groupId: first.groupId, occurrence: first.occurrence, requeue: false } as const;
    event = change(event, 'b', { action: 'propose', partyId: 'b', players: ['b'] });
    const now = departure === 'expire' ? first.deadline! : 20;
    switch (departure) {
        case 'remove':
            event = change(event, 'a', { ...first, action: 'claim' }, now);
            event = change(event, 'organizer', { action: 'remove', targetId: 'a' }, now);
            break;
        case 'decline':
            event = change(event, 'a', { ...first, action: 'decline-offer' }, now);
            break;
        case 'expire':
            event = change(event, 'worker', { action: 'settle' }, now);
            break;
    }
    const next = projectRoomEvent(event, 'b').offer!;
    event = change(event, 'b', { ...next, action: 'claim' }, now);
    expect(() => change(event, 'organizer', delayed, now)).toThrow(/occurrence/);
    expect(projectRoomEvent(event, 'b').offer).toMatchObject({ occurrence: first.occurrence + 1, deadline: null });
});

it('honors an outstanding offer in the original occurrence when another player is removed', () => {
    let event = create([2]);
    for (const player of ['a', 'b']) event = change(event, player, { action: 'propose', partyId: player, players: [player] });
    const first = projectRoomEvent(event, 'a').offer!;
    const reserved = projectRoomEvent(event, 'b').offer!;
    event = change(event, 'a', { ...first, action: 'claim' });
    event = change(event, 'organizer', { action: 'remove', targetId: 'a' });
    expect(projectRoomEvent(event, 'b').offer).toEqual(reserved);
    event = change(event, 'b', { ...reserved, action: 'claim' });
    expect(projectRoomEvent(event, 'b').offer).toEqual({ ...reserved, deadline: null });
});
