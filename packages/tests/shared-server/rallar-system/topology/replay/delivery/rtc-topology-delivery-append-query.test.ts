import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RtcTopologyDeliveryAppend } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-contracts.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts';

const APPEND_INPUT: RtcTopologyDeliveryAppend = {
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
    retainUntilEpochMs: 86_401_000,
    retainUntilIsoTimestamp: '1970-01-02T00:00:01.000Z'
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
        const observedParameters: PSqlParameter[] = [];
        const transaction = createSuccessfulAppendTransaction(observedQueries, observedParameters);
        const repository = new PSqlRtcTopologyDeliveryRepository(transaction);

        await expect(repository.appendOrValidate(transaction, APPEND_INPUT)).resolves.toEqual({
            status: 'appended',
            entry: {
                publisherStreamId: APPEND_INPUT.publisherStreamId,
                groupRef: APPEND_INPUT.groupRef,
                publicationId: APPEND_INPUT.publicationId,
                outboxKey: APPEND_INPUT.outboxKey,
                retainUntilEpochMs: APPEND_INPUT.retainUntilEpochMs,
                sequence: 1,
                insertedAtEpochMs: 1_000
            }
        });
        expect(observedQueries).toHaveLength(1);
        expect(observedParameters.some((parameter) => parameter instanceof Date)).toBe(false);
        expect(observedParameters).toContain(APPEND_INPUT.retainUntilIsoTimestamp);
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

function createSuccessfulAppendTransaction(
    observedQueries: string[],
    observedParameters: PSqlParameter[] = []
): PSqlSql {
    function query<Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function query(values: readonly PSqlParameter[]): object;
    function query<Result>(
        input: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateStringsArray(input)) {
            return {};
        }
        const strings = input;
        observedParameters.push(...values);
        const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
        observedQueries.push(query);

        if (query.startsWith('with existing_publication as materialized')) {
            return Promise.resolve([{ result_kind: 'appended', ...APPENDED_ROW }] as Result);
        }
        if (query.startsWith('select') && query.includes('from rtc_topology_delivery_log')) {
            return Promise.resolve([] as Result);
        }
        if (query.startsWith('select') && query.includes('from rtc_topology_delivery_stream')) {
            return Promise.resolve([
                {
                    stream_id: APPEND_INPUT.publisherStreamId,
                    head_sequence: 0,
                    retained_from_sequence: 1,
                    lease_expires_at_epoch_ms: 31_000,
                    lease_valid: true
                }
            ] as Result);
        }
        if (query.startsWith('update rtc_topology_delivery_stream')) {
            return Promise.resolve([{ stream_id: APPEND_INPUT.publisherStreamId }] as Result);
        }
        if (query.startsWith('insert into rtc_topology_delivery_log')) {
            return Promise.resolve([APPENDED_ROW] as Result);
        }
        return Promise.reject(new Error(`Unexpected RTC topology delivery SQL: ${query}`));
    }
    const transaction: PSqlSql = Object.assign(query, {
        begin: async <T>(write: (sql: PSqlSql) => Promise<T>) => await write(transaction)
    });
    return transaction;
}

function isTemplateStringsArray(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return Object.hasOwn(value, 'raw');
}
