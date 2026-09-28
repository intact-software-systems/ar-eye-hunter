import { describe, expect, it, vi } from 'vitest';

import { WS_OUTBOX_PROVENANCE_NAMESPACE } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';

import { createGroupDeltaProducer, readCommittedGroupDelta } from '../../rallar-system/group-state/presence/group-delta-producer-fixture.ts';
import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres group delta atomic provenance', () => {
    postgresIt.each(['commit', 'rollback'] as const)('keeps row and proof private until %s', async (outcome) => {
        const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        const observer = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        try {
            const producer = await createGroupDeltaProducer(sql);
            const begin = sql.begin.bind(sql);
            const transaction = vi.spyOn(sql, 'begin').mockImplementation(async (write) =>
                await begin(async (pending) => {
                    const result = await write(pending);
                    expect(
                        await pending`select store_key from runtime_state_store where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE}
                    and store_value::jsonb->'target'->'groupRef'->>'groupId' = ${producer.ref.groupId}`
                    ).toHaveLength(1);
                    expect(
                        await observer`select store_key from runtime_state_store where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE}
                    and store_value::jsonb->'target'->'groupRef'->>'groupId' = ${producer.ref.groupId}`
                    ).toEqual([]);
                    expect(
                        await observer`select ri_row_id from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX}
                    and ri_resource::jsonb->'targets'->'groupRef'->>'groupId' = ${producer.ref.groupId}`
                    ).toEqual([]);
                    if (outcome === 'rollback') {
                        throw new Error('Injected commit failure');
                    }
                    return result;
                })
            );
            try {
                const result = producer.worker.processReservedEntry(producer.message, producer.entry);
                if (outcome === 'rollback') {
                    await expect(result).rejects.toThrow('Injected commit failure');
                }
                else {
                    await result;
                    expect((await readCommittedGroupDelta(producer)).key.topicId).toBe('group-state.event');
                }
                expect(
                    await observer`select store_key from runtime_state_store where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE}
                    and store_value::jsonb->'target'->'groupRef'->>'groupId' = ${producer.ref.groupId}`
                ).toHaveLength(outcome === 'commit' ? 1 : 0);
                expect(
                    await observer`select ri_row_id from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX}
                    and ri_resource::jsonb->'targets'->'groupRef'->>'groupId' = ${producer.ref.groupId}`
                ).toHaveLength(outcome === 'commit' ? 1 : 0);
            }
            finally {
                transaction.mockRestore();
            }
        }
        finally {
            await sql.end();
            await observer.end();
        }
    }, 60_000);
});
