import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { decodeClientStateWritten } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-result-codec.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

/** Reads the durable result of one expired-sessions page, which production never waits for. */
export function decodeExpiredClientSessionsTestResult(value: JsonWireValue): readonly ClientStateWritten[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Expired client sessions result must be an array');
    }
    return value.map(decodeClientStateWritten);
}
