import {
    validateGroupPublicationGrant,
    type GroupPublicationGrant
} from '@shared/api/group-publication/group-publication-grants.ts';
import { formatRallarValidation } from '@shared/api/rallar-validation.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type {
    RuntimeStateGuardedBatchDelete,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchUpdate
} from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { GroupPublicationGrantEffect } from '../../mutation/group-mutation-contracts.ts';
import { PUBLICATION_GRANTS_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import { serializeGroupStateValue } from '../serialize-group-state-value.ts';
import { groupStatePublicationGrantStorageKey } from './group-publication-grant-storage-key.ts';

export function groupStateInsertPublicationGrantDescriptor(
    grant: GroupPublicationGrant
): RuntimeStateGuardedBatchInsert {
    const issues = validateGroupPublicationGrant(grant);
    if (issues.length > 0) {
        throw new TypeError(`Publication grant row is invalid: ${formatRallarValidation(issues)}`);
    }
    return {
        operation: 'insert',
        namespace: PUBLICATION_GRANTS_NAMESPACE,
        key: groupStatePublicationGrantStorageKey(grant, grant.principalId),
        value: serializeGroupStateValue(grant),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export function groupStateUpdatePublicationGrantDescriptor(
    grant: GroupPublicationGrant,
    expectedRevision: number
): RuntimeStateGuardedBatchUpdate {
    return { ...groupStateInsertPublicationGrantDescriptor(grant), operation: 'update', expectedRevision };
}

export function groupStateDeletePublicationGrantDescriptor(
    grant: GroupPublicationGrant,
    expectedRevision: number
): RuntimeStateGuardedBatchDelete {
    return {
        operation: 'delete',
        namespace: PUBLICATION_GRANTS_NAMESPACE,
        key: groupStatePublicationGrantStorageKey(grant, grant.principalId),
        expectedRevision
    };
}

export function toPublicationGrantBatchEffect(effect: GroupPublicationGrantEffect): RuntimeStateGuardedBatchEffect {
    const effectId = `publication-grant:${effect.value.principalId}`;
    switch (effect.operation) {
        case 'insert':
            return { effectId, ...groupStateInsertPublicationGrantDescriptor(effect.value) };
        case 'update':
            return { effectId, ...groupStateUpdatePublicationGrantDescriptor(effect.value, effect.expectedRevision) };
        case 'delete':
            return { effectId, ...groupStateDeletePublicationGrantDescriptor(effect.value, effect.expectedRevision) };
    }
}
