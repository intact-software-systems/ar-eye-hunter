import type { ApiConfig } from '@shared/api/api-config.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

/** `/api/config` as the browser reads it from any server, before or after S3c-i. */
export interface BrowserApiConfig extends ApiConfig {
    /**
     * Absent from a server that predates S3c-i: the server is not known, so a client neither addresses it nor
     * tracks it as its hop, and an app that would address it falls back (Relic: REST). Every S3c-i server serves it.
     */
    readonly serverPeerId?: string;
}

/**
 * The `/api/config` body the browser connects with. A body without `serverPeerId` comes from a server that predates
 * S3c-i and reads as "server unknown" — a distinct meaning, not a default — so a rolling deploy never strands a new
 * browser; an empty or non-string id is refused (S3c-i C5, R-S3c-i-6).
 */
export function decodeApiConfigResponse(value: unknown): Either<string, BrowserApiConfig> {
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
    if (serverPeerId === undefined) {
        return Either.ofRight({ apiBaseUrl, wsBaseUrl, endpoints: { createWs } });
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
