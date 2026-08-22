import type { Sql } from 'postgres';

import type { ProductionOutboxExpectation } from './api-v1-state-write-outbox-expectations.ts';
import {
    readExpectedProductionOutboxRecord,
    type ProductionOutboxRecord,
    type ProductionOutboxRow
} from './api-v1-state-write-outbox-resource-codec.ts';
import { mapWithConcurrency } from './map-with-concurrency.ts';

export type { ProductionOutboxRecord } from './api-v1-state-write-outbox-resource-codec.ts';
export {
    readAllCommandIds,
    readCanonicalEffectCommandId,
    readResourceEffectKind
} from './api-v1-state-write-outbox-resource-codec.ts';

export interface ProductionOutboxRepository {
    find(
        expectation: ProductionOutboxExpectation
    ): Promise<Readonly<{ record: ProductionOutboxRecord; }> | undefined>;
}

export async function readReferencedProductionOutboxRecords(
    repository: ProductionOutboxRepository,
    expectations: readonly ProductionOutboxExpectation[]
): Promise<readonly ProductionOutboxRecord[]> {
    const uniqueExpectations = new Map<string, ProductionOutboxExpectation>();
    for (const expectation of expectations) {
        const key = [
            expectation.typeId,
            expectation.topicId,
            expectation.contextId,
            expectation.resourceId
        ].join('\0');
        if (uniqueExpectations.has(key)) {
            throw new Error(`Receipt repeats an exact ResourceInbox effect: ${expectation.effectId}`);
        }
        uniqueExpectations.set(key, expectation);
    }
    const records = await mapWithConcurrency(
        [...uniqueExpectations.values()],
        25,
        async (expectation) => await repository.find(expectation)
    );
    return records.flatMap((entry) => (entry ? [entry.record] : []));
}

export function createProductionOutboxRepository(sql: Sql): ProductionOutboxRepository {
    return {
        find: async (expectation) => {
            const rows = await sql<readonly ProductionOutboxRow[]>`
        select ri_resource_id, ri_topic_id, fk_ext_bank_id, ri_type_id, ri_resource
        from resource_inbox
        where ri_resource_id = ${expectation.resourceId}
          and ri_topic_id = ${expectation.topicId}
          and fk_ext_bank_id = ${expectation.contextId}
          and ri_type_id = ${expectation.typeId}
      `;
            const matching = rows.flatMap((row) => {
                const record = readExpectedProductionOutboxRecord(row, expectation);
                return record === undefined ? [] : [{ record }];
            });
            if (matching.length === 0) {
                return undefined;
            }
            if (matching.length !== 1) {
                throw new Error(
                    `Receipt resolves to ambiguous exact ResourceInbox effects: ${expectation.effectId}`
                );
            }
            return matching[0];
        }
    };
}
