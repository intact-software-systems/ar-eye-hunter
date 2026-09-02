import type { Group } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type {
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchUpdate
} from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { GROUPS_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import { serializeGroupStateValue } from '../serialize-group-state-value.ts';
import { groupStateGroupStorageKey } from './group-aggregate-storage-keys.ts';

export function groupStateInsertGroupDescriptor(group: Group): RuntimeStateGuardedBatchInsert {
    return {
        operation: 'insert',
        namespace: GROUPS_NAMESPACE,
        key: groupStateGroupStorageKey(group),
        value: serializeGroupStateValue(group),
        expireAtTimestamp: group.purgeAfterEpochMs ?? NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export function groupStateUpdateGroupDescriptor(
    group: Group,
    expectedRevision: number
): RuntimeStateGuardedBatchUpdate {
    return {
        operation: 'update',
        namespace: GROUPS_NAMESPACE,
        key: groupStateGroupStorageKey(group),
        expectedRevision,
        value: serializeGroupStateValue(group),
        expireAtTimestamp: group.purgeAfterEpochMs ?? NEVER_EXPIRE_AT_TIMESTAMP
    };
}
