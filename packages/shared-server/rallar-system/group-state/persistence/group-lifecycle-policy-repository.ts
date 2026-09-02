import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateJsonStore } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { groupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';
import {
    computeCanonicalGroupLifecyclePolicy,
    decodeStoredGroupLifecyclePolicy
} from './decode-stored-group-lifecycle-policy.ts';

export const GROUP_LIFECYCLE_POLICIES_NAMESPACE = 'group-state:lifecycle-policies';

export interface GroupLifecyclePolicyWrite {
    readonly key: string;
    readonly value: string;
    readonly expireAtIsoTimestamp: string;
}

export function computeGroupLifecyclePolicyWrite(
    ref: GroupRef,
    policy: GroupLifecyclePolicy
): GroupLifecyclePolicyWrite {
    return {
        key: groupStateGroupStorageKey(ref),
        value: JSON.stringify({ groupRef: ref, policy: computeCanonicalGroupLifecyclePolicy(policy) }),
        expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
    };
}

export async function writeGroupLifecyclePolicy(
    transaction: PSqlSql,
    computed: GroupLifecyclePolicyWrite
): Promise<void> {
    await transaction`
        insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
        values (${GROUP_LIFECYCLE_POLICIES_NAMESPACE}, ${computed.key}, ${computed.value}, ${computed.expireAtIsoTimestamp}, now(), 0)
        on conflict (store_namespace, store_key)
            do update set store_value = excluded.store_value,
                          expire_at_ts = excluded.expire_at_ts,
                          updated_ts = now(),
                          revision = runtime_state_store.revision + 1
    `;
}

/**
 * `absent` and `corrupt` are separate outcomes on purpose. A neighbouring store
 * decodes a bad row as absent because failing open there only costs a rebuild;
 * here it would silently reopen a group whose stored policy closed it. Storage
 * therefore reports what it found and the enforcement point decides, rather
 * than one failure posture being baked in before there is an enforcer.
 */
export type GroupLifecyclePolicyRead =
    | Readonly<{ status: 'absent'; }>
    | Readonly<{ status: 'present'; policy: GroupLifecyclePolicy; }>
    | Readonly<{ status: 'corrupt'; reason: string; }>;

export class GroupLifecyclePolicyRepository extends RuntimeStateJsonStore {
    readonly runtimeRepository: RuntimeStateRepositoryLike;

    constructor(runtimeRepository: RuntimeStateRepositoryLike) {
        super(runtimeRepository);
        this.runtimeRepository = runtimeRepository;
    }

    async readPolicy(ref: GroupRef): Promise<GroupLifecyclePolicyRead> {
        const stored = await this.getJsonValue(
            GROUP_LIFECYCLE_POLICIES_NAMESPACE,
            groupStateGroupStorageKey(ref)
        );
        if (stored === undefined) {
            return { status: 'absent' };
        }
        try {
            const decoded = decodeStoredGroupLifecyclePolicy(stored, ref);
            return { status: 'present', policy: decoded.policy };
        }
        catch (error) {
            return {
                status: 'corrupt',
                reason: error instanceof Error ? error.message : 'Stored group lifecycle policy is invalid'
            };
        }
    }
}
