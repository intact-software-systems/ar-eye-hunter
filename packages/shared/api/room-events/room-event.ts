import { assertCourtCapacity, changeCourt, closeEvent, offerCourts, playerOffer, settleOffers } from './room-event-courts.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../../persistence/PersistenceProvider.ts';
import type { GroupRef } from '../group-types.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { requireEpoch, requirePositiveInteger } from '../exact-object-decoding.ts';

export interface RoomEvent {
    readonly lobby: GroupRef;
    readonly organizerId: string;
    readonly createdAt: number;
    readonly emptyReturnWindowMs: number;
    readonly revision: number;
    readonly closesAt: number;
    readonly claimWindowMs: number;
    readonly closed: boolean;
    readonly courts: readonly RoomEvent.Court[];
    readonly queue: readonly RoomEvent.Party[];
    readonly proposals: readonly RoomEvent.Proposal[];
    readonly removed: readonly string[];
}

export namespace RoomEvent {
    export interface Party { readonly id: string; readonly players: readonly string[]; }
    export interface Proposal extends Party { readonly accepted: readonly string[]; }
    export interface CourtSetup { readonly groupId: string; readonly capacity: number; }
    export interface Court extends CourtSetup { readonly occurrence: number; readonly seats: readonly Seat[]; }
    export interface Seat { readonly principalId: string; readonly partyId: string; readonly offerRevision: number; readonly deadline: number | null; }
    export interface Offer { readonly groupId: string; readonly occurrence: number; readonly partyId: string; readonly offerRevision: number; readonly deadline: number | null; }
    export interface View {
        readonly principalId: string;
        readonly lobby: GroupRef;
        readonly revision: number;
        readonly closesAt: number;
        readonly closed: boolean;
        readonly courts: readonly (CourtSetup & { readonly occurrence: number; readonly availableSeats: number })[];
        readonly queue: Party | null;
        readonly proposals: readonly Proposal[];
        readonly offer: Offer | null;
    }
    export type Command =
        | { readonly action: 'create'; readonly courts: readonly CourtSetup[]; readonly closesAt: number; readonly claimWindowMs?: number; readonly emptyReturnWindowMs?: number }
        | { readonly action: 'propose'; readonly partyId: string; readonly players: readonly string[] }
        | { readonly action: 'accept'; readonly partyId: string }
        | { readonly action: 'leave-queue' | 'close' | 'settle' }
        | { readonly action: 'claim' | 'decline-offer'; readonly groupId: string; readonly occurrence: number; readonly partyId: string; readonly offerRevision: number }
        | { readonly action: 'release'; readonly groupId: string; readonly occurrence: number; readonly requeue: boolean }
        | { readonly action: 'remove'; readonly targetId: string; readonly rotateVerifier?: string };
}

export function createRoomEvent(input: {
    lobby: GroupRef; organizerId: string; nowEpochMs: number; command: Extract<RoomEvent.Command, { action: 'create' }>;
}): RoomEvent {
    const { command, lobby, organizerId, nowEpochMs } = input;
    requireEpoch(command.closesAt, 'Event closing time');
    if (command.closesAt <= nowEpochMs || command.closesAt >= NEVER_EXPIRE_AT_TIMESTAMP || !command.courts.length) throw new TypeError('An event needs open time and a court.');
    const claimWindowMs = command.claimWindowMs ?? 120_000;
    requirePositiveInteger(claimWindowMs, 'Court claim window');
    const emptyReturnWindowMs = command.emptyReturnWindowMs ?? 900_000;
    requirePositiveInteger(emptyReturnWindowMs, 'Event return window');
    if (emptyReturnWindowMs > 86_400_000) throw new TypeError('The event return window cannot exceed 24 hours.');
    const ids = new Set([lobby.groupId]);
    const courts = command.courts.map(({ groupId, capacity }) => {
        assertValidRallarRouteId(groupId);
        assertCourtCapacity(capacity);
        if (ids.has(groupId)) throw new TypeError('An event needs distinct lobby and court identities.');
        ids.add(groupId);
        return { groupId, capacity, occurrence: 1, seats: [] };
    });
    return { lobby, organizerId, createdAt: nowEpochMs, emptyReturnWindowMs, closesAt: command.closesAt, revision: 1, claimWindowMs, closed: false,
        courts, queue: [], proposals: [], removed: [] };
}

export function projectRoomEvent(event: RoomEvent, principalId: string): RoomEvent.View {
    if (event.removed.includes(principalId)) throw new TypeError('Event access has ended.');
    const courts = event.courts.map(({ groupId, capacity, occurrence, seats }) =>
        ({ groupId, capacity, occurrence, availableSeats: event.closed ? 0 : capacity - seats.length }));
    return { principalId, lobby: event.lobby, closesAt: event.closesAt, revision: event.revision, closed: event.closed, courts,
        queue: event.queue.find(party => party.players.includes(principalId)) ?? null,
        proposals: event.proposals.filter(party => party.players.includes(principalId)), offer: playerOffer(event, principalId) };
}

function withoutPlayers(queue: readonly RoomEvent.Party[], leaving: readonly string[]): RoomEvent.Party[] {
    return queue.map(party => ({ id: party.id, players: party.players.filter(player => !leaving.includes(player)) }))
        .filter(party => party.players.length > 0);
}

function acceptParty(event: RoomEvent, proposal: RoomEvent.Proposal, player: string): RoomEvent {
    if (!proposal.players.includes(player)) throw new TypeError('Player was not invited into this party.');
    if (proposal.accepted.includes(player)) return event;
    if (playerOffer(event, player)) throw new TypeError('Resolve the current court assignment before joining a party.');
    const accepted = [...proposal.accepted, player];
    if (accepted.length < proposal.players.length) {
        return { ...event, proposals: event.proposals.map(p => p.id === proposal.id ? { ...p, accepted } : p) };
    }
    if (proposal.players.some(id => playerOffer(event, id))) throw new TypeError('A party member has an outstanding assignment.');
    return { ...event, queue: [...withoutPlayers(event.queue, proposal.players), { id: proposal.id, players: proposal.players }],
        proposals: event.proposals.filter(p => p.id !== proposal.id && !p.accepted.some(id => proposal.players.includes(id))) };
}

function proposeParty(event: RoomEvent, command: Extract<RoomEvent.Command, { action: 'propose' }>, player: string): RoomEvent {
    const { players, partyId } = command;
    if (!players.includes(player) || new Set(players).size !== players.length || players.some(id => event.removed.includes(id)) ||
        !event.courts.some(court => court.capacity >= players.length)) throw new TypeError('Invalid event party.');
    if (event.proposals.some(p => p.id === partyId) || event.queue.some(p => p.id === partyId) ||
        event.courts.some(court => court.seats.some(seat => seat.partyId === partyId))) throw new TypeError('Party identity is already in use.');
    const proposal = { id: partyId, players, accepted: [] };
    return acceptParty({ ...event, proposals: [...event.proposals, proposal] }, proposal, player);
}

function applyCommand(event: RoomEvent, command: RoomEvent.Command, player: string): RoomEvent {
    switch (command.action) {
        case 'create': throw new TypeError('Event already exists.');
        case 'propose': return proposeParty(event, command, player);
        case 'accept': {
            const proposal = event.proposals.find(p => p.id === command.partyId);
            if (!proposal) throw new TypeError('No matching party invitation.');
            return acceptParty(event, proposal, player);
        }
        case 'leave-queue': return { ...event, queue: withoutPlayers(event.queue, [player]),
            proposals: event.proposals.filter(p => !p.players.includes(player)) };
        case 'claim': case 'decline-offer': case 'release': return changeCourt(event, command, player);
        case 'close': return closeEvent(event);
        case 'remove': {
            if (command.targetId === event.organizerId) throw new TypeError('The organizer cannot be removed.');
            return { ...event, removed: [...new Set([...event.removed, command.targetId])],
                queue: withoutPlayers(event.queue, [command.targetId]), proposals: event.proposals.filter(p => !p.players.includes(command.targetId)),
                courts: event.courts.map(c => ({ ...c, seats: c.seats.filter(s => s.principalId !== command.targetId) })) };
        }
        case 'settle': return event;
    }
}

/** The service fences membership, organizer permission and the court director in the same write. */
export function changeRoomEvent(input: { event: RoomEvent; command: RoomEvent.Command; principalId: string; nowEpochMs: number }): RoomEvent {
    const { event, command, principalId, nowEpochMs } = input;
    const settled = settleOffers(event, nowEpochMs);
    if (command.action !== 'settle' && (settled.closed || event.removed.includes(principalId))) throw new TypeError('Event access has ended.');
    if ((command.action === 'close' || command.action === 'remove') && principalId !== event.organizerId) throw new TypeError('Organizer permission required.');
    const next = command.action === 'settle' ? settled : offerCourts(applyCommand(settled, command, principalId), nowEpochMs);
    return next === event ? event : { ...next, revision: event.revision + 1 };
}
