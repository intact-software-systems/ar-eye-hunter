import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import type { PostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

/**
 * Every row an outbound store wrote: the admission rows under the namespace, the work rows of the
 * namespace (one topic and resource id, the effect id in the context) and the canonical and identity
 * rows of its scope (one resource id per scope, the message in the context).
 */
export async function deleteALOutboundNamespaceRows(sql: PostgresSql, namespace: string, canonicalKey: Key): Promise<void> {
    const work = toALOutboundWorkKey(namespace, 'any-effect-id');
    await sql`
        delete from resource_inbox
        where (ri_topic_id = ${work.topicId} and ri_resource_id = ${work.resourceId})
            or ri_resource_id = ${canonicalKey.resourceId}
    `;
    await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
}
