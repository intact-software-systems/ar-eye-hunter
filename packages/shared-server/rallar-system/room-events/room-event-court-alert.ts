import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { playerOffer } from '@shared/api/room-events/room-event-courts.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { groupStateGroupStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { computeAppOutboxSignal } from '../app-outbox/compute-app-outbox-signal.ts';

export interface RoomEventCourtAlert {
    readonly lobby: GroupRef;
    readonly principalId: string;
    readonly consentRevision: number;
    readonly offerRevision: number;
    readonly dueAtEpochMs: number;
}

export const ROOM_EVENT_COURT_ALERT_TOPIC = 'room-event.court-alert';

export function decodeRoomEventCourtAlert(value: unknown): RoomEventCourtAlert {
    const row = requireRecord(value, 'Court alert');
    requireExactKeys(row, ['lobby','principalId','consentRevision','offerRevision','dueAtEpochMs'], 'Court alert');
    requirePositiveInteger(row.consentRevision, 'Device consent revision');
    requirePositiveInteger(row.offerRevision, 'Offer revision');
    requireEpoch(row.dueAtEpochMs, 'Alert delivery time');
    return { lobby: decodeExactGroupRef(row.lobby, 'Alert lobby'), principalId: assertValidRallarRouteId(row.principalId),
        consentRevision: Number(row.consentRevision), offerRevision: Number(row.offerRevision), dueAtEpochMs: row.dueAtEpochMs };
}

export function roomEventCourtAlertRoute(alert: RoomEventCourtAlert) {
    return toAppQueueKey({ topicId: ROOM_EVENT_COURT_ALERT_TOPIC, contextId: groupStateGroupStorageKey(alert.lobby),
        resourceId: computeSha256CanonicalJson({ lobby: alert.lobby, consent: alert.consentRevision, offer: alert.offerRevision }) });
}

export function computeCourtAlertSignals(before: RoomEvent | null, after: RoomEvent, facts: {
    readonly createdAtEpochMs: number; readonly traceId: string; readonly serviceId: string;
}) {
    return (after.alerts ?? []).flatMap(consent => {
        const offer = playerOffer(after, consent.principalId);
        if (!offer || offer.deadline === null) return [];
        if (before?.alerts?.some(previous => previous.revision === consent.revision) &&
            playerOffer(before, consent.principalId)?.offerRevision === offer.offerRevision) return [];
        const alert: RoomEventCourtAlert = { lobby: after.lobby, principalId: consent.principalId, consentRevision: consent.revision,
            offerRevision: offer.offerRevision, dueAtEpochMs: facts.createdAtEpochMs };
        return [computeAppOutboxSignal({ ...facts, ...roomEventCourtAlertRoute(alert), typeId: AppOutboxType.ROOM_EVENT_COURT_ALERT,
            resource: JSON.stringify(alert), dueAtEpochMs: alert.dueAtEpochMs, expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP })];
    });
}
