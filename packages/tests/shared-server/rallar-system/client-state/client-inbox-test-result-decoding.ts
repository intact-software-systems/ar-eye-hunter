import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import {
    decodeClientStateWritten,
    type AuthorisedWsClientMutationResult
} from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-result-codec.ts';
import { requireExactKeys, requireString } from '@shared-server/rallar-system/protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

/** Reads the durable result of an authorised websocket connect or disconnect, which production never waits for. */
export function decodeAuthorisedWsClientTestResult(value: JsonWireValue): AuthorisedWsClientMutationResult {
    if (!isJsonWireObject(value) || value.status !== 'inactive') {
        return decodeClientStateWritten(value);
    }
    const { sessionId, generationId } = value;
    requireExactKeys(value, ['status', 'sessionId', 'generationId'], 'Authorised websocket client result');
    requireString(sessionId, 'Authorised websocket client result sessionId');
    requireString(generationId, 'Authorised websocket client result generationId');
    return { status: 'inactive', sessionId, generationId };
}

/** Reads the durable result of one expired-sessions page, which production never waits for. */
export function decodeExpiredClientSessionsTestResult(value: JsonWireValue): readonly ClientStateWritten[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Expired client sessions result must be an array');
    }
    return value.map(decodeClientStateWritten);
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
