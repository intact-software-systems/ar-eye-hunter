import { validateGroupPublicationGrant } from '@shared/api/group-publication/group-publication-grants.ts';
import {
    validateGroupTopicSubscription,
    type GroupTopicSubscription
} from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { formatRallarValidation } from '@shared/api/rallar-validation.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { assertGroupRefIdentity } from '../../persistence/group-state-persistence-contracts.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '../../persistence/presence/group-presence-storage-keys.ts';
import { groupStatePublicationGrantStorageKey } from '../../persistence/publication/group-publication-grant-storage-key.ts';
import { groupStateTopicSubscriptionStorageKey } from '../../persistence/subscription/group-topic-subscription-storage-key.ts';
import { validateGroupStateRuntimeEntry } from '../../persistence/validate-group-state-runtime-entry.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession
} from '../../persistence/validate-persisted-group-presence.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import {
    readsTargetPrincipalSubscriptions,
    readsTargetPublicationGrant,
    readsTopicSubscriptionTarget
} from '../read/group-mutation-read-scope.ts';
import type { GroupMutationReadIdentities } from '../read/resolve-group-mutation-read-identities.ts';

interface AssertGroupMutationAuthorityReadsInput {
    readonly read: GroupMutationRead;
    readonly command: GroupMutationCommand;
    readonly ref: GroupRef;
    readonly identities: GroupMutationReadIdentities;
}

export function assertGroupMutationAuthorityReads({
    read,
    command,
    ref,
    identities
}: AssertGroupMutationAuthorityReadsInput): void {
    assertAdmissionReads({ read, command, ref, identities });
    assertAuthorityPresenceReads(read, ref);
    assertTargetPublicationGrantRead({ read, command, ref, identities });
    assertTopicSubscriptionTargetReads({ read, command, ref, identities });
    assertTargetPrincipalSubscriptionReads({ read, command, ref, identities });
}

/** Exactly subscribe and unsubscribe read their (session, topic) row and the session's client-state rows, the target's. */
function assertTopicSubscriptionTargetReads({
    read,
    command,
    ref,
    identities
}: AssertGroupMutationAuthorityReadsInput): void {
    const { targetTopicSubscription: subscription, targetClientSessions: sessions } = read;
    if (!readsTopicSubscriptionTarget(command)) {
        if (subscription !== null || sessions !== null) {
            throw new TypeError('Topic subscription read differs from the command read scope');
        }
        return;
    }
    if (sessions === null || identities.targetPrincipalId === null) {
        throw new TypeError('Topic subscription read differs from the command read scope');
    }
    if (subscription !== null) {
        const key = groupStateTopicSubscriptionStorageKey(ref, command.sessionId, command.input.topicId);
        assertTopicSubscriptionRow(subscription, key, identities.targetPrincipalId);
    }
    const principalId = identities.targetPrincipalId;
    const foreign = sessions.find(({ value }) =>
        value.sessionId !== command.sessionId || value.principalId !== principalId || value.status !== 'active'
    );
    if (foreign !== undefined) {
        throw new TypeError('Target client session differs from the command slot identity');
    }
}

/** Only a revoke naming subscribe and a departure read the target's subscription rows, every one the target's. */
function assertTargetPrincipalSubscriptionReads({
    read,
    command,
    ref,
    identities
}: AssertGroupMutationAuthorityReadsInput): void {
    const subscriptions = read.targetPrincipalSubscriptions;
    if ((subscriptions !== null) !== readsTargetPrincipalSubscriptions(command)) {
        throw new TypeError('Target principal subscriptions read differs from the command read scope');
    }
    for (const subscription of subscriptions ?? []) {
        const { sessionId, topicId } = subscription.value;
        const key = groupStateTopicSubscriptionStorageKey(ref, sessionId, topicId);
        assertTopicSubscriptionRow(subscription, key, identities.targetPrincipalId);
    }
}

/** The row sits at its own key, keeps the row contract, and belongs to the command's target. */
function assertTopicSubscriptionRow(
    subscription: RuntimeStateEntryValue<GroupTopicSubscription>,
    key: string,
    principalId: string | null
): void {
    validateGroupStateRuntimeEntry(subscription, 'Topic subscription', key);
    const issues = validateGroupTopicSubscription(subscription.value);
    if (issues.length > 0) {
        throw new TypeError(`Topic subscription is invalid: ${formatRallarValidation(issues)}`);
    }
    if (principalId === null || subscription.value.principalId !== principalId) {
        throw new TypeError('Topic subscription principal differs from the command target');
    }
}

/** Only a grant command or a departure reads the target's grant row, and the row belongs to that target in this group. */
function assertTargetPublicationGrantRead({
    read,
    command,
    ref,
    identities
}: AssertGroupMutationAuthorityReadsInput): void {
    const grant = read.targetPublicationGrant;
    if (grant === null) {
        return;
    }
    const principalId = identities.targetPrincipalId;
    if (!readsTargetPublicationGrant(command) || principalId === null || grant.value.principalId !== principalId) {
        throw new TypeError('Target publication grant read differs from the command read scope');
    }
    const key = groupStatePublicationGrantStorageKey(ref, principalId);
    validateGroupStateRuntimeEntry(grant, 'Target publication grant', key);
    assertGroupRefIdentity(grant.value, ref, key);
    const issues = validateGroupPublicationGrant(grant.value);
    if (issues.length > 0) {
        throw new TypeError(`Target publication grant is invalid: ${formatRallarValidation(issues)}`);
    }
}

function assertAdmissionReads({
    read,
    command,
    ref,
    identities
}: AssertGroupMutationAuthorityReadsInput): void {
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

function assertAuthorityPresenceReads(read: GroupMutationRead, ref: GroupRef): void {
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
    assertAuthorityPresenceEntries(read, ref, referencedAuthoritySessions);
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

function assertAuthorityPresenceEntries(
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
