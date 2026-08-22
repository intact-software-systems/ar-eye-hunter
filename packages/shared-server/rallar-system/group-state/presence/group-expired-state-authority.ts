import type { GroupRef } from '@shared/api/group-types.ts';
import { validateRuntimeStateExpiredAuthority } from '../../../runtime-state/RuntimeStateExpiredEntry.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/RuntimeStateRepository.ts';
import {
    groupStateGroupStorageKey,
    groupStatePresenceSessionStorageKey
} from '../persistence/group-state-storage-keys.ts';

export function validateGroupExpiredStateAuthority(
    input: Readonly<{
        ref: GroupRef;
        targetSessionId: string | null;
        group: unknown;
        expiredGroupEntry: RuntimeStateEntry | null;
        targetPresence: unknown;
        expiredTargetPresenceEntry: RuntimeStateEntry | null;
    }>
): void {
    validateRuntimeStateExpiredAuthority(
        input.group,
        input.expiredGroupEntry,
        groupStateGroupStorageKey(input.ref),
        'Group read'
    );
    if (input.expiredTargetPresenceEntry && input.targetSessionId === null) {
        throw new TypeError('Presence read has expired authority without a target session');
    }
    validateRuntimeStateExpiredAuthority(
        input.targetPresence,
        input.expiredTargetPresenceEntry,
        groupStatePresenceSessionStorageKey({
            ...input.ref,
            sessionId: input.targetSessionId ?? ''
        }),
        'Presence read'
    );
}

export function toExpiredAwareInsertCandidate<T>(
    expiredEntry: RuntimeStateEntry | null,
    value: T
):
    | Readonly<{ operation: 'insert'; value: T; }>
    | Readonly<{ operation: 'update'; value: T; expectedRevision: number; }> {
    return expiredEntry
        ? { operation: 'update', value, expectedRevision: expiredEntry.revision }
        : { operation: 'insert', value };
}
