import assert from 'node:assert/strict';

import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { createWsSessionGenerationLifecycleService } from '@shared-server/rallar-system/websocket/ws-session-generation-lifecycle.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

Deno.test('PGlite close high-water converges after a stale write and extends replay expiry', async () => {
    await withPGliteSql(async (sql) => {
        const lifecycle = createWsSessionGenerationLifecycleService(
            new PSqlRuntimeStateRepository(sql)
        );
        const identity = {
            scope: {
                kind: 'client',
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                principalId: 'owner',
                clientInstanceId: 'owner-instance'
            },
            sessionId: 'owner-session'
        } as const;
        const older = {
            ...identity,
            generationId: 'generation-older',
            generationStartedAtEpochMs: 1_000,
            disconnectedAtEpochMs: 1_001,
            reason: 'socket-closed',
            expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(1_001, 2_000)
        } as const;
        const newer = {
            ...identity,
            generationId: 'generation-newer',
            generationStartedAtEpochMs: 1_100,
            disconnectedAtEpochMs: 1_101,
            reason: 'socket-closed',
            expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(1_101, 2_100)
        } as const;
        const empty = await lifecycle.read(identity);
        const stale = lifecycle.computeClosed(older, empty);
        const winner = lifecycle.computeClosed(newer, empty);

        await runInPSqlTransaction(sql, async (transaction) => await lifecycle.write(transaction, winner));
        await assert.rejects(
            runInPSqlTransaction(sql, async (transaction) => await lifecycle.write(transaction, stale)),
            RuntimeStateWriteConflictError
        );

        const retryRead = await lifecycle.read(identity);
        assert.equal(lifecycle.computeClosed(older, retryRead).outcome, 'none');
        assert.equal(lifecycle.computeClosed(newer, retryRead).outcome, 'none');
        assert.equal(retryRead.state?.generationId, newer.generationId);
        assert.equal(retryRead.persistedExpireAtEpochMs, newer.expireAtEpochMs);

        const extended = lifecycle.computeClosed({
            ...newer,
            expireAtEpochMs: newer.expireAtEpochMs + 10_000
        }, retryRead);
        assert.equal(extended.outcome, 'update');
        await runInPSqlTransaction(
            sql,
            async (transaction) => await lifecycle.write(transaction, extended)
        );
        const extendedRead = await lifecycle.read(identity);
        assert.equal(extendedRead.state?.generationId, newer.generationId);
        assert.equal(extendedRead.persistedExpireAtEpochMs, newer.expireAtEpochMs + 10_000);
    });
});
