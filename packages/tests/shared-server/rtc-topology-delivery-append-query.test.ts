import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-delivery-repository.ts';
import type { RtcTopologyDeliveryAppendInput } from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-contracts.ts';

const APPEND_INPUT: RtcTopologyDeliveryAppendInput = {
    publisherStreamId: '00000000-0000-4000-8000-000000000001',
    groupRef: {
        applicationId: 'delivery-app',
        workspaceId: 'delivery-workspace',
        groupId: 'delivery-group'
    },
    publicationId: 'delivery-publication',
    outboxKey: {
        topicId: 'delivery-topic',
        resourceId: 'delivery-resource',
        contextId: 'delivery-context'
    },
    retainUntilEpochMs: 86_401_000
};

const APPENDED_ROW = {
    publisher_stream_id: APPEND_INPUT.publisherStreamId,
    sequence: 1,
    application_id: APPEND_INPUT.groupRef.applicationId,
    workspace_id: APPEND_INPUT.groupRef.workspaceId,
    group_id: APPEND_INPUT.groupRef.groupId,
    publication_id: APPEND_INPUT.publicationId,
    outbox_topic_id: APPEND_INPUT.outboxKey.topicId,
    outbox_resource_id: APPEND_INPUT.outboxKey.resourceId,
    outbox_context_id: APPEND_INPUT.outboxKey.contextId,
    retain_until_epoch_ms: APPEND_INPUT.retainUntilEpochMs,
    inserted_at_epoch_ms: 1_000
} as const;

describe('RTC topology delivery append query', () => {
    it('appends through one database round trip on the uncontended success path', async () => {
        const observedQueries: string[] = [];
        const transaction = createSuccessfulAppendTransaction(observedQueries);
        const repository = new PSqlRtcTopologyDeliveryRepository(transaction);

        await expect(repository.appendOrValidate(transaction, APPEND_INPUT)).resolves.toEqual({
            status: 'appended',
            entry: {
                ...APPEND_INPUT,
                sequence: 1,
                insertedAtEpochMs: 1_000
            }
        });
        expect(observedQueries).toHaveLength(1);
    });

    it('leaves the single-use stream lookup available for PostgreSQL to inline', async () => {
        const observedQueries: string[] = [];
        const transaction = createSuccessfulAppendTransaction(observedQueries);
        const repository = new PSqlRtcTopologyDeliveryRepository(transaction);

        await repository.appendOrValidate(transaction, APPEND_INPUT);

        expect(observedQueries[0]).toContain('append_stream as ( select');
        expect(observedQueries[0]).not.toContain('append_stream as materialized');
    });

    it('uses stable statement time without a materialized clock relation', async () => {
        const observedQueries: string[] = [];
        const transaction = createSuccessfulAppendTransaction(observedQueries);
        const repository = new PSqlRtcTopologyDeliveryRepository(transaction);

        await repository.appendOrValidate(transaction, APPEND_INPUT);

        expect(observedQueries[0]).toContain('statement_timestamp()');
        expect(observedQueries[0]).not.toContain('database_clock as materialized');
    });
});

function createSuccessfulAppendTransaction(observedQueries: string[]): PSqlSql {
    const transaction = (async (strings: TemplateStringsArray) => {
        const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
        observedQueries.push(query);

        if (query.startsWith('with existing_publication as materialized')) {
            return [{ result_kind: 'appended', ...APPENDED_ROW }];
        }
        if (query.startsWith('select') && query.includes('from rtc_topology_delivery_log')) {
            return [];
        }
        if (query.startsWith('select') && query.includes('from rtc_topology_delivery_stream')) {
            return [
                {
                    stream_id: APPEND_INPUT.publisherStreamId,
                    head_sequence: 0,
                    retained_from_sequence: 1,
                    lease_expires_at_epoch_ms: 31_000,
                    lease_valid: true
                }
            ];
        }
        if (query.startsWith('update rtc_topology_delivery_stream')) {
            return [{ stream_id: APPEND_INPUT.publisherStreamId }];
        }
        if (query.startsWith('insert into rtc_topology_delivery_log')) {
            return [APPENDED_ROW];
        }
        throw new Error(`Unexpected RTC topology delivery SQL: ${query}`);
    }) as unknown as PSqlSql;
    transaction.begin = async <T>(write: (sql: PSqlSql) => Promise<T>) => {
        return await write(transaction);
    };
    return transaction;
}
