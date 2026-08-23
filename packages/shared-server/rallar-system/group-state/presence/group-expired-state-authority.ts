import type { GroupRef } from '@shared/api/group-types.ts';
import { validateRuntimeStateExpiredAuthority } from '../../../runtime-state/runtime-state-expired-entry.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import {
    groupStateGroupStorageKey,
    groupStatePresenceSessionStorageKey
} from '../persistence/group-state-storage-keys.ts';

export function validateGroupExpiredStateAuthority(
    input: Readonly<{
        ref: GroupRef;
        targetSessionId: string | null;
        group: object | null;
        expiredGroupEntry: RuntimeStateEntry | null;
        targetPresence: object | null;
        expiredTargetPresenceEntry: RuntimeStateEntry | null;
    }>
): void {
    validateRuntimeStateExpiredAuthority({
        live: input.group,
        expiredEntry: input.expiredGroupEntry,
        expectedKey: groupStateGroupStorageKey(input.ref),
        label: 'Group read'
    });
    if (input.targetSessionId === null) {
        if (input.expiredTargetPresenceEntry) {
            throw new TypeError('Presence read has expired authority without a target session');
        }
        return;
    }
    validateRuntimeStateExpiredAuthority({
        live: input.targetPresence,
        expiredEntry: input.expiredTargetPresenceEntry,
        expectedKey: groupStatePresenceSessionStorageKey({
            ...input.ref,
            sessionId: input.targetSessionId
        }),
        label: 'Presence read'
    });
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
