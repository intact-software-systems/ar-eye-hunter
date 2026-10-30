import { describe, expect, it } from 'vitest';

import {
    decodeGroupStateChildStorageKey,
    groupStateGroupStorageKey
} from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts';
import { SUBSCRIPTIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { canonicalStoredTopicSubscription } from '@shared-server/rallar-system/group-state/persistence/subscription/group-topic-subscription-codec.ts';
import {
    decodeGroupStateTopicSubscriptionStorageKey,
    groupStateTopicSubscriptionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/subscription/group-topic-subscription-storage-key.ts';
import {
    groupStateInsertTopicSubscriptionDescriptor,
    toTopicSubscriptionDeleteBatchEffect
} from '@shared-server/rallar-system/group-state/persistence/subscription/group-topic-subscription-write-descriptors.ts';
import { encodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';

import { groupRef, storedEntry } from '../mutation/group-mutation-test-runtime.ts';

const REF = groupRef('pure-room');

function subscriptionFor(sessionId: string, topicId: string): GroupTopicSubscription {
    return {
        sessionId,
        principalId: 'bob',
        topicId,
        connectionGenerationId: 'bob-ws-generation-1',
        leaseExpiresAtEpochMs: 121_000,
        admittedAtGroupRevision: 3
    };
}

describe('group topic subscription storage', () => {
    it('the key is <groupKey>:session=<sid>:topic=<encoded topicId> and decodes at arity 5', () => {
        const key = groupStateTopicSubscriptionStorageKey(REF, 'bob-session', 'room.a:b');

        expect(SUBSCRIPTIONS_NAMESPACE).toBe('group-state:subscriptions');
        expect(key).toBe(`${groupStateGroupStorageKey(REF)}:session=bob-session:topic=room.a%3Ab`);
        expect(decodeGroupStateTopicSubscriptionStorageKey(key)).toEqual({
            ...REF,
            sessionId: 'bob-session',
            topicId: 'room.a:b'
        });
    });

    it('decodeGroupStateChildStorageKey refuses the five-part key', () => {
        const key = groupStateTopicSubscriptionStorageKey(REF, 'bob-session', 'room.feed');

        expect(() => decodeGroupStateChildStorageKey(key, 'session', 'sessionId')).toThrow(TypeError);
        expect(() => decodeGroupStateTopicSubscriptionStorageKey(`${groupStateGroupStorageKey(REF)}:session=bob-session`))
            .toThrow(TypeError);
    });

    it('a row whose session or topic differs from its key is corruption', () => {
        const key = groupStateTopicSubscriptionStorageKey(REF, 'bob-session', 'room.feed');

        expect(() =>
            canonicalStoredTopicSubscription(
                storedEntry(key, encodeJsonWireValue(subscriptionFor('other-session', 'room.feed'))),
                REF
            )
        ).toThrow(GroupStateRepositoryInvariantCorruptionError);
        expect(() =>
            canonicalStoredTopicSubscription(
                storedEntry(key, encodeJsonWireValue(subscriptionFor('bob-session', 'room.other'))),
                REF
            )
        ).toThrow(GroupStateRepositoryInvariantCorruptionError);
        expect(
            canonicalStoredTopicSubscription(
                storedEntry(key, encodeJsonWireValue(subscriptionFor('bob-session', 'room.feed'))),
                REF
            ).value
        ).toEqual(subscriptionFor('bob-session', 'room.feed'));
    });

    it('the insert descriptor expires at the lease', () => {
        const subscription = subscriptionFor('bob-session', 'room.feed');

        expect(groupStateInsertTopicSubscriptionDescriptor(REF, subscription)).toEqual({
            operation: 'insert',
            namespace: SUBSCRIPTIONS_NAMESPACE,
            key: groupStateTopicSubscriptionStorageKey(REF, 'bob-session', 'room.feed'),
            value: JSON.stringify(subscription),
            expireAtTimestamp: 121_000
        });
        expect(toTopicSubscriptionDeleteBatchEffect({ ref: REF, value: subscription, expectedRevision: 2 })).toEqual({
            effectId: 'topic-subscription:bob-session:room.feed',
            operation: 'delete',
            namespace: SUBSCRIPTIONS_NAMESPACE,
            key: groupStateTopicSubscriptionStorageKey(REF, 'bob-session', 'room.feed'),
            expectedRevision: 2
        });
    });
});
