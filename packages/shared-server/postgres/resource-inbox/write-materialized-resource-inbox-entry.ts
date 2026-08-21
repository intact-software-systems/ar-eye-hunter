import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { ResourceInboxRepository } from './ResourceInboxRepository.ts';

export async function writeMaterializedResourceInboxEntry(
    repository: ResourceInboxRepository,
    placeholder: ResourceEntry,
    materialize: () => Promise<ResourceEntry>,
    materializedIdentityError: (key: Key) => Error
): Promise<ResourceEntry> {
    return await repository.begin(async (transaction) => {
        const reserved = await transaction.tryWriteIfAbsentOrReplaceExpired(placeholder);
        if (!reserved) {
            const existing = await transaction.findAnyByKey(placeholder.key);
            if (existing) {
                return existing;
            }
            throw new Error('Materialized write lost its conflicting resource inbox row');
        }

        const materialized = await materialize();
        if (!hasReservedIdentity(reserved, materialized)) {
            throw materializedIdentityError(reserved.key);
        }
        return await transaction.replace({
            ...reserved,
            resource: materialized.resource
        });
    });
}

function hasReservedIdentity(
    reserved: ResourceEntry,
    materialized: ResourceEntry
): boolean {
    return materialized.key.topicId === reserved.key.topicId &&
        materialized.key.resourceId === reserved.key.resourceId &&
        materialized.key.contextId === reserved.key.contextId &&
        materialized.typeId === reserved.typeId;
}
