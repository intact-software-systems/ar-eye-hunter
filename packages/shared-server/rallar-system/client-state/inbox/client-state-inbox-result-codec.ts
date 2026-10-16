import {
    validateAuthoritativeClientEvent,
    validateAuthoritativeClientSnapshot
} from '@shared/api/authoritative-state-validation.ts';

import { requireExactKeys } from '../../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { ClientStateWritten } from '../client-state-service-contracts.ts';

export interface InactiveAuthorisedWsSessionResult {
    readonly status: 'inactive';
    readonly sessionId: string;
    readonly generationId: string;
}

export type AuthorisedWsClientMutationResult = ClientStateWritten | InactiveAuthorisedWsSessionResult;

export function decodeClientStateWritten(value: JsonWireValue): ClientStateWritten {
    const written = requireJsonWireRecord(value, 'Client state result');
    requireExactKeys(written, ['status', 'result'], 'Client state result');
    if (written.status !== 'ok') {
        throw new TypeError('Client state result status is invalid');
    }
    return { status: 'ok', result: decodeClientMutationWritten(written.result) };
}

function decodeClientMutationWritten(value: JsonWireValue): ClientStateWritten['result'] {
    const written = requireJsonWireRecord(value, 'Client state mutation result');
    requireExactKeys(written, ['snapshot', 'event'], 'Client state mutation result');
    validateAuthoritativeClientSnapshot(written.snapshot);
    if (written.event !== null) {
        validateAuthoritativeClientEvent(written.event, {
            applicationId: written.snapshot.principal.applicationId,
            workspaceId: written.snapshot.principal.workspaceId,
            principalId: written.snapshot.principal.principalId
        });
    }
    return { snapshot: written.snapshot, event: written.event };
}

function requireJsonWireRecord(value: JsonWireValue, label: string): JsonWireObject {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return Object.fromEntries(Object.entries(value));
}
