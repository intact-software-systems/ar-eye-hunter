import type { ApiConfigResponse } from '@shared/api/api-config.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import { validateWebSocketHost } from '@shared/websocket/validate-web-socket-host.ts';

/** Decodes the current `/api/config` wire contract, including its required WS server identity. */
export function decodeApiConfigResponse(value: unknown, apiUrl: URL): Either<string, ApiConfigResponse> {
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
    const webSocketUrl = URL.parse(createWs, wsBaseUrl);
    if (
        webSocketUrl === null || (webSocketUrl.protocol !== 'ws:' && webSocketUrl.protocol !== 'wss:') ||
        webSocketUrl.username || webSocketUrl.password || webSocketUrl.hash
    ) {
        return Either.ofLeft('The /api/config response names an invalid WS base URL or WS endpoint.');
    }
    const hostMismatch = validateWebSocketHost(apiUrl, webSocketUrl);
    if (hostMismatch !== null) {
        return Either.ofLeft(hostMismatch);
    }
    return Either.ofRight({ apiBaseUrl, wsBaseUrl, endpoints: { createWs }, serverPeerId });
}

function isRecord(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
