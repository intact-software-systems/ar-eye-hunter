import type { GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '../../persistence/presence/group-presence-storage-keys.ts';
import { validateGroupStateRuntimeEntry } from '../../persistence/validate-group-state-runtime-entry.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession
} from '../../persistence/validate-persisted-group-presence.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import type { GroupMutationReadIdentities } from '../read/resolve-group-mutation-read-identities.ts';

interface ValidateGroupMutationAuthorityReadsInput {
    readonly read: GroupMutationRead;
    readonly command: GroupMutationCommand;
    readonly ref: GroupRef;
    readonly identities: GroupMutationReadIdentities;
}

export function validateGroupMutationAuthorityReads({
    read,
    command,
    ref,
    identities
}: ValidateGroupMutationAuthorityReadsInput): void {
    validateAdmissionReads({ read, command, ref, identities });
    validateAuthorityPresenceReads(read, ref);
}

function validateAdmissionReads({
    read,
    command,
    ref,
    identities
}: ValidateGroupMutationAuthorityReadsInput): void {
    const authorityAdmissionPrincipalId = command.operation === 'appointDirector'
        ? identities.ownerPrincipalId
        : null;
    const directorAdmissionPrincipalId = command.operation === 'appointDirector'
        ? identities.directorPrincipalId
        : null;
    for (
        const [label, admission, expectedPrincipalId] of [
            ['Target admission', read.targetAdmission, identities.targetPrincipalId],
            ['Authority admission', read.authorityAdmission, authorityAdmissionPrincipalId],
            ['Director admission', read.directorAdmission, directorAdmissionPrincipalId]
        ] as const
    ) {
        if (!admission) {
            continue;
        }
        if (expectedPrincipalId === null || admission.value.principalId !== expectedPrincipalId) {
            throw new TypeError(`${label} principal differs from command slot identity`);
        }
        validateGroupStateRuntimeEntry(
            admission,
            label,
            groupStatePresenceAdmissionStorageKey({ ...ref, principalId: expectedPrincipalId })
        );
        validatePresenceAdmission(admission.value, ref);
    }
}

function validateAuthorityPresenceReads(read: GroupMutationRead, ref: GroupRef): void {
    if (
        !Array.isArray(read.authorityPresenceSessions) ||
        !Array.isArray(read.authorityPresenceSessionEntries)
    ) {
        throw new TypeError('Authority presence sessions must be arrays');
    }
    if (read.authorityPresenceSessions.length !== read.authorityPresenceSessionEntries.length) {
        throw new TypeError('Authority presence sessions differ from stored entries');
    }
    const referencedAuthoritySessions = collectReferencedAuthoritySessions(read);
    validateAuthorityPresenceEntries(read, ref, referencedAuthoritySessions);
}

interface ReferencedAuthoritySession {
    readonly principalId: string;
    readonly generationId: string;
    readonly generationVersion: number;
    readonly connectedAtEpochMs: number;
}

function collectReferencedAuthoritySessions(
    read: GroupMutationRead
): ReadonlyMap<string, ReferencedAuthoritySession> {
    const referencedAuthoritySessions = new Map<string, ReferencedAuthoritySession>();
    for (const admission of [read.authorityAdmission, read.directorAdmission]) {
        if (!admission) {
            continue;
        }
        for (const session of admission.value.admittedSessions) {
            const existing = referencedAuthoritySessions.get(session.sessionId);
            if (existing && existing.principalId !== admission.value.principalId) {
                throw new TypeError(
                    'Stored authority presence session is referenced by multiple principals'
                );
            }
            if (
                existing &&
                (existing.generationId !== session.generationId ||
                    existing.generationVersion !== session.generationVersion ||
                    existing.connectedAtEpochMs !== session.connectedAtEpochMs)
            ) {
                throw new TypeError(
                    'Stored authority presence session has conflicting admission generations'
                );
            }
            referencedAuthoritySessions.set(session.sessionId, {
                principalId: admission.value.principalId,
                generationId: session.generationId,
                generationVersion: session.generationVersion,
                connectedAtEpochMs: session.connectedAtEpochMs
            });
        }
    }
    return referencedAuthoritySessions;
}

function validateAuthorityPresenceEntries(
    read: GroupMutationRead,
    ref: GroupRef,
    referencedAuthoritySessions: ReadonlyMap<string, ReferencedAuthoritySession>
): void {
    read.authorityPresenceSessionEntries.forEach((entry, index) => {
        const expected = referencedAuthoritySessions.get(entry.value.sessionId);
        if (
            !expected ||
            expected.principalId !== entry.value.principalId ||
            expected.generationId !== entry.value.generationId ||
            expected.generationVersion !== entry.value.generationVersion ||
            expected.connectedAtEpochMs !== entry.value.connectedAtEpochMs
        ) {
            throw new TypeError(
                'Stored authority presence is not referenced by its corresponding admission'
            );
        }
        validateGroupStateRuntimeEntry(
            entry,
            'Stored authority presence',
            groupStatePresenceSessionStorageKey({ ...ref, sessionId: entry.value.sessionId })
        );
        validatePresenceSession(entry.value, ref, 'Stored authority presence');
        if (!jsonEquals(entry.value, read.authorityPresenceSessions[index])) {
            throw new TypeError('Authority presence session differs from stored entry');
        }
    });
}
