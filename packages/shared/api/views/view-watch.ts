import {
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';

/** One selected preview per authenticated client session and scope; it never grants membership or a reservation. */
export interface SessionPreviewWatchRequest {
    readonly groupId: string | null;
    readonly connectionGenerationId: string;
    readonly expectedRegistrationId: string | null;
}

/** Conflicts expose the current private slot so a still-current caller can issue a new, explicitly fenced command. */
export interface SessionPreviewWatchResult {
    readonly status: 'applied' | 'conflict';
    readonly requestId: string;
    readonly registrationId: string | null;
    readonly groupId: string | null;
}

export function decodeSessionPreviewWatchRequest(value: unknown): SessionPreviewWatchRequest {
    const request = requireRecord(value, 'Session preview watch');
    requireExactKeys(request, ['groupId', 'connectionGenerationId', 'expectedRegistrationId'], 'Session preview watch');
    requireString(request.connectionGenerationId, 'Watch connection generation');
    return {
        groupId: decodeNullableWatchIdentity(request.groupId, 'Watch group'),
        connectionGenerationId: request.connectionGenerationId,
        expectedRegistrationId: decodeNullableWatchIdentity(request.expectedRegistrationId, 'Watch predecessor')
    };
}

export function decodeSessionPreviewWatchResult(value: unknown): SessionPreviewWatchResult {
    const result = requireRecord(value, 'Session preview watch result');
    requireExactKeys(result, ['status', 'requestId', 'registrationId', 'groupId'], 'Session preview watch result');
    requireString(result.requestId, 'Watch request');
    const registrationId = decodeNullableWatchIdentity(result.registrationId, 'Watch registration');
    const groupId = decodeNullableWatchIdentity(result.groupId, 'Watch group');
    if ((registrationId === null) !== (groupId === null)) {
        throw new TypeError('A watch registration and its selected group must be present together');
    }
    return {
        status: requireOneOf(result.status, ['applied', 'conflict'], 'Watch outcome'),
        requestId: result.requestId,
        registrationId,
        groupId
    };
}

function decodeNullableWatchIdentity(value: unknown, label: string): string | null {
    if (value === null) {
        return null;
    }
    requireString(value, label);
    return value;
}
