import assert from 'node:assert/strict';

import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import { RecomputeApiAdminTopology } from '../../src/admin-operations/recompute-api-admin-topology.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;

Deno.test('admin topology recompute materializes the authenticated request facts', async () => {
    let capturedCommand:
        | Readonly<{
            actor: Readonly<{ principalId: string; sessionId: string; }>;
            capturedAtEpochMs: number;
        }>
        | undefined;
    const recompute = new RecomputeApiAdminTopology({
        nowEpochMs: () => NOW_EPOCH_MS,
        topologyInbox: {
            processAuthenticatedHttpEntryUntilCompletionResult: async (reservation) => {
                const command = await reservation.materialize();
                capturedCommand = {
                    actor: command.actor,
                    capturedAtEpochMs: command.capturedAtEpochMs
                };
                return Either.ofRight<AppInboxFailure, {
                    status: 'queued';
                    groupRef: GroupRef;
                    requestId: string;
                    outboxId: string;
                }>({
                    status: 'queued',
                    groupRef: reservation.groupRef,
                    requestId: reservation.requestId,
                    outboxId: 'topology-outbox-1'
                });
            }
        }
    });

    const result = await recompute.execute({
        adminSession: {
            clientId: 'platform-admin',
            username: 'admin',
            accessToken: 'access-token',
            sessionId: 'admin-session',
            issuedAtEpochMs: NOW_EPOCH_MS - 1_000,
            expiresAtEpochMs: NOW_EPOCH_MS + 60_000
        },
        requestId: 'admin-topology-request-0001',
        request: {
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'group-1'
            },
            publish: true,
            options: { topologyKind: 'tree' }
        }
    });

    assert.equal(result.outboxId, 'topology-outbox-1');
    assert.deepEqual(capturedCommand, {
        actor: {
            principalId: 'platform-admin',
            sessionId: 'admin-session'
        },
        capturedAtEpochMs: NOW_EPOCH_MS
    });
});
