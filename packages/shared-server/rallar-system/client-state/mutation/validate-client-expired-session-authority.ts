import { validateRuntimeStateExpiredAuthority } from '@shared-server/runtime-state/RuntimeStateExpiredEntry.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import { clientStateSessionStorageKey } from '../persistence/client-state-storage-keys.ts';

export function validateClientExpiredSessionAuthority(
    input: Readonly<{
        aggregateRef: ClientPrincipalRef;
        clientInstanceId: string | null;
        sessionId: string | null;
        liveSession: unknown;
        expiredSessionEntry: RuntimeStateEntry | null;
    }>
): void {
    if (input.expiredSessionEntry && (input.clientInstanceId === null || input.sessionId === null)) {
        throw new TypeError('Expired client session has no command target');
    }
    validateRuntimeStateExpiredAuthority(
        input.liveSession,
        input.expiredSessionEntry,
        clientStateSessionStorageKey({
            ...input.aggregateRef,
            clientInstanceId: input.clientInstanceId ?? '',
            sessionId: input.sessionId ?? ''
        }),
        'Client session read'
    );
}
