import { decodeEventAlertConsent, decodeEventPushSubscription, decodePushEndpoint } from './room-event-alerts.ts';
import { decodeEventHandover } from './room-event-handover.ts';
import { isPlainJsonValue, type PlainJsonRecord, type PlainJsonValue } from '../../repository/compare-plain-json.ts';
import { assertCourtCapacity } from './room-event-courts.ts';
import { decodeExactGroupRef } from '../../encoding/decode-exact-group-ref.ts';
import { requireEpoch, requireExactKeys, requireExactOptionalKeys, requireRecord } from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { isGuestInvitationVerifier } from '../room-guests/invitation.ts';
import type { RoomEvent } from './room-event.ts';

export function decodeEventRecord(input: unknown, label: string): PlainJsonRecord {
    const row = requireRecord(input, label);
    if (!isPlainJsonValue(row)) throw new TypeError(label + ' must contain JSON values.');
    return row;
}

export function decodeEventOffer(value: PlainJsonValue | undefined): RoomEvent.Offer {
    const row = requireRecord(value, 'Court offer');
    requireExactKeys(row, ['groupId', 'partyId', 'occurrence', 'offerRevision', 'deadline'], 'Court offer');
    const occurrence = positive(row.occurrence, 'Court occurrence');
    const offerRevision = positive(row.offerRevision, 'Offer revision');
    if (row.deadline !== null) requireEpoch(row.deadline, 'Claim deadline');
    return { groupId: assertValidRallarRouteId(row.groupId), partyId: assertValidRallarRouteId(row.partyId),
        occurrence, offerRevision, deadline: row.deadline };
}

export function decodeExpiredEventOffer(value: PlainJsonValue | undefined): RoomEvent.ExpiredOffer {
    const offer = decodeEventOffer(value);
    if (offer.deadline === null) throw new TypeError('An expired court offer must have a deadline.');
    return { ...offer, deadline: offer.deadline };
}

function positive(value: PlainJsonValue | undefined, label: string): number {
    requireEpoch(value, label);
    if (!value) throw new TypeError(label + ' must be positive.');
    return value;
}

function boolean(value: PlainJsonValue | undefined): boolean {
    if (typeof value !== 'boolean') throw new TypeError('Expected an event boolean.');
    return value;
}

function rows<T>(value: PlainJsonValue | undefined, read: (entry: PlainJsonValue) => T): T[] {
    if (!Array.isArray(value)) throw new TypeError('Expected an event collection.');
    return value.map(read);
}

function ids(value: PlainJsonValue | undefined): string[] {
    const result = rows(value, entry => assertValidRallarRouteId(entry));
    if (new Set(result).size !== result.length) throw new TypeError('Duplicate event identity.');
    return result;
}

function courtSetup(value: PlainJsonValue): RoomEvent.CourtSetup {
    const court = decodeEventRecord(value, 'Court settings');
    requireExactKeys(court, ['groupId','capacity'], 'Court settings');
    const capacity = positive(court.capacity, 'Court capacity');
    assertCourtCapacity(capacity);
    return { groupId: assertValidRallarRouteId(court.groupId), capacity };
}

export function decodeRoomEventCommand(value: unknown): RoomEvent.Command {
    const c = decodeEventRecord(value, 'Room event command');
    switch (c.action) {
        case 'create': {
            requireExactOptionalKeys({ value: c, required: ['action','courts','closesAt'], optional: ['claimWindowMs','emptyReturnWindowMs'], label: 'Event creation' });
            requireEpoch(c.closesAt, 'Closing time');
            return { action: c.action, courts: rows(c.courts, courtSetup), closesAt: c.closesAt,
                ...(c.emptyReturnWindowMs !== undefined && { emptyReturnWindowMs: positive(c.emptyReturnWindowMs, 'Event return window') }),
                ...(c.claimWindowMs !== undefined && { claimWindowMs: positive(c.claimWindowMs, 'Court claim window') }) };
        }
        case 'enable-court-alerts':
            requireExactKeys(c, ['action','subscription'], 'Enable court alerts');
            return { action: c.action, subscription: decodeEventPushSubscription(c.subscription) };
        case 'disable-court-alerts':
            requireExactKeys(c, ['action','endpoint'], 'Disable court alerts');
            return { action: c.action, endpoint: decodePushEndpoint(c.endpoint) };
        case 'offer-handover':
            requireExactKeys(c, ['action', 'recipientId'], 'Offer handover');
            return { action: c.action, recipientId: assertValidRallarRouteId(c.recipientId) };
        case 'accept-handover': case 'cancel-handover':
            requireExactKeys(c, ['action', 'offerId'], 'Respond to handover');
            return { action: c.action, offerId: assertValidRallarRouteId(c.offerId) };
        case 'propose':
            requireExactKeys(c, ['action','partyId','players'], 'Event party proposal');
            return { action: c.action, partyId: assertValidRallarRouteId(c.partyId), players: ids(c.players) };
        case 'accept':
            requireExactKeys(c, ['action','partyId','proposalRevision'], 'Accept party');
            return { action: c.action, partyId: assertValidRallarRouteId(c.partyId), proposalRevision: positive(c.proposalRevision, 'Proposal revision') };
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

export function decodeEventParty(value: PlainJsonValue | undefined): RoomEvent.Party {
    const row = decodeEventRecord(value, 'Party');
    requireExactKeys(row, ['id','players'], 'Party');
    const players = ids(row.players);
    if (!players.length) throw new TypeError('An event party needs players.');
    return { id: assertValidRallarRouteId(row.id), players };
}

export function decodeEventProposal(value: PlainJsonValue | undefined): RoomEvent.Proposal {
    const row = decodeEventRecord(value, 'Party proposal');
    const { accepted, proposalRevision, ...rest } = row;
    const group = decodeEventParty(rest);
    const consent = ids(accepted);
    if (!consent.length || consent.length >= group.players.length || consent.some(id => !group.players.includes(id))) {
        throw new TypeError('Invalid party consent.');
    }
    return { ...group, accepted: consent, proposalRevision: positive(proposalRevision, 'Proposal revision') };
}

export function decodeEventCourt(value: PlainJsonValue): RoomEvent.Court {
    const { occurrence, seats: stored, ...setup } = decodeEventRecord(value, 'Court');
    const settings = courtSetup(setup);
    const seats = rows(stored, seat => {
        const row = decodeEventRecord(seat, 'Court seat');
        requireExactKeys(row, ['principalId','partyId','offerRevision','deadline'], 'Court seat');
        if (row.deadline !== null) requireEpoch(row.deadline, 'Claim deadline');
        return { principalId: assertValidRallarRouteId(row.principalId), partyId: assertValidRallarRouteId(row.partyId), offerRevision: positive(row.offerRevision, 'Offer revision'), deadline: row.deadline };
    });
    if (seats.length > settings.capacity) throw new TypeError('Court exceeds its capacity.');
    return { ...settings, occurrence: positive(occurrence, 'Court occurrence'), seats };
}

export function decodeRoomEvent(value: unknown): RoomEvent {
    const e = decodeEventRecord(value, 'Room event');
    requireExactOptionalKeys({ value: e, required: ['lobby','organizerId','createdAt','emptyReturnWindowMs','revision','closesAt','claimWindowMs','closed','courts','queue','proposals','removed'], optional: ['handover', 'alerts', 'expiredOffers'], label: 'Room event' });
    requireEpoch(e.createdAt, 'Event creation time');
    const event = { ...(e.handover === undefined ? {} : { handover: decodeEventHandover(e.handover) }), createdAt: e.createdAt, emptyReturnWindowMs: positive(e.emptyReturnWindowMs, 'Event return window'),
        lobby: decodeExactGroupRef(e.lobby, 'Event lobby'), organizerId: assertValidRallarRouteId(e.organizerId),
        revision: positive(e.revision, 'Event revision'), closesAt: positive(e.closesAt, 'Event closing time'),
        claimWindowMs: positive(e.claimWindowMs, 'Court claim window'), closed: boolean(e.closed),
        ...(e.alerts !== undefined && { alerts: rows(e.alerts, decodeEventAlertConsent) }),
        ...(e.expiredOffers !== undefined && { expiredOffers: rows(e.expiredOffers, value => {
            const row = decodeEventRecord(value, 'Expired player offer');
            requireExactKeys(row, ['principalId', 'offer'], 'Expired player offer');
            return { principalId: assertValidRallarRouteId(row.principalId), offer: decodeExpiredEventOffer(row.offer) };
        }) }),
        courts: rows(e.courts, decodeEventCourt), queue: rows(e.queue, decodeEventParty), proposals: rows(e.proposals, decodeEventProposal), removed: ids(e.removed) };
    if (event.alerts && (event.closed || !event.alerts.length ||
        new Set(event.alerts.map(consent => consent.subscription.endpoint)).size !== event.alerts.length ||
        event.alerts.some(consent => consent.revision > event.revision || event.removed.includes(consent.principalId)))) {
        throw new TypeError('Inconsistent event alert consent.');
    }
    if (event.handover && (event.closed || event.handover.offeredBy !== event.organizerId || event.handover.expiresAt > event.closesAt ||
        event.removed.includes(event.handover.recipientId))) throw new TypeError('Inconsistent stored handover.');
    if (!event.courts.length) throw new TypeError('Stored event has no courts.');
    ids([event.lobby.groupId, ...event.courts.map(c => c.groupId)]);
    ids([...(event.expiredOffers ?? []).map(row => row.principalId), ...event.queue.flatMap(p => p.players), ...event.courts.flatMap(c => c.seats.map(s => s.principalId)), ...event.removed]);
    ids([...event.queue, ...event.proposals].map(p => p.id));
    if (event.expiredOffers?.length === 0 || event.expiredOffers?.some(({ offer }) => event.closed || offer.offerRevision > event.revision || offer.deadline > event.closesAt ||
        !event.courts.some(court => court.groupId === offer.groupId && court.occurrence >= offer.occurrence))) {
        throw new TypeError('Inconsistent expired court offer.');
    }
    if (event.removed.includes(event.organizerId) || event.proposals.some(p => p.proposalRevision > event.revision || p.players.some(id => event.removed.includes(id))) ||
        event.courts.some(c => c.seats.some(s => s.offerRevision > event.revision || (s.deadline !== null && s.deadline > event.closesAt))) ||
        (event.closed && (event.queue.length || event.proposals.length || event.courts.some(c => c.seats.length)))) {
        throw new TypeError('Inconsistent stored event allocation.');
    }
    return event;
}
