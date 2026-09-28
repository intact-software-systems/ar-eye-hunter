import assert from 'node:assert/strict';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toAppQueueCreatedBy } from '@shared/queuebox/AppQueueIdentity.ts';

import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';

interface OutboxRow {
    readonly ri_type_id: string;
    readonly ri_status: string;
    readonly ri_resource: string;
    readonly created_by: string;
}

const RESOURCE_INBOX_CREATED_BY_WIDTH = 16;

// A server notification is sent by the WS server's own peer id, which is wider than the stored creator column.
Deno.test({
    name: 'a server notification from a peer id wider than the creator column is stored and dispatched',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
        try {
            const server = await createDefaultRallarServer({
                configuration: decodeApiV1Configuration(validDecodeApiV1ConfigurationInput()),
                databaseLifecycle,
                ws: { allowImplicitUserTopics: false, defaultFanout: 'live-only' }
            });
            try {
                server.installSystemTopics().installWebSocketLifecycle();
                await server.runtime.readiness;
                const serverPeerId = server.ws.serverPeerId;
                assert.ok(serverPeerId.length > RESOURCE_INBOX_CREATED_BY_WIDTH);

                const published = await server.ws.publish({
                    message: toServerNotification(serverPeerId),
                    fanout: 'outbox'
                });

                assert.equal(published?.status, 'queued-outbox');
                const row = await waitForCompletedOutboxRow(databaseLifecycle.database);
                assert.equal(row.created_by, toAppQueueCreatedBy(serverPeerId));
                assert.ok(row.created_by.length <= RESOURCE_INBOX_CREATED_BY_WIDTH);
                assert.equal(JSON.parse(row.ri_resource).audit.createdBy, serverPeerId);
            }
            finally {
                await server.runtime.backgroundTasks.stop();
            }
        }
        finally {
            await databaseLifecycle.close();
        }
    }
});

function toServerNotification(serverPeerId: string): ALMessage {
    return newALBroadcastMessage(
        serverPeerId,
        newALRoute('server.notification', 'all', 'notification-1'),
        'all',
        'server.notification.v1',
        { round: 1 },
        {
            reliability: 'at-least-once',
            ack: 'none',
            ttlMs: 15_000
        }
    );
}

type OutboxRowQuery = (strings: TemplateStringsArray) => Promise<readonly OutboxRow[]>;

async function waitForCompletedOutboxRow(database: OutboxRowQuery): Promise<OutboxRow> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const rows = await database`
            select ri_type_id, ri_status, ri_resource, created_by
            from resource_inbox
            where ri_type_id = 'WS_OUTBOX'
        `;
        if (rows[0]?.ri_status === 'COMPLETED') {
            return rows[0];
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The WS outbox row was never dispatched.');
}
