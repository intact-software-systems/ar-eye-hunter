import type { GroupMember } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { RuntimeStateGuardedBatchPut } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { MEMBERS_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import { serializeGroupStateValue } from '../serialize-group-state-value.ts';
import { groupStateMemberStorageKey } from './group-membership-storage-key.ts';

export function groupStateMemberPutDescriptor(member: GroupMember): RuntimeStateGuardedBatchPut {
    return {
        operation: 'put',
        namespace: MEMBERS_NAMESPACE,
        key: groupStateMemberStorageKey(member),
        value: serializeGroupStateValue(member),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}
