import type { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { RallarServerApplication } from '@shared-server/rallar-server/rallar-server-application.ts';
import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import type { GroupLifecyclePolicyInput } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type {
    ConnectGroupPresenceSessionRequest,
    CreateGroupRequest,
    JoinGroupRequest
} from '@shared/api/state-types.ts';

import defaults from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

const CHAIN_TRACE_ID = 'trace-formation-chain';
const GROUP_REF: GroupRef = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'formation-chain-room' };
const GROUP_PATH = `/api/state/apps/${GROUP_REF.applicationId}/workspaces/${GROUP_REF.workspaceId}/groups`;
const SETTLE_TIMEOUT_MS = 30_000;

/**
 * Phased formation whose plan trigger is one live member: the joiner's presence is the evidence that plans,
 * connects and activates the group, and its single-session layout is trivially ready.
 */
const PRESENCE_FORMATION_POLICY: GroupLifecyclePolicyInput = {
    preset: 'optimistic',
    formation: 'phased',
    establishment: {
        planTrigger: { kind: 'presence', memberCount: 1, fallbackMs: 3_600_000 },
        connectTrigger: { kind: 'immediate' }
    },
    activation: { mode: 'threshold', successRate: 1, minimumViableRate: 0 }
};

interface FormationChainServer {
    readonly rallar: RallarServerApplication<ApiV1Runtime, Hono>;
    readonly sql: PGliteSql;
    readonly app: Hono;
    readonly stop: () => Promise<void>;
}

interface TracedRow {
    readonly rowId: number;
    readonly type: string;
    readonly typeId: string;
    readonly traceId: string;
    readonly senderId: string;
    readonly ack: string | null;
}

Deno.test({
    name: 'PGlite formation keeps the join trace from the presence evidence to the activation status publication',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const server = await createFormationChainServer();
        try {
            const runtime = server.rallar.runtime;
            const owner = await issueSession(runtime, 'owner');
            const joiner = await issueSession(runtime, 'joiner');
            await writeTracedRequest(server.app, owner, {
                path: `${GROUP_PATH}/requests/formation-chain-create`,
                method: 'POST',
                traceId: 'trace-formation-create',
                body: {
                    groupId: GROUP_REF.groupId,
                    displayName: GROUP_REF.groupId,
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: owner.clientId,
                    lifecyclePolicy: PRESENCE_FORMATION_POLICY
                }
            });
            await waitForQuiescentQueue(server.sql);
            const watermark = await readRowWatermark(server.sql);

            await writeTracedRequest(server.app, joiner, {
                path: `${GROUP_PATH}/${GROUP_REF.groupId}/join/requests/formation-chain-join`,
                method: 'POST',
                traceId: CHAIN_TRACE_ID,
                body: {}
            });
            await writeTracedRequest(server.app, joiner, {
                path: `${GROUP_PATH}/${GROUP_REF.groupId}/sessions/${joiner.sessionId}/requests/formation-chain-presence`,
                method: 'PUT',
                traceId: CHAIN_TRACE_ID,
                body: { principalId: joiner.clientId, generationId: 'joiner-generation', connectionGenerationId: 'joiner-generation' }
            });
            const activated = await waitForActivationStatus(runtime);

            assert.equal(activated.group.lifecycleState, 'active');
            const rows = await readRowsAfter(server.sql, watermark);
            const inboxTypes = new Set(rows.filter((row) => row.type === 'APP_INBOX').map((row) => row.typeId));
            for (const formationType of ['GROUP_FORMATION_AUTOMATION', 'GROUP_FORMATION_CRITERION', 'GROUP_ACTIVATION_STATUS']) {
                assert.ok(inboxTypes.has(formationType), `the chain wrote a ${formationType} command`);
            }
            assert.ok(rows.some((row) => row.type === 'WS_OUTBOX'), 'the chain wrote WS publications');
            assert.deepEqual(rows.filter((row) => row.traceId !== CHAIN_TRACE_ID), []);
            const deltas = rows.filter((row) => row.type === 'WS_OUTBOX' && row.typeId === AppTopics.groupStateEvent);
            assert.ok(deltas.length > 0, 'the chain wrote group-state deltas');
            // A receiver acknowledges the peer that sent the delta, so the sender is the WS service the browser is connected to.
            assert.deepEqual(
                deltas.filter((row) => row.senderId !== runtime.wsQBoxServerService.name || row.ack !== 'receiver'),
                []
            );
        }
        finally {
            await server.stop();
        }
    }
});

async function createFormationChainServer(): Promise<FormationChainServer> {
    const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const engineStopped = Promise.withResolvers<void>();
    const rallar = await createDefaultRallarServer({
        configuration: decodeApiV1Configuration({
            ...validDecodeApiV1ConfigurationInput(),
            defaultsSource: { ...defaults, observability: { ...defaults.observability, timingLogs: false } }
        }),
        databaseLifecycle: {
            ...databaseLifecycle,
            close: async () => {
                await engineStopped.promise;
                await databaseLifecycle.close();
            }
        }
    });
    const app = createTracedApiTestApp();
    rallar.installSystemTopics();
    rallar.installWebSocketLifecycle();
    rallar.mountRest(app);
    await rallar.runtime.readiness;
    rallar.start();
    return {
        rallar,
        sql: databaseLifecycle.database,
        app,
        stop: async () => {
            await rallar.runtime.wsQBoxServerService.dispose();
            const stoppingBackground = rallar.runtime.backgroundTasks.stop();
            await rallar.runtime.qboxEngine.stop();
            engineStopped.resolve();
            await stoppingBackground;
        }
    };
}

async function issueSession(runtime: ApiV1Runtime, clientId: string): Promise<AuthSession> {
    const issued = await runtime.appAuthInboxService.issueSession({
        requestId: `formation-chain-session-${clientId}`,
        traceId: `trace-formation-session-${clientId}`,
        clientId,
        username: clientId,
        authority: { kind: 'static-client', clientId, normalizedUsername: clientId },
        ttlMs: 3_600_000
    });
    assert.ok(issued.right, `the auth AppInbox issues the ${clientId} session`);
    return issued.right;
}

interface TracedRequest {
    readonly path: string;
    readonly method: 'POST' | 'PUT';
    readonly traceId: string;
    readonly body: CreateGroupRequest | JoinGroupRequest | ConnectGroupPresenceSessionRequest;
}

async function writeTracedRequest(app: Hono, session: AuthSession, request: TracedRequest): Promise<void> {
    const response = await app.request(request.path, {
        method: request.method,
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.accessToken}`,
            'x-client-id': session.clientId,
            'x-request-id': request.traceId
        },
        body: JSON.stringify(request.body)
    });
    const body = await response.text();
    assert.ok(response.ok, `${request.method} ${request.path} answered ${response.status}: ${body}`);
}

async function waitForQuiescentQueue(sql: PGliteSql): Promise<void> {
    await waitFor('the queue to settle', async () => {
        const [pending] = await sql<{ count: number; }[]>`
            select count(*)::int as count from resource_inbox
            where ri_status in ('NEW', 'RESERVED', 'RETRY')
              and (next_ts is null or next_ts <= now() at time zone 'UTC')
        `;
        return pending?.count === 0 ? true : undefined;
    });
}

async function readRowWatermark(sql: PGliteSql): Promise<number> {
    const [watermark] = await sql<{ rowId: number; }[]>`
        select coalesce(max(ri_row_id), 0)::double precision as "rowId" from resource_inbox
    `;
    return watermark?.rowId ?? 0;
}

async function waitForActivationStatus(runtime: ApiV1Runtime): Promise<GroupSnapshot> {
    return await waitFor('the activation status publication', async () => {
        const snapshot = await runtime.groupStateService.readSnapshot(GROUP_REF);
        return snapshot?.group.activationStatus === null ? undefined : snapshot;
    });
}

async function readRowsAfter(sql: PGliteSql, watermark: number): Promise<readonly TracedRow[]> {
    return await sql<TracedRow[]>`
        select ri_row_id::double precision as "rowId", ri_type_id as type,
               ri_resource::jsonb #>> '{payload,typeId}' as "typeId",
               ri_resource::jsonb #>> '{id,traceId}' as "traceId",
               ri_resource::jsonb #>> '{id,senderId}' as "senderId",
               ri_resource::jsonb #>> '{delivery,ack}' as ack
        from resource_inbox
        where ri_row_id > ${watermark} and ri_type_id in ('APP_INBOX', 'APP_OUTBOX', 'WS_OUTBOX')
        order by ri_row_id
    `;
}

async function waitFor<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
    const deadline = performance.now() + SETTLE_TIMEOUT_MS;
    do {
        const value = await read();
        if (value !== undefined) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (performance.now() < deadline);
    throw new Error(`Timed out after ${SETTLE_TIMEOUT_MS} ms waiting for ${label}`);
}
