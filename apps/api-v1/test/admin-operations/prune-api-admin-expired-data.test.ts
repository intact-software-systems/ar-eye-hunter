import assert from 'node:assert/strict';

import { toUnavailableAppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { Either } from '@shared/resilience/Either.ts';

import { PruneApiAdminExpiredData } from '../../src/admin-operations/prune-api-admin-expired-data.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;

Deno.test('admin prune exposes typed AppInbox failure facts', async () => {
    const prune = new PruneApiAdminExpiredData({
        appAdminInbox: {
            pruneExpired: () => Promise.resolve(Either.ofLeft(toUnavailableAppInboxFailure()))
        }
    });

    await assert.rejects(
        () =>
            prune.execute({
                adminSession: {
                    clientId: 'platform-admin',
                    username: 'admin',
                    accessToken: 'access-token',
                    sessionId: 'admin-session',
                    issuedAtEpochMs: NOW_EPOCH_MS - 1_000,
                    expiresAtEpochMs: NOW_EPOCH_MS + 60_000
                },
                requestId: 'admin-prune-request-0001',
                request: { dryRun: false }
            }),
        (error) =>
            error instanceof Error &&
            Reflect.get(error, 'code') === 'app-inbox-unavailable' &&
            Reflect.get(error, 'status') === 503
    );
});
