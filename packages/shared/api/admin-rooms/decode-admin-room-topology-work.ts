import { isSameGroupRef } from '../api-type-utils.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import { toCanonicalGroupRef } from '../group-types.ts';
import { assertValidRallarGroupRef } from '../rallar-validation.ts';
import {
    ADMIN_ROOM_TOPOLOGY_WORK_STATUSES,
    type AdminRoomTopologyWorkRequest,
    type AdminRoomTopologyWorkResponse
} from './admin-room-topology-work.ts';

export function decodeAdminRoomTopologyWork(
    value: unknown,
    request: AdminRoomTopologyWorkRequest
): AdminRoomTopologyWorkResponse {
    const response = requireRecord(value, 'Topology work outcome');
    requireExactKeys(response, [
        'roomRef',
        'outboxId',
        'observedAtEpochMs',
        'status',
        'attempts',
        'settledAtEpochMs'
    ], 'Topology work outcome');
    const identity = requireRecord(response.roomRef, 'Topology work room');
    requireExactKeys(identity, ['applicationId', 'workspaceId', 'groupId'], 'Topology work room');
    const roomRef = toCanonicalGroupRef(assertValidRallarGroupRef(identity));
    const outboxId = decodeAdminTopologyOutboxId(response.outboxId);
    if (!isSameGroupRef(roomRef, request.roomRef) || outboxId !== request.outboxId) {
        throw new TypeError('Topology work outcome belongs to another room or receipt');
    }
    requireEpoch(response.observedAtEpochMs, 'Topology observation time');
    const status = requireOneOf(response.status, ADMIN_ROOM_TOPOLOGY_WORK_STATUSES, 'Topology work status');
    const attempts = response.attempts;
    if (attempts !== null && (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0)) {
        throw new TypeError('Topology work attempts must be a non-negative integer or null');
    }
    const settledAtEpochMs = response.settledAtEpochMs;
    if (settledAtEpochMs !== null) {
        requireEpoch(settledAtEpochMs, 'Topology settlement time');
    }
    if (
        (status === 'unknown' && (attempts !== null || settledAtEpochMs !== null)) ||
        (status !== 'unknown' && attempts === null) ||
        (status === 'pending' && settledAtEpochMs !== null) ||
        (status === 'completed' && settledAtEpochMs === null)
    ) {
        throw new TypeError('Topology work outcome evidence is contradictory');
    }
    return { roomRef, outboxId, observedAtEpochMs: response.observedAtEpochMs, status, attempts, settledAtEpochMs };
}

/** A command's outbox identity includes a suffix beyond the request route ID. */
export function decodeAdminTopologyOutboxId(value: unknown): string {
    requireString(value, 'Topology work receipt identity');
    if (value.length > 256) {
        throw new TypeError('Topology work receipt identity is too long');
    }
    return value;
}
