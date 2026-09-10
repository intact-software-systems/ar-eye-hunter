import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { peekOutboundWorkReadyAt } from '../../../shared/alm/outbound-runtime-test-fixture.ts';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresClient,
    requirePostgresDatabaseUrl,
    withPostgresClients
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres AL outbound effect claims', () => {
    postgresIt('keeps one claim across independent connections and fences an old attempt by the same worker', async () => {
        const namespace = `alm-claim-${crypto.randomUUID()}`;
        const databaseUrl = requirePostgresDatabaseUrl();
        await withPostgresClients({ namespace: namespace, clientCount: 2, createClient: () => createRuntimeStatePostgresSql(databaseUrl) }, async (clients) => {
            const first = createAdmission(new PSqlRuntimeStateRepository(requirePostgresClient(clients, 0)), namespace);
            const second = createAdmission(new PSqlRuntimeStateRepository(requirePostgresClient(clients, 1)), namespace);
            const nowMs = Date.now();
            await first.admissionStore.commitBundle({
                senderId: 'sender',
                mutations: [],
                durableEffects: [{
                    effectId: 'receipt-timeout',
                    retryAtMs: nowMs,
                    expireAtTimestamp: nowMs + 60_000,
                    payload: { kind: 'ack-timeout', msgId: 'message' }
                }]
            });
            const input = { maxCount: 1, observedEntries: undefined };
            const results = await Promise.allSettled([first.port.claim(input), second.port.claim(input)]);
            const claimed = results.flatMap((result) => {
                if (result.status === 'rejected') {
                    expect(result.reason).toBeInstanceOf(ALAdmissionBackendConflictError);
                    return [];
                }
                return result.value;
            });
            expect(claimed).toHaveLength(1);
            const [oldClaim] = claimed;
            await new Promise((resolve) => setTimeout(resolve, 10_010));
            const [newClaim] = await second.port.claim(input);

            await first.port.release(oldClaim!, { status: 'completed' });
            const leaseAt = await second.peek();
            expect(leaseAt).toBeGreaterThanOrEqual(newClaim!.leaseUntilMs);
            await first.port.release(oldClaim!, { status: 'not-ready', readyAtMs: Date.now() + 5_000 });
            expect(await second.peek()).toBe(leaseAt);
            await second.port.release(newClaim!, { status: 'completed' });
            expect(await first.peek()).toBeUndefined();
        });
    }, 60_000);
});

function createAdmission(repository: PSqlRuntimeStateRepository, namespace: string) {
    const backend = new PSqlAdmissionWorkBackend(repository.sql, namespace);
    const admissionStore = createALOutboundAdmissionStore({
        decodePrepared: decodeALOutboundTransportMessage,
        nowMs: Date.now,
        namespace,
        canonicalScope: namespace,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const stores = { admissionStore, workQueue: backend.workQueue };
    return {
        admissionStore,
        port: createTestALOutboundWorkPort({ ...stores, nowMs: Date.now }),
        peek: async () => await peekOutboundWorkReadyAt(backend.workQueue, namespace)
    };
}
