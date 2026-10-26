import type { ApiConfigResponse } from '@shared/api/api-config.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

/** Decodes the current `/api/config` wire contract, including its required WS server identity. */
export function decodeApiConfigResponse(value: unknown): Either<string, ApiConfigResponse> {
    if (!isRecord(value) || !isRecord(value.endpoints)) {
        return Either.ofLeft('The /api/config response is not an object with endpoints.');
    }
    const { apiBaseUrl, wsBaseUrl, serverPeerId } = value;
    const createWs = value.endpoints.createWs;
    if (
        typeof apiBaseUrl !== 'string' || typeof wsBaseUrl !== 'string' ||
        typeof createWs !== 'string'
    ) {
        return Either.ofLeft(
            'The /api/config response names no API base URL, WS base URL or WS endpoint.'
        );
    }
    if (typeof serverPeerId !== 'string' || serverPeerId.length === 0) {
        return Either.ofLeft(
            'The /api/config response names an empty or non-string WS server peer id.'
        );
    }
    return Either.ofRight({ apiBaseUrl, wsBaseUrl, endpoints: { createWs }, serverPeerId });
}

function isRecord(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
