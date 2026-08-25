import { validateRuntimeStateExpiredAuthority } from '@shared-server/runtime-state/runtime-state-expired-entry.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import { clientStateSessionStorageKey } from '../persistence/client-state-session-storage-key.ts';

export function validateClientExpiredSessionAuthority(
    input: Readonly<{
        aggregateRef: ClientPrincipalRef;
        clientInstanceId: string | null;
        sessionId: string | null;
        liveSession: object | null;
        expiredSessionEntry: RuntimeStateEntry | null;
    }>
): void {
    if (input.expiredSessionEntry && (input.clientInstanceId === null || input.sessionId === null)) {
        throw new TypeError('Expired client session has no command target');
    }
    validateRuntimeStateExpiredAuthority({
        live: input.liveSession,
        expiredEntry: input.expiredSessionEntry,
        expectedKey: clientStateSessionStorageKey({
            ...input.aggregateRef,
            clientInstanceId: input.clientInstanceId ?? '',
            sessionId: input.sessionId ?? ''
        }),
        label: 'Client session read'
    });
}
