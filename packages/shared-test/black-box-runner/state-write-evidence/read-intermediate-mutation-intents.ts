import type { ApiV1StateWriteEvidenceQuery } from './api-v1-state-write-evidence-contracts.ts';

export async function readIntermediateMutationIntents(
    sql: ApiV1StateWriteEvidenceQuery,
    match: string
): Promise<readonly Record<string, unknown>[]> {
    return await sql<Record<string, unknown>[]>`
        select ri_resource_id as "resourceId", ri_topic_id as "topicId",
               ri_type_id as "typeId", ri_status as status
        from resource_inbox
        where position(${match} in ri_resource) > 0
          and (ri_type_id ilike '%INTENT%' or ri_topic_id ilike '%intent%'
               or ri_resource ilike '%mutationIntent%')
        order by ri_row_id
    `;
}
