import assert from 'node:assert/strict';

import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';
import {
    createPGliteTracedRallarServer,
    issueTracedTestSession,
    waitFor,
    writeTracedRequest,
    type PGliteTracedRallarServer
} from '../db/pglite-traced-rallar-test-runtime.ts';

const DELTA_GROUP_REF: GroupRef = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'delta-sender-room' };
const DELTA_GROUP_PATH = `/api/state/apps/${DELTA_GROUP_REF.applicationId}/workspaces/${DELTA_GROUP_REF.workspaceId}/groups`;

interface GroupDeltaRow {
    readonly senderId: string;
    readonly ack: string | null;
}

Deno.test({
    name: 'default server constructs the complete runtime from explicit operational configuration',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
        try {
            const server = await createDefaultRallarServer({
                configuration: decodeApiV1Configuration(validDecodeApiV1ConfigurationInput()),
                databaseLifecycle,
                ws: {
                    allowImplicitUserTopics: false,
                    defaultFanout: 'live-only'
                }
            });

            assert.ok(server.runtime.authSessionRepository);
            assert.ok(server.runtime.groupStateService);
            assert.ok(server.runtime.backgroundTasks);
            server.installSystemTopics().installWebSocketLifecycle();
            await server.runtime.readiness;
            await server.runtime.backgroundTasks.stop();
        }
        finally {
            await databaseLifecycle.close();
        }
    }
});

// A receiver acknowledges the peer that sent a delta, and the server counts only an ACK addressed to its WS service.
Deno.test({
    name: 'default server sends every group-state delta from its WS service peer, receiver-receipted',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const server = await createPGliteTracedRallarServer();
        try {
            const deltas = await writeGroupWithPresence(server);

            assert.deepEqual(
                deltas.filter((row) => row.senderId !== server.rallar.runtime.wsQBoxServerService.name || row.ack !== 'receiver'),
                []
            );
        }
        finally {
            await server.stop();
        }
    }
});

async function writeGroupWithPresence(server: PGliteTracedRallarServer): Promise<readonly GroupDeltaRow[]> {
    const owner = await issueTracedTestSession(server.rallar.runtime, 'owner');
    await writeTracedRequest(server.app, owner, {
        path: `${DELTA_GROUP_PATH}/requests/delta-sender-group-create`,
        method: 'POST',
        traceId: 'trace-delta-sender-create',
        body: {
            groupId: DELTA_GROUP_REF.groupId,
            displayName: DELTA_GROUP_REF.groupId,
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: owner.clientId
        }
    });
    await writeTracedRequest(server.app, owner, {
        path: `${DELTA_GROUP_PATH}/${DELTA_GROUP_REF.groupId}/sessions/${owner.sessionId}/requests/delta-sender-presence-connect`,
        method: 'PUT',
        traceId: 'trace-delta-sender-presence',
        body: { principalId: owner.clientId, generationId: 'delta-sender-generation', connectionGenerationId: 'delta-sender-generation' }
    });
    return await waitFor('the group and its presence to write group-state deltas', () => readGroupDeltaRows(server.sql));
}

async function readGroupDeltaRows(sql: PGliteSql): Promise<readonly GroupDeltaRow[] | undefined> {
    const rows = await sql<GroupDeltaRow[]>`
        select ri_resource::jsonb #>> '{id,senderId}' as "senderId",
               ri_resource::jsonb #>> '{delivery,ack}' as ack
        from resource_inbox
        where ri_type_id = 'WS_OUTBOX' and ri_resource::jsonb #>> '{payload,typeId}' = ${AppTopics.groupStateEvent}
    `;
    return rows.length > 0 ? rows : undefined;
}
