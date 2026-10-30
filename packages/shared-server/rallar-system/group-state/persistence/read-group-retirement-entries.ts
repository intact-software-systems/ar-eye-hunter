import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { groupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';
import { decodeStoredGroupLifecyclePolicy } from './decode-stored-group-lifecycle-policy.ts';
import {
    decodeGroupConnectTriggerLatchRow,
    GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE
} from './group-connect-trigger-latch-repository.ts';
import { GROUP_LIFECYCLE_POLICIES_NAMESPACE } from './group-lifecycle-policy-repository.ts';
import { GroupStateRepositoryInvariantCorruptionError } from './group-state-persistence-contracts.ts';
import {
    MEMBERS_NAMESPACE,
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    PUBLICATION_GRANTS_NAMESPACE,
    SESSIONS_NAMESPACE,
    SUBSCRIPTIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';
import { canonicalStoredMember } from './membership/group-membership-repository.ts';
import {
    canonicalStoredAdmission,
    canonicalStoredSession,
    canonicalStoredSummary
} from './presence/group-presence-repository.ts';
import { canonicalStoredPublicationGrant } from './publication/group-publication-grant-codec.ts';
import { canonicalStoredTopicSubscription } from './subscription/group-topic-subscription-codec.ts';

export interface GroupRetirementEntry {
    readonly namespace: string;
    readonly entry: RuntimeStateEntry;
}

/** Raw rows include physically expired children: retirement removes every owned row, not just live projections. */
export async function readGroupRetirementEntries(
    repository: RuntimeStateRepositoryLike,
    ref: GroupRef
): Promise<readonly GroupRetirementEntry[]> {
    const key = groupStateGroupStorageKey(ref);
    const selections = await repository.readRuntimeStateBatch([
        ...[
            MEMBERS_NAMESPACE,
            PRESENCE_ADMISSIONS_NAMESPACE,
            SESSIONS_NAMESPACE,
            PUBLICATION_GRANTS_NAMESPACE,
            SUBSCRIPTIONS_NAMESPACE,
            GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE
        ].map((namespace) => ({
            selectorId: namespace,
            kind: 'prefix' as const,
            namespace,
            keyPrefix: `${key}:`
        })),
        ...[PRESENCE_SUMMARIES_NAMESPACE, GROUP_LIFECYCLE_POLICIES_NAMESPACE].map((namespace) => ({
            selectorId: namespace,
            kind: 'key' as const,
            namespace,
            key
        }))
    ]);
    return selections.flatMap((selection) =>
        selection.entries.map((entry) => {
            validateRetirementEntry(selection.selectorId, entry, ref);
            return { namespace: selection.selectorId, entry };
        })
    );
}

function validateRetirementEntry(namespace: string, entry: RuntimeStateEntry, ref: GroupRef): void {
    try {
        const stored = { entry, value: decodeJsonWireValue(JSON.parse(entry.value), 'Retirement child') };
        switch (namespace) {
            case MEMBERS_NAMESPACE:
                canonicalStoredMember(stored, ref);
                return;
            case PRESENCE_ADMISSIONS_NAMESPACE:
                canonicalStoredAdmission(stored, ref);
                return;
            case SESSIONS_NAMESPACE:
                canonicalStoredSession(stored, ref);
                return;
            case PRESENCE_SUMMARIES_NAMESPACE:
                canonicalStoredSummary(stored, ref);
                return;
            case PUBLICATION_GRANTS_NAMESPACE:
                canonicalStoredPublicationGrant(stored, ref);
                return;
            case SUBSCRIPTIONS_NAMESPACE:
                canonicalStoredTopicSubscription(stored, ref);
                return;
            case GROUP_LIFECYCLE_POLICIES_NAMESPACE:
                if (entry.key !== groupStateGroupStorageKey(ref)) {
                    throw new TypeError('Lifecycle policy key differs from room');
                }
                decodeStoredGroupLifecyclePolicy(stored.value, ref);
                return;
            case GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE: {
                const prefix = `${groupStateGroupStorageKey(ref)}:epoch=`;
                if (!entry.key.startsWith(prefix)) {
                    throw new TypeError('Latch key differs from room');
                }
                const [epoch, generation] = entry.key.slice(prefix.length).split(':generation=');
                decodeGroupConnectTriggerLatchRow(entry, {
                    groupRef: ref,
                    formationEpoch: Number(epoch),
                    triggerGeneration: decodeURIComponent(generation)
                });
                return;
            }
            default:
                throw new TypeError('Unknown room-owned namespace');
        }
    }
    catch (error) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            entry.key,
            error instanceof Error ? error.message : 'Invalid retirement child'
        );
    }
}
