import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requirePositiveInteger,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import { GROUP_POLICY_REASON_CODES } from '../group-policy-types.ts';
import { toCanonicalGroupRef } from '../group-types.ts';
import { assertValidRallarGroupRef } from '../rallar-validation.ts';
import {
    assertGroupSessionSchedule,
    toGroupSessionTiming,
    type GroupSessionPage,
    type GroupSessionPreview,
    type GroupSessionSchedule,
    type GroupSessionTiming
} from './group-session-schedule.ts';

/** Decode only the public projection; private reservation or membership rows are never accepted. */
export function decodeGroupSessionPreview(value: unknown): GroupSessionPreview {
    const preview = requireRecord(value, 'Session preview');
    requireExactKeys(preview, [
        'roomRef',
        'displayName',
        'schedule',
        'timing',
        'serverNowEpochMs',
        'maxPlayers',
        'availableSeats',
        'participation',
        'isOrganizer',
        'canReserve',
        'canEnter',
        'admissionDenial'
    ], 'Session preview');
    const ref = requireRecord(preview.roomRef, 'Session room');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Session room');
    const roomRef = toCanonicalGroupRef(assertValidRallarGroupRef(ref));
    requireString(preview.displayName, 'Session name');
    assertGroupSessionSchedule(preview.schedule);
    requireEpoch(preview.serverNowEpochMs, 'Session server clock');
    const timing = decodeSessionTiming(preview.timing, preview.schedule, preview.serverNowEpochMs);
    requireEpoch(preview.maxPlayers, 'Session capacity');
    requirePositiveInteger(preview.maxPlayers, 'Session capacity');
    requireEpoch(preview.availableSeats, 'Session available seats');
    if (preview.maxPlayers > 64 || preview.availableSeats > preview.maxPlayers) {
        throw new TypeError('Session capacity or available seats are out of range');
    }
    if (
        typeof preview.isOrganizer !== 'boolean' || typeof preview.canReserve !== 'boolean' ||
        typeof preview.canEnter !== 'boolean'
    ) {
        throw new TypeError('Session permissions must be booleans');
    }
    return {
        roomRef,
        displayName: preview.displayName,
        schedule: { ...preview.schedule },
        timing,
        serverNowEpochMs: preview.serverNowEpochMs,
        maxPlayers: preview.maxPlayers,
        availableSeats: preview.availableSeats,
        participation: requireOneOf(
            preview.participation,
            ['none', 'reserved', 'admitted', 'needs-confirmation'],
            'Session participation'
        ),
        isOrganizer: preview.isOrganizer,
        canReserve: preview.canReserve,
        canEnter: preview.canEnter,
        admissionDenial: preview.admissionDenial === null
            ? null
            : requireOneOf(preview.admissionDenial, GROUP_POLICY_REASON_CODES, 'Session admission denial')
    };
}

function decodeSessionTiming(value: unknown, schedule: GroupSessionSchedule, nowEpochMs: number): GroupSessionTiming {
    const timing = toGroupSessionTiming(schedule, nowEpochMs);
    const receivedTiming = requireRecord(value, 'Session timing');
    requireExactKeys(receivedTiming, Object.keys(timing), 'Session timing');
    if (Object.entries(timing).some(([key, expected]) => receivedTiming[key] !== expected)) {
        throw new TypeError('Session timing differs from its schedule and server clock');
    }
    return timing;
}

export function decodeGroupSessionPage(value: unknown): GroupSessionPage {
    const page = requireRecord(value, 'Session page');
    requireExactKeys(page, ['sessions', 'nextKey'], 'Session page');
    if (!Array.isArray(page.sessions) || page.sessions.length > 32) {
        throw new TypeError('Session page must contain at most 32 sessions');
    }
    const sessions = Array.from(page.sessions, decodeGroupSessionPreview);
    if (new Set(sessions.map((session) => JSON.stringify(session.roomRef))).size !== sessions.length) {
        throw new TypeError('Session page repeats a room');
    }
    if (page.nextKey !== null) {
        requireString(page.nextKey, 'Session page cursor');
    }
    return { sessions, nextKey: page.nextKey };
}
