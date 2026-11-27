import type { GroupRef } from '@shared/api/group-types.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { requireEpoch, requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { computeAppOutboxSignal } from '../app-outbox/compute-app-outbox-signal.ts';
import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { groupStateGroupStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';

export interface RoomEventDeadline {
    readonly lobby: GroupRef;
    readonly kind: 'allocation' | 'idle' | 'departure';
    readonly causeId: string;
    readonly dueAtEpochMs: number;
}

export const ROOM_EVENT_DEADLINE_TOPIC = 'room-event.deadline';

export function decodeRoomEventDeadline(value: unknown): RoomEventDeadline {
    const row = requireRecord(value, 'Room event deadline');
    requireExactKeys(row, ['lobby', 'kind', 'causeId', 'dueAtEpochMs'], 'Room event deadline');
    requireEpoch(row.dueAtEpochMs, 'Room event deadline time');
    if (!['allocation', 'idle', 'departure'].includes(String(row.kind)) || typeof row.causeId !== 'string' || !row.causeId) throw new TypeError('Invalid event wake.');
    return { lobby: decodeExactGroupRef(row.lobby, 'Event lobby'), kind: row.kind as RoomEventDeadline['kind'], causeId: row.causeId, dueAtEpochMs: row.dueAtEpochMs };
}

export function roomEventDeadlineRoute(deadline: RoomEventDeadline) {
    return toAppQueueKey({ topicId: ROOM_EVENT_DEADLINE_TOPIC, contextId: groupStateGroupStorageKey(deadline.lobby),
        resourceId: computeSha256CanonicalJson(deadline) });
}

/** The earliest pending offer or event closure owns the single next wake. Obsolete deliveries settle current state. */
export function nextRoomEventDeadline(event: RoomEvent | null): number | null {
    if (!event || event.closed) return null;
    let due = Math.min(event.closesAt, event.handover?.expiresAt ?? event.closesAt);
    for (const court of event.courts) {
        for (const seat of court.seats) {
            if (seat.deadline !== null) due = Math.min(due, seat.deadline);
        }
    }
    return due;
}

export function computeRoomEventWake(before: RoomEvent | null, after: RoomEvent, facts: {
    readonly createdAtEpochMs: number; readonly traceId: string; readonly serviceId: string;
}) {
    const dueAtEpochMs = nextRoomEventDeadline(after);
    if (dueAtEpochMs === null) return [];
    const signals = [];
    if (nextRoomEventDeadline(before) !== dueAtEpochMs) signals.push(roomEventSignal({
        lobby: after.lobby, kind: 'allocation', causeId: String(after.revision), dueAtEpochMs
    }, facts));
    const initialIdle = after.createdAt + after.emptyReturnWindowMs;
    if (!before && initialIdle < after.closesAt) signals.push(roomEventSignal({
        lobby: after.lobby, kind: 'idle', causeId: String(after.revision), dueAtEpochMs: initialIdle
    }, facts));
    // Releasing a court or removing a player revokes its admissions without a socket disconnect.
    const revoked = before && (after.removed.length > before.removed.length || before.courts.some((court, index) =>
        court.seats.some(seat => seat.deadline === null && !after.courts[index].seats.some(next => next.principalId === seat.principalId && next.deadline === null))));
    const afterDeparture = facts.createdAtEpochMs + after.emptyReturnWindowMs;
    if (revoked && afterDeparture < after.closesAt) signals.push(roomEventSignal({
        lobby: after.lobby, kind: 'departure', causeId: String(after.revision), dueAtEpochMs: afterDeparture
    }, facts));
    return signals;
}

export function roomEventSignal(deadline: RoomEventDeadline, facts: {
    readonly createdAtEpochMs: number; readonly traceId: string; readonly serviceId: string;
}) {
    return computeAppOutboxSignal({ ...facts, ...roomEventDeadlineRoute(deadline), typeId: AppOutboxType.ROOM_EVENT_DEADLINE,
        resource: JSON.stringify(deadline), dueAtEpochMs: deadline.dueAtEpochMs, expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP });
}
