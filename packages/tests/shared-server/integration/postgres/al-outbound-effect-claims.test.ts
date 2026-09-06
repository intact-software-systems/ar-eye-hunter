import { describe, expect, it } from 'vitest';

import { PSqlOutboundAdmissionBackend } from '@shared-server/al-runtime/postgres/p-sql-outbound-admission-backend.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
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
        await withPostgresClients(namespace, 2, () => createRuntimeStatePostgresSql(databaseUrl), async (clients) => {
            const first = createAdmission(new PSqlRuntimeStateRepository(requirePostgresClient(clients, 0)), namespace);
            const second = createAdmission(new PSqlRuntimeStateRepository(requirePostgresClient(clients, 1)), namespace);
            const nowMs = Date.now();
            await first.commitBundle({
                senderId: 'sender',
                mutations: [],
                durableEffects: [{
                    effectId: 'receipt-timeout',
                    retryAtMs: nowMs,
                    expireAtTimestamp: nowMs + 60_000,
                    payload: { kind: 'ack-timeout', msgId: 'message' }
                }]
            }, decodeALOutboundPreparedMessage);
            const input = { workerId: 'same-worker', maxCount: 1, leaseMs: 100, nowMs };
            const results = await Promise.allSettled([
                first.claimReadyEffects(input, decodeALOutboundPreparedMessage),
                second.claimReadyEffects(input, decodeALOutboundPreparedMessage)
            ]);
            const claimed = results.flatMap((result) => {
                if (result.status === 'rejected') {
                    expect(result.reason).toBeInstanceOf(ALAdmissionBackendConflictError);
                    return [];
                }
                return result.value;
            });
            expect(claimed).toHaveLength(1);
            const [oldClaim] = claimed;
            const [newClaim] = await second.claimReadyEffects({ ...input, nowMs: nowMs + 100 }, decodeALOutboundPreparedMessage);

            await first.completeEffect(oldClaim.effectId, oldClaim.leaseOwner, decodeALOutboundPreparedMessage);
            expect(await second.peekNextEffectReadyAt(decodeALOutboundPreparedMessage)).toBe(newClaim.leaseUntilMs);
            await first.rescheduleEffect({
                effectId: oldClaim.effectId,
                leaseOwner: oldClaim.leaseOwner,
                retryAtMs: nowMs + 5_000,
                lastError: 'Late native failure'
            }, decodeALOutboundPreparedMessage);
            expect(await second.peekNextEffectReadyAt(decodeALOutboundPreparedMessage)).toBe(newClaim.leaseUntilMs);
            await second.completeEffect(newClaim.effectId, newClaim.leaseOwner, decodeALOutboundPreparedMessage);
            expect(await first.peekNextEffectReadyAt(decodeALOutboundPreparedMessage)).toBeUndefined();
        });
    }, 60_000);
});

function createAdmission(repository: PSqlRuntimeStateRepository, namespace: string) {
    return createALOutboundAdmissionStore({
        namespace,
        backend: new PSqlOutboundAdmissionBackend(repository, namespace),
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
}
