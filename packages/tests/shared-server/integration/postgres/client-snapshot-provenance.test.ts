import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { WS_OUTBOX_PROVENANCE_NAMESPACE, WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';

import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createPostgresAppInboxWorkerRuntime, createPostgresAppInboxWorkerTrace } from './test-support/postgres-app-inbox-worker-runtime.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres client snapshot provenance transaction', () => {
    postgresIt.each(['commit', 'rollback'] as const)('keeps uncommitted row and proof private until %s', async (outcome) => {
        const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        const observer = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        const sessionId = `proof-${crypto.randomUUID()}`;
        const principalId = `principal-${crypto.randomUUID()}`;
        const scope = { applicationId: 'snapshot-provenance-test', workspaceId: sessionId };
        const now = Date.now();
        const authSession = {
            clientId: principalId,
            username: principalId,
            sessionId,
            accessToken: 'test-only',
            issuedAtEpochMs: now - 1_000,
            expiresAtEpochMs: now + 60_000
        };
        const begin = sql.begin.bind(sql);
        let observedUncommitted = false;
        const spy = vi.spyOn(sql, 'begin').mockImplementation(async (write) =>
            await begin(async (transaction) => {
                const result = await write(transaction);
                const proofs = await transaction<{ store_key: string; }[]>`
                select store_key from runtime_state_store where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE}
                and store_value::jsonb->'target'->>'peerId' = ${sessionId}
            `;
                if (proofs.length > 0 && !observedUncommitted) {
                    observedUncommitted = true;
                    expect(
                        await observer`select store_key from runtime_state_store where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE} and store_key = ${
                            proofs[0]!.store_key
                        }`
                    ).toEqual([]);
                    expect(
                        await observer`select ri_row_id from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX} and ri_resource::jsonb->'targets'->>'toPeerId' = ${sessionId}`
                    ).toEqual([]);
                    if (outcome === 'rollback') {
                        throw new NonRetryableException('Injected mutation rollback');
                    }
                }
                return result;
            })
        );
        try {
            const runtime = createPostgresAppInboxWorkerRuntime({ sql, serviceId: 'proof-server', atEpochMs: now, trace: createPostgresAppInboxWorkerTrace() });
            await runtime.authSessions.putSession(authSession);
            const result = await runtime.runUntilCompletion(() =>
                runtime.client.processAuthorisedWsClientConnect({
                    authSession,
                    generationId: 'proof-generation',
                    input: { ...scope, clientInstanceId: 'browser', connectedAtEpochMs: now, expiresAtEpochMs: now + 60_000 }
                })
            );
            expect(observedUncommitted).toBe(true);
            const rows = await observer<
                ResourceInboxRow[]
            >`select * from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX} and ri_resource::jsonb->'targets'->>'toPeerId' = ${sessionId}`;
            const proofs = await observer<
                { store_key: string; }[]
            >`select store_key from runtime_state_store where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE} and store_value::jsonb->'target'->>'peerId' = ${sessionId}`;
            if (outcome === 'rollback') {
                expect(result.left).toBeDefined();
                expect(rows).toEqual([]);
                expect(proofs).toEqual([]);
                expect(await runtime.client.clientStateService.readSnapshot({ ...scope, principalId })).toBeUndefined();
                return;
            }
            expect(result.right).toBeDefined();
            expect(rows).toHaveLength(1);
            expect(proofs).toHaveLength(1);
            const entry = toDomain(rows[0]!);
            const reader = new WsOutboxProvenanceReader({ repository: new PSqlRuntimeStateRepository(observer), nowMs: Date.now });
            expect(await reader.readProducerProvenance(decodePersistedALMessage(entry.resource), entry)).toEqual({
                admittedAudience: [sessionId],
                recipientScope: scope
            });
        }
        finally {
            spy.mockRestore();
            await sql.end();
            await observer.end();
        }
    }, 60_000);
});
