import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import type { RoomEvent } from './room-event.ts';

export function decodeEventHandover(value: unknown): RoomEvent.Handover {
    const row = requireRecord(value, 'Organizer handover');
    requireExactKeys(row, ['offerId', 'recipientId', 'offeredBy', 'expiresAt'], 'Organizer handover');
    requireEpoch(row.expiresAt, 'Handover expiry');
    const offeredBy = assertValidRallarRouteId(row.offeredBy);
    const recipientId = assertValidRallarRouteId(row.recipientId);
    if (recipientId === offeredBy) throw new TypeError('A handover needs a different organizer.');
    return { offerId: assertValidRallarRouteId(row.offerId), recipientId, offeredBy, expiresAt: row.expiresAt };
}

export function clearEventHandover(event: RoomEvent): RoomEvent {
    if (!event.handover) return event;
    const { handover, ...rest } = event;
    return rest;
}

interface HandoverChange extends RoomEvent.ChangeInput {
    readonly command: Extract<RoomEvent.Command, { action: 'offer-handover' | 'cancel-handover' | 'accept-handover' }>;
}

export function changeEventHandover(input: HandoverChange): RoomEvent {
    const { event, principalId: actor, command, nowEpochMs: now, handoverWindowMs: windowMs } = input;
    if (command.action === 'offer-handover') {
        if (actor !== event.organizerId || command.recipientId === actor || event.removed.includes(command.recipientId) || event.handover) {
            throw new TypeError('Only the organizer can offer a single pending handover to another event player.');
        }
        if (windowMs === undefined) throw new TypeError('A configured handover window is required.');
        requirePositiveInteger(windowMs, 'Handover window');
        const expiresAt = now + Math.min(event.closesAt - now, windowMs);
        return { ...event, handover: { offeredBy: actor, recipientId: command.recipientId, expiresAt, offerId: 'handover-' + (event.revision + 1) } };
    }
    const offer = event.handover;
    if (!offer || offer.offerId !== command.offerId || now >= offer.expiresAt) throw new TypeError('Handover offer has changed or expired.');
    if (command.action === 'cancel-handover') {
        if (actor !== event.organizerId) throw new TypeError('Only the organizer can cancel a handover.');
        return clearEventHandover(event);
    }
    if (actor !== offer.recipientId) throw new TypeError('Only the handover recipient can accept.');
    return { ...clearEventHandover(event), organizerId: actor };
}
