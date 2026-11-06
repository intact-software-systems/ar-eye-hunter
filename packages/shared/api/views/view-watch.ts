import {
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';

export const VIEW_WATCH_FAMILIES = ['session-preview', 'tournament'] as const;
export type ViewWatchFamily = typeof VIEW_WATCH_FAMILIES[number];

export function decodeViewWatchFamily(value: unknown): ViewWatchFamily {
    return requireOneOf(value, VIEW_WATCH_FAMILIES, 'View watch family');
}

/** One selected resource per family, authenticated client session and scope; it never grants membership or a reservation. */
export interface ViewWatchRequest {
    readonly resourceId: string | null;
    readonly connectionGenerationId: string;
    readonly expectedRegistrationId: string | null;
}

/** Conflicts expose the current private slot so a still-current caller can issue a new, explicitly fenced command. */
export interface ViewWatchResult {
    readonly status: 'applied' | 'conflict';
    readonly requestId: string;
    readonly registrationId: string | null;
    readonly resourceId: string | null;
}

export function decodeViewWatchRequest(value: unknown): ViewWatchRequest {
    const request = requireRecord(value, 'Selected view watch');
    requireExactKeys(
        request,
        ['resourceId', 'connectionGenerationId', 'expectedRegistrationId'],
        'Selected view watch'
    );
    requireString(request.connectionGenerationId, 'Watch connection generation');
    return {
        resourceId: decodeNullableWatchIdentity(request.resourceId, 'Watch resource'),
        connectionGenerationId: request.connectionGenerationId,
        expectedRegistrationId: decodeNullableWatchIdentity(request.expectedRegistrationId, 'Watch predecessor')
    };
}

export function decodeViewWatchResult(value: unknown): ViewWatchResult {
    const result = requireRecord(value, 'Selected view watch result');
    requireExactKeys(result, ['status', 'requestId', 'registrationId', 'resourceId'], 'Selected view watch result');
    requireString(result.requestId, 'Watch request');
    const registrationId = decodeNullableWatchIdentity(result.registrationId, 'Watch registration');
    const resourceId = decodeNullableWatchIdentity(result.resourceId, 'Watch resource');
    if ((registrationId === null) !== (resourceId === null)) {
        throw new TypeError('A watch registration and its selected resource must be present together');
    }
    return {
        status: requireOneOf(result.status, ['applied', 'conflict'], 'Watch outcome'),
        requestId: result.requestId,
        registrationId,
        resourceId
    };
}

function decodeNullableWatchIdentity(value: unknown, label: string): string | null {
    if (value === null) {
        return null;
    }
    requireString(value, label);
    return value;
}
