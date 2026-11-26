import { withoutEventAlerts } from './room-event-alerts.ts';
import type { RoomEvent } from './room-event.ts';
import { requirePositiveInteger } from '../exact-object-decoding.ts';

export function assertCourtCapacity(capacity: number): void {
    requirePositiveInteger(capacity, 'Court capacity');
    if (capacity === Number.MAX_SAFE_INTEGER) throw new TypeError('Court capacity must leave space for its administrative membership.');
}

export function playerOffer(event: RoomEvent, principalId: string): RoomEvent.Offer | null {
    for (const court of event.courts) {
        const seat = court.seats.find(candidate => candidate.principalId === principalId);
        if (seat) return { groupId: court.groupId, occurrence: court.occurrence, partyId: seat.partyId, offerRevision: seat.offerRevision, deadline: seat.deadline };
    }
    return null;
}

/** Queue order is the order of final consent, including when two commands share a clock reading. */
export function offerCourts(event: RoomEvent, now: number): RoomEvent {
    const queue: RoomEvent.Party[] = [];
    const courts = [...event.courts];
    for (const party of event.queue) {
        const court = courts.find(candidate => candidate.capacity - candidate.seats.length >= party.players.length);
        if (!court) { queue.push(party); continue; }
        const deadline = now + Math.min(event.claimWindowMs, event.closesAt - now);
        const places = party.players.map(principalId => ({ principalId, partyId: party.id, offerRevision: event.revision + 1, deadline }));
        courts[courts.indexOf(court)] = { ...court, seats: [...court.seats, ...places] };
    }
    return queue.length === event.queue.length ? event : { ...event, courts, queue };
}

export function settleOffers(event: RoomEvent, now: number): RoomEvent {
    if (event.closed) return event;
    if (event.closesAt <= now) return closeEvent(event);
    const courts = event.courts.map(court => {
        const seats = court.seats.filter(seat => seat.deadline === null || seat.deadline > now);
        return afterSeatRemoval(court, seats);
    });
    return courts.some((court, i) => court !== event.courts[i]) ? offerCourts({ ...event, courts }, now) : event;
}

export function removeCourtPlayer(court: RoomEvent.Court, principalId: string): RoomEvent.Court {
    return afterSeatRemoval(court, court.seats.filter(seat => seat.principalId !== principalId));
}

function afterSeatRemoval(court: RoomEvent.Court, seats: readonly RoomEvent.Seat[]): RoomEvent.Court {
    if (seats.length === court.seats.length) return court;
    // A surviving reservation remains valid. An emptied court starts a new occurrence before allocating again.
    return { ...court, seats, occurrence: seats.length ? court.occurrence : court.occurrence + 1 };
}

export function closeEvent(event: RoomEvent): RoomEvent {
    return { ...withoutEventAlerts(event, () => true), closed: true, proposals: [], queue: [], courts: event.courts.map(court => ({ ...court, seats: [] })) };
}

export function changeCourt(event: RoomEvent, command: Extract<RoomEvent.Command, {groupId: string}>, player: string): RoomEvent {
    const court = event.courts.find(candidate => candidate.groupId === command.groupId);
    if (!court || court.occurrence !== command.occurrence) throw new TypeError('Court occurrence has changed.');
    let next = court;
    let queue = event.queue;
    if (command.action === 'release') {
        next = { ...court, occurrence: court.occurrence + 1, seats: [] };
        if (command.requeue) queue = [...queue, ...returningParties(court)];
    } else {
        const seat = court.seats.find(candidate => candidate.principalId === player && candidate.partyId === command.partyId && candidate.offerRevision === command.offerRevision);
        if (!seat || seat.deadline === null) throw new TypeError('No matching court offer.');
        next = command.action === 'claim'
            ? { ...court, seats: court.seats.map(current => current === seat ? { ...seat, deadline: null } : current) }
            : removeCourtPlayer(court, player);
    }
    return { ...event, queue, courts: event.courts.map(current => current === court ? next : current) };
}

function returningParties(court: RoomEvent.Court): RoomEvent.Party[] {
    const groups = new Map<string, string[]>();
    for (const seat of court.seats) {
        if (seat.deadline !== null) continue;
        const party = groups.get(seat.partyId) ?? [];
        party.push(seat.principalId);
        groups.set(seat.partyId, party);
    }
    return Array.from(groups, ([id, players]) => ({ id, players }));
}

