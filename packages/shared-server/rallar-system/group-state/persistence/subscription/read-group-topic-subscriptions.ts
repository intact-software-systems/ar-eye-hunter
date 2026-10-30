import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RuntimeStateReadBatchSelector } from '../../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../../runtime-state/runtime-state-repository.ts';
import { clientStatePrincipalStorageKey } from '../../../client-state/persistence/client-state-principal-storage-key.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '../../../client-state/persistence/client-state-runtime-namespaces.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import type { GroupTopicSubscriptionAuthority } from '../../group-state-service-contracts.ts';
import { groupStateChildStorageKey, groupStateGroupStorageKey } from '../aggregate/group-aggregate-storage-keys.ts';
import { toGroupStateReadBatchLiveSelections } from '../group-state-persistence-contracts.ts';
import { SUBSCRIPTIONS_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import {
    canonicalStoredActiveClientSessions,
    canonicalStoredTopicSubscription,
    canonicalStoredTopicSubscriptions
} from './group-topic-subscription-codec.ts';

export interface ReadGroupSessionTopicSubscriptionsInput {
    readonly ref: GroupRef;
    readonly sessionId: string;
    readonly observedAtEpochMs: number;
}

export interface ReadGroupTopicSubscriptionAuthorityInput {
    readonly snapshot: GroupSnapshot;
    readonly topicId: string;
    readonly observedAtEpochMs: number;
}

/** One session's live subscription rows in the group, in topicId order; a lapsed row is absent. */
export async function readGroupSessionTopicSubscriptions(
    repository: RuntimeStateRepositoryLike,
    input: ReadGroupSessionTopicSubscriptionsInput
): Promise<readonly GroupTopicSubscription[]> {
    const selectors: readonly RuntimeStateReadBatchSelector[] = [{
        selectorId: 'session-subscriptions',
        kind: 'prefix',
        namespace: SUBSCRIPTIONS_NAMESPACE,
        keyPrefix: `${groupStateChildStorageKey(input.ref, 'session', input.sessionId)}:`
    }];
    const [selection] = toGroupStateReadBatchLiveSelections(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        input.observedAtEpochMs
    );
    return selection.entries
        .map((entry) => canonicalStoredTopicSubscription(entry, input.ref).value)
        .sort((left, right) => (left.topicId < right.topicId ? -1 : left.topicId > right.topicId ? 1 : 0));
}

/**
 * The topic's live subscription rows and the live client-state generations of the snapshot's sessions, in one
 * statement issued after the snapshot probe: a revoke, departure or reconnect committed between the two removes
 * the row or changes the generation this statement reads, so the pair is never looser than the probe. A row failing
 * its contract is corruption.
 */
export async function readGroupTopicSubscriptionAuthority(
    repository: RuntimeStateRepositoryLike,
    input: ReadGroupTopicSubscriptionAuthorityInput
): Promise<GroupTopicSubscriptionAuthority> {
    const ref = toSnapshotGroupRef(input.snapshot);
    const sessions = input.snapshot.activeSessions;
    const selectors: readonly RuntimeStateReadBatchSelector[] = [
        {
            selectorId: 'topic-subscriptions',
            kind: 'prefix-containing',
            namespace: SUBSCRIPTIONS_NAMESPACE,
            keyPrefix: `${groupStateGroupStorageKey(ref)}:`,
            storedValueContains: { topicId: input.topicId }
        },
        ...sessions.map((session, index): RuntimeStateReadBatchSelector => ({
            selectorId: `client-session:${index}`,
            kind: 'prefix-containing',
            namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
            keyPrefix: `${clientStatePrincipalStorageKey({ ...ref, principalId: session.principalId })}:`,
            storedValueContains: { sessionId: session.sessionId, status: 'active' }
        }))
    ];
    const [subscriptions, ...clientSessions] = toGroupStateReadBatchLiveSelections(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        input.observedAtEpochMs
    );
    return {
        subscriptions: canonicalStoredTopicSubscriptions(subscriptions.entries, ref).map(({ value }) => value),
        liveSessionGenerations: Object.fromEntries(sessions.flatMap((session, index) => {
            const generations = toLiveClientGenerations(clientSessions[index].entries, {
                ...ref,
                session,
                observedAtEpochMs: input.observedAtEpochMs
            });
            return generations.length === 0 ? [] : [[session.sessionId, generations]];
        }))
    };
}

function toLiveClientGenerations(
    stored: readonly RuntimeStateEntryValue<JsonWireValue>[],
    expected: GroupRef & Readonly<{ session: GroupPresenceSession; observedAtEpochMs: number; }>
): readonly string[] {
    const { session, observedAtEpochMs, ...ref } = expected;
    return canonicalStoredActiveClientSessions(stored, {
        ...ref,
        principalId: session.principalId,
        sessionId: session.sessionId
    })
        .filter(({ value }) => value.status === 'active' && value.expiresAtEpochMs > observedAtEpochMs)
        .map(({ value }) => value.generationId);
}

function toSnapshotGroupRef(snapshot: GroupSnapshot): GroupRef {
    const { applicationId, workspaceId, groupId } = snapshot.group;
    return { applicationId, workspaceId, groupId };
}
