import assert from 'node:assert/strict';

import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';
import {
    createNativeSessionTestFixture,
    issueSameUserSessions,
    writeNativeGroupCreate,
    writeNativeGroupPresence,
    type NativeGroupSessionFlow,
    type NativeSessionTestFixture
} from '../db/native-session-test-fixture.ts';

const DELTA_SETTLE_TIMEOUT_MS = 30_000;

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
        const fixture = await createNativeSessionTestFixture();
        let primaryFailure: Error | undefined;
        try {
            const deltas = await writeGroupWithPresence(fixture);

            assert.ok(deltas.length > 0, 'the group and its presence wrote group-state deltas');
            assert.deepEqual(
                deltas.filter((row) => row.senderId !== fixture.runtime.wsQBoxServerService.name || row.ack !== 'receiver'),
                []
            );
        }
        catch (cause) {
            primaryFailure = cause instanceof Error ? cause : new Error(String(cause));
            throw cause;
        }
        finally {
            await fixture.stop([], primaryFailure);
        }
    }
});

async function writeGroupWithPresence(fixture: NativeSessionTestFixture): Promise<readonly GroupDeltaRow[]> {
    const baseUrl = await fixture.start();
    const [session] = await issueSameUserSessions(fixture.runtime, fixture.sessionTtlMs);
    assert.ok(session, 'the auth AppInbox issues a session');
    const groupRef: GroupRef = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'delta-sender-room' };
    const flow: NativeGroupSessionFlow = { baseUrl, session, groupRef, generationId: 'delta-sender-generation', index: 0 };
    assert.equal((await writeNativeGroupCreate(flow)).status, 201);
    assert.ok((await writeNativeGroupPresence(flow)).status < 300, 'the presence connect is accepted');
    return await readGroupDeltaRows(fixture);
}

async function readGroupDeltaRows(fixture: NativeSessionTestFixture): Promise<readonly GroupDeltaRow[]> {
    const deadline = performance.now() + DELTA_SETTLE_TIMEOUT_MS;
    do {
        const rows = await fixture.databaseLifecycle.database<GroupDeltaRow[]>`
            select ri_resource::jsonb #>> '{id,senderId}' as "senderId",
                   ri_resource::jsonb #>> '{delivery,ack}' as ack
            from resource_inbox
            where ri_type_id = 'WS_OUTBOX' and ri_resource::jsonb #>> '{payload,typeId}' = ${AppTopics.groupStateEvent}
        `;
        if (rows.length > 0) {
            return rows;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (performance.now() < deadline);
    return [];
}
