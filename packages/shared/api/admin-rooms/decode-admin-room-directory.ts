import {
    requireEpoch,
    requireExactKeys,
    requireNullableEpoch,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import type { GroupRef, GroupScope } from '../group-types.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { decodeStateScope } from '../state-types.ts';
import type {
    AdminRoomDirectoryEntry,
    AdminRoomDirectoryRequest,
    AdminRoomDirectoryResponse,
    AdminRoomSummary
} from './admin-room-directory.ts';

/** Private diagnostic responses must match the requested scope and retain explicit validity. */
export function decodeAdminRoomDirectory(
    value: unknown,
    request: AdminRoomDirectoryRequest
): AdminRoomDirectoryResponse {
    const page = requireRecord(value, 'Room directory');
    requireExactKeys(
        page,
        ['scope', 'observedAtEpochMs', 'completeness', 'entries', 'nextAfterGroupId'],
        'Room directory'
    );
    const scope = decodeStateScope(page.scope);
    assertRequestedScope(scope, request.scope);
    requireEpoch(page.observedAtEpochMs, 'Room observation time');
    if (!Array.isArray(page.entries) || page.entries.length > request.limit || page.entries.length > 100) {
        throw new TypeError('Room directory exceeds the requested bound');
    }
    const entries = page.entries.map((entry) => decodeDirectoryEntry(entry, scope));
    const identities = entries.map((entry) =>
        entry.status === 'valid' ? entry.room.roomRef.groupId : entry.roomRef.groupId
    );
    if (new Set(identities).size !== identities.length || identities.includes(request.afterGroupId ?? '')) {
        throw new TypeError('Room directory repeats an identity');
    }
    const completeness = requireOneOf(page.completeness, ['complete', 'partial'], 'Room directory completeness');
    if ((completeness === 'partial') !== entries.some((entry) => entry.status === 'invalid')) {
        throw new TypeError('Room directory completeness contradicts its entries');
    }
    const nextAfterGroupId = page.nextAfterGroupId === null ? null : assertValidRallarRouteId(page.nextAfterGroupId);
    if (nextAfterGroupId !== null && nextAfterGroupId === request.afterGroupId) {
        throw new TypeError('Room directory cursor did not advance');
    }
    return { scope, observedAtEpochMs: page.observedAtEpochMs, completeness, entries, nextAfterGroupId };
}

function decodeDirectoryEntry(value: unknown, scope: GroupScope): AdminRoomDirectoryEntry {
    const entry = requireRecord(value, 'Room directory entry');
    const status = requireOneOf(entry.status, ['valid', 'invalid'], 'Room entry status');
    if (status === 'invalid') {
        requireExactKeys(entry, ['status', 'roomRef', 'reason'], 'Invalid room entry');
        return {
            status,
            roomRef: decodeRoomRef(entry.roomRef, scope),
            reason: requireOneOf(entry.reason, ['invalid-room-record'], 'Invalid room reason')
        };
    }
    requireExactKeys(entry, ['status', 'room'], 'Valid room entry');
    return { status, room: decodeRoomSummary(entry.room, scope) };
}

function decodeRoomSummary(value: unknown, scope: GroupScope): AdminRoomSummary {
    const room = requireRecord(value, 'Room summary');
    requireExactKeys(room, [
        'roomRef',
        'displayName',
        'kind',
        'status',
        'joinMode',
        'directoryListing',
        'activeMemberCount',
        'maxMembers',
        'expiresAtEpochMs'
    ], 'Room summary');
    requireString(room.displayName, 'Room name');
    requireEpoch(room.activeMemberCount, 'Room member count');
    requireNullableEpoch(room.maxMembers, 'Room capacity');
    requireNullableEpoch(room.expiresAtEpochMs, 'Room expiry');
    const maxMembers = room.maxMembers as number | null;
    if (room.activeMemberCount < 1 || (maxMembers !== null && maxMembers < 1)) {
        throw new TypeError('Room member count or capacity is invalid');
    }
    return {
        roomRef: decodeRoomRef(room.roomRef, scope),
        displayName: room.displayName,
        kind: requireOneOf(room.kind, ['party', 'room', 'team', 'custom'], 'Room kind'),
        status: requireOneOf(room.status, ['active', 'archived'], 'Room status'),
        joinMode: requireOneOf(room.joinMode, ['open', 'code', 'invite-only'], 'Room admission'),
        directoryListing: requireOneOf(room.directoryListing, ['listed', 'unlisted'], 'Room listing'),
        activeMemberCount: room.activeMemberCount,
        maxMembers,
        expiresAtEpochMs: room.expiresAtEpochMs as number | null
    };
}

function decodeRoomRef(value: unknown, scope: GroupScope): GroupRef {
    const ref = requireRecord(value, 'Room identity');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Room identity');
    const decoded = {
        applicationId: assertValidRallarRouteId(ref.applicationId),
        workspaceId: assertValidRallarRouteId(ref.workspaceId),
        groupId: assertValidRallarRouteId(ref.groupId)
    };
    assertRequestedScope(decoded, scope);
    return decoded;
}

function assertRequestedScope(actual: GroupScope, expected: GroupScope): void {
    if (actual.applicationId !== expected.applicationId || actual.workspaceId !== expected.workspaceId) {
        throw new TypeError('Room directory contains a foreign scope');
    }
}
