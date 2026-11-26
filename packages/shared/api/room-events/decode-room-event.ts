import type { ApiJsonValue } from '../api-json-value.ts';
import { assertCourtCapacity } from './room-event-courts.ts';
import { decodeExactGroupRef } from '../../encoding/decode-exact-group-ref.ts';
import { requireEpoch, requireExactKeys, requireExactOptionalKeys, requireRecord } from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { isGuestInvitationVerifier } from '../room-guests/invitation.ts';
import type { RoomEvent } from './room-event.ts';

function positive(value: ApiJsonValue | undefined, label: string): number {
    requireEpoch(value, label);
    if (!value) throw new TypeError(label + ' must be positive.');
    return value;
}

function boolean(value: ApiJsonValue | undefined): boolean {
    if (typeof value !== 'boolean') throw new TypeError('Expected an event boolean.');
    return value;
}

function rows<T>(value: ApiJsonValue | undefined, read: (entry: ApiJsonValue) => T): T[] {
    if (!Array.isArray(value)) throw new TypeError('Expected an event collection.');
    return value.map(read);
}

function ids(value: ApiJsonValue | undefined): string[] {
    const result = rows(value, entry => assertValidRallarRouteId(entry));
    if (new Set(result).size !== result.length) throw new TypeError('Duplicate event identity.');
    return result;
}

function courtSetup(value: ApiJsonValue): RoomEvent.CourtSetup {
    const court = requireRecord(value, 'Court settings');
    requireExactKeys(court, ['groupId','capacity'], 'Court settings');
    const capacity = positive(court.capacity, 'Court capacity');
    assertCourtCapacity(capacity);
    return { groupId: assertValidRallarRouteId(court.groupId), capacity };
}

export function decodeRoomEventCommand(value: unknown): RoomEvent.Command {
    const c = requireRecord(value, 'Room event command');
    switch (c.action) {
        case 'create': {
            requireExactOptionalKeys({ value: c, required: ['action','courts','closesAt'], optional: ['claimWindowMs','emptyReturnWindowMs'], label: 'Event creation' });
            requireEpoch(c.closesAt, 'Closing time');
            return { action: c.action, courts: rows(c.courts, courtSetup), closesAt: c.closesAt,
                ...(c.emptyReturnWindowMs !== undefined && { emptyReturnWindowMs: positive(c.emptyReturnWindowMs, 'Event return window') }),
                ...(c.claimWindowMs !== undefined && { claimWindowMs: positive(c.claimWindowMs, 'Court claim window') }) };
        }
        case 'propose':
            requireExactKeys(c, ['action','partyId','players'], 'Event party proposal');
            return { action: c.action, partyId: assertValidRallarRouteId(c.partyId), players: ids(c.players) };
        case 'accept':
            requireExactKeys(c, ['action','partyId'], 'Accept party');
            return { action: c.action, partyId: assertValidRallarRouteId(c.partyId) };
        case 'release':
            requireExactOptionalKeys({ value: c, required: ['action','groupId','occurrence'], optional: ['requeue'], label: 'Court release' });
            return { action: c.action, groupId: assertValidRallarRouteId(c.groupId), occurrence: positive(c.occurrence, 'Court occurrence'),
                requeue: c.requeue === undefined ? true : boolean(c.requeue) };
        case 'claim': case 'decline-offer':
            requireExactKeys(c, ['action','groupId','occurrence','partyId','offerRevision'], 'Court offer decision');
            return { action: c.action, groupId: assertValidRallarRouteId(c.groupId), partyId: assertValidRallarRouteId(c.partyId),
                occurrence: positive(c.occurrence, 'Court occurrence'), offerRevision: positive(c.offerRevision, 'Offer revision') };
        case 'remove':
            requireExactOptionalKeys({ value: c, required: ['action','targetId'], optional: ['rotateVerifier'], label: 'Event removal' });
            if (c.rotateVerifier !== undefined && !isGuestInvitationVerifier(c.rotateVerifier)) throw new TypeError('Invalid invitation verifier.');
            return { action: c.action, targetId: assertValidRallarRouteId(c.targetId),
                ...(c.rotateVerifier !== undefined && { rotateVerifier: c.rotateVerifier }) };
        case 'settle': case 'close': case 'leave-queue':
            requireExactKeys(c, ['action'], 'Event action');
            return { action: c.action };
        default: throw new TypeError('Unknown room event command.');
    }
}

export function decodeEventParty(value: unknown): RoomEvent.Party {
    const row = requireRecord(value, 'Party');
    requireExactKeys(row, ['id','players'], 'Party');
    const players = ids(row.players);
    if (!players.length) throw new TypeError('An event party needs players.');
    return { id: assertValidRallarRouteId(row.id), players };
}

export function decodeEventProposal(value: unknown): RoomEvent.Proposal {
    const row = requireRecord(value, 'Party proposal');
    const { accepted, ...rest } = row;
    const group = decodeEventParty(rest);
    const consent = ids(accepted);
    if (!consent.length || consent.length >= group.players.length || consent.some(id => !group.players.includes(id))) {
        throw new TypeError('Invalid party consent.');
    }
    return { ...group, accepted: consent };
}

function court(value: ApiJsonValue): RoomEvent.Court {
    const { occurrence, seats: stored, ...setup } = requireRecord(value, 'Court');
    const settings = courtSetup(setup);
    const seats = rows(stored, seat => {
        const row = requireRecord(seat, 'Court seat');
        requireExactKeys(row, ['principalId','partyId','offerRevision','deadline'], 'Court seat');
        if (row.deadline !== null) requireEpoch(row.deadline, 'Claim deadline');
        return { principalId: assertValidRallarRouteId(row.principalId), partyId: assertValidRallarRouteId(row.partyId), offerRevision: positive(row.offerRevision, 'Offer revision'), deadline: row.deadline };
    });
    if (seats.length > settings.capacity) throw new TypeError('Court exceeds its capacity.');
    return { ...settings, occurrence: positive(occurrence, 'Court occurrence'), seats };
}

export function decodeRoomEvent(value: unknown): RoomEvent {
    const e = requireRecord(value, 'Room event');
    requireExactKeys(e, ['lobby','organizerId','createdAt','emptyReturnWindowMs','revision','closesAt','claimWindowMs','closed','courts','queue','proposals','removed'], 'Room event');
    requireEpoch(e.createdAt, 'Event creation time');
    const event = { createdAt: e.createdAt, emptyReturnWindowMs: positive(e.emptyReturnWindowMs, 'Event return window'),
        lobby: decodeExactGroupRef(e.lobby, 'Event lobby'), organizerId: assertValidRallarRouteId(e.organizerId),
        revision: positive(e.revision, 'Event revision'), closesAt: positive(e.closesAt, 'Event closing time'),
        claimWindowMs: positive(e.claimWindowMs, 'Court claim window'), closed: boolean(e.closed),
        courts: rows(e.courts, court), queue: rows(e.queue, decodeEventParty), proposals: rows(e.proposals, decodeEventProposal), removed: ids(e.removed) };
    if (!event.courts.length) throw new TypeError('Stored event has no courts.');
    ids([event.lobby.groupId, ...event.courts.map(c => c.groupId)]);
    ids([...event.queue.flatMap(p => p.players), ...event.courts.flatMap(c => c.seats.map(s => s.principalId)), ...event.removed]);
    ids([...event.queue, ...event.proposals].map(p => p.id));
    if (event.removed.includes(event.organizerId) || event.proposals.some(p => p.players.some(id => event.removed.includes(id))) ||
        event.courts.some(c => c.seats.some(s => s.offerRevision > event.revision || (s.deadline !== null && s.deadline > event.closesAt))) ||
        (event.closed && (event.queue.length || event.proposals.length || event.courts.some(c => c.seats.length)))) {
        throw new TypeError('Inconsistent stored event allocation.');
    }
    return event;
}
