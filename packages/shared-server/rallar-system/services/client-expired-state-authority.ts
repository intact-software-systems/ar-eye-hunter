import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { RuntimeStateEntry } from '../../runtime-state/RuntimeStateRepository.ts';
import { validateRuntimeStateExpiredAuthority } from '../../runtime-state/RuntimeStateExpiredEntry.ts';
import { clientStateSessionStorageKey } from '../client-state-storage-keys.ts';

export function validateClientExpiredSessionAuthority(input: Readonly<{
    aggregateRef: ClientPrincipalRef;
    clientInstanceId: string | null;
    sessionId: string | null;
    liveSession: unknown;
    expiredSessionEntry: RuntimeStateEntry | null;
}>): void {
    if (input.expiredSessionEntry &&
        (input.clientInstanceId === null || input.sessionId === null)) {
        throw new TypeError('Expired client session has no command target');
    }
    validateRuntimeStateExpiredAuthority(
        input.liveSession,
        input.expiredSessionEntry,
        clientStateSessionStorageKey({
            ...input.aggregateRef,
            clientInstanceId: input.clientInstanceId ?? '',
            sessionId: input.sessionId ?? '',
        }),
        'Client session read',
    );
}
