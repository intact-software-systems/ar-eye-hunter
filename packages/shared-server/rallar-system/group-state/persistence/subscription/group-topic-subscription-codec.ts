import type { ClientSession, ClientSessionRef } from '@shared/api/client-types.ts';
import {
    decodeGroupTopicSubscription,
    type GroupTopicSubscription
} from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { formatRallarValidation } from '@shared/api/rallar-validation.ts';

import { compareRuntimeStateKeys } from '../../../../runtime-state/read-batch/compare-runtime-state-keys.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { decodeClientSessionStorageKey } from '../../../client-state/persistence/client-state-session-storage-key.ts';
import { validatePersistedClientSession } from '../../../client-state/persistence/validate-persisted-client-state.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    assertTrustedGroupRef,
    decodeStoredGroupStateKey,
    GroupStateRepositoryInvariantCorruptionError,
    throwGroupStateIdentityCorruption
} from '../group-state-persistence-contracts.ts';
import { decodeGroupStateTopicSubscriptionStorageKey } from './group-topic-subscription-storage-key.ts';

/** A stored subscription row whose key, group, session or topic disagree, or that fails the row contract, is corruption. */
export function canonicalStoredTopicSubscription(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected: GroupRef
): RuntimeStateEntryValue<GroupTopicSubscription> {
    const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateTopicSubscriptionStorageKey);
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = decodeGroupTopicSubscription(stored.value).fold(
        (issues) => {
            throw new GroupStateRepositoryInvariantCorruptionError(
                stored.entry.key,
                `Stored topic subscription is invalid: ${formatRallarValidation(issues)}`
            );
        },
        (subscription) => subscription
    );
    if (value.sessionId !== decoded.sessionId || value.topicId !== decoded.topicId) {
        throwGroupStateIdentityCorruption(stored.entry.key, 'topic subscription session or topic');
    }
    return { entry: stored.entry, value };
}

export function canonicalStoredTopicSubscriptions(
    stored: readonly RuntimeStateEntryValue<JsonWireValue>[],
    ref: GroupRef
): readonly RuntimeStateEntryValue<GroupTopicSubscription>[] {
    return stored
        .map((entry) => canonicalStoredTopicSubscription(entry, ref))
        .sort((left, right) => compareRuntimeStateKeys(left.entry.key, right.entry.key));
}

/** Every row the principal's containing read selected is the principal's own, in canonical storage-key order. */
export function canonicalStoredPrincipalTopicSubscriptions(
    stored: readonly RuntimeStateEntryValue<JsonWireValue>[],
    expected: GroupRef & Readonly<{ principalId: string; }>
): readonly RuntimeStateEntryValue<GroupTopicSubscription>[] {
    const subscriptions = canonicalStoredTopicSubscriptions(stored, expected);
    const foreign = subscriptions.find(({ value }) => value.principalId !== expected.principalId);
    if (foreign !== undefined) {
        throwGroupStateIdentityCorruption(foreign.entry.key, 'topic subscription principal');
    }
    return subscriptions;
}

/**
 * The session's active client-state rows, in canonical storage-key order, failing closed: a row outside the requested
 * session or one that fails the client-state contract is corruption rather than an absent session.
 */
export function canonicalStoredActiveClientSessions(
    stored: readonly RuntimeStateEntryValue<JsonWireValue>[],
    expected: GroupRef & Readonly<{ principalId: string; sessionId: string; }>
): readonly RuntimeStateEntryValue<ClientSession>[] {
    return stored
        .map((session) => canonicalStoredActiveClientSession(session, expected))
        .sort((left, right) => compareRuntimeStateKeys(left.entry.key, right.entry.key));
}

function canonicalStoredActiveClientSession(
    session: RuntimeStateEntryValue<JsonWireValue>,
    expected: GroupRef & Readonly<{ principalId: string; sessionId: string; }>
): RuntimeStateEntryValue<ClientSession> {
    const key = decodeStoredGroupStateKey(session.entry.key, decodeClientSessionStorageKey);
    if (!isExpectedClientSessionKey(key, expected)) {
        throwGroupStateIdentityCorruption(session.entry.key, 'client-state session');
    }
    try {
        validatePersistedClientSession(session.value, key);
    }
    catch (error) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            session.entry.key,
            error instanceof Error ? error.message : 'Stored client-state session is invalid'
        );
    }
    return { entry: session.entry, value: session.value };
}

function isExpectedClientSessionKey(
    key: ClientSessionRef,
    expected: GroupRef & Readonly<{ principalId: string; sessionId: string; }>
): boolean {
    return key.applicationId === expected.applicationId && key.workspaceId === expected.workspaceId &&
        key.principalId === expected.principalId && key.sessionId === expected.sessionId;
}
