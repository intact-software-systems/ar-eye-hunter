import { decodeExactGroupRef } from '../../encoding/decode-exact-group-ref.ts';
import { requireEpoch, requireExactKeys, requireRecord } from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { decodeEventParty, decodeEventProposal } from './decode-room-event.ts';
import type { RoomEvent } from './room-event.ts';

function decodeOffer(value: unknown): RoomEvent.Offer {
    const row = requireRecord(value, 'Court offer');
    requireExactKeys(row, ['groupId', 'partyId', 'occurrence', 'offerRevision', 'deadline'], 'Court offer');
    requireEpoch(row.occurrence, 'Court occurrence');
    requireEpoch(row.offerRevision, 'Offer revision');
    if (!row.offerRevision) throw new TypeError('Invalid offer revision.');
    if (row.deadline !== null) requireEpoch(row.deadline, 'Claim deadline');
    return { groupId: assertValidRallarRouteId(row.groupId), partyId: assertValidRallarRouteId(row.partyId),
        occurrence: row.occurrence, offerRevision: row.offerRevision, deadline: row.deadline };
}

function decodeCourt(value: unknown): RoomEvent.View['courts'][number] {
    const row = requireRecord(value, 'Event court');
    requireExactKeys(row, ['groupId', 'capacity', 'occurrence', 'availableSeats'], 'Event court');
    requireEpoch(row.capacity, 'Court capacity');
    requireEpoch(row.occurrence, 'Court occurrence');
    requireEpoch(row.availableSeats, 'Available seats');
    if (!row.capacity || !row.occurrence || row.availableSeats > row.capacity) throw new TypeError('Invalid court availability.');
    return { groupId: assertValidRallarRouteId(row.groupId), capacity: row.capacity,
        occurrence: row.occurrence, availableSeats: row.availableSeats };
}

export function decodeRoomEventView(value: unknown): RoomEvent.View {
    const row = requireRecord(value, 'Private event view');
    requireExactKeys(row, ['principalId', 'lobby', 'revision', 'closesAt', 'closed', 'courts', 'queue', 'proposals', 'offer'], 'Private event view');
    const lobby = decodeExactGroupRef(row.lobby, 'Event lobby');
    const principalId = assertValidRallarRouteId(row.principalId);
    requireEpoch(row.revision, 'Event revision');
    requireEpoch(row.closesAt, 'Event closing time');
    if (!row.revision || typeof row.closed !== 'boolean' || !Array.isArray(row.proposals) || !Array.isArray(row.courts)) {
        throw new TypeError('Invalid private event view.');
    }
    const courts = row.courts.map(decodeCourt);
    const proposals = row.proposals.map(decodeEventProposal);
    const queue = row.queue === null ? null : decodeEventParty(row.queue);
    const offer = row.offer === null ? null : decodeOffer(row.offer);
    if (!courts.length || new Set([lobby.groupId, ...courts.map(c => c.groupId)]).size !== courts.length + 1 ||
        (queue && !queue.players.includes(principalId)) || proposals.some(p => !p.players.includes(principalId)) ||
        (offer && (offer.offerRevision > row.revision || queue || !courts.some(c => c.groupId === offer.groupId && c.occurrence === offer.occurrence) ||
            (offer.deadline !== null && offer.deadline > row.closesAt))) ||
        (row.closed && (offer || queue || proposals.length || courts.some(c => c.availableSeats > 0)))) {
        throw new TypeError('Inconsistent private event view.');
    }
    return { principalId, lobby, courts, proposals, queue, offer, closed: row.closed, revision: row.revision, closesAt: row.closesAt };
}
