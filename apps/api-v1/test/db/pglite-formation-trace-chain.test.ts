import assert from 'node:assert/strict';

import type { GroupLifecyclePolicyInput } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import {
    createPGliteTracedRallarServer,
    issueTracedTestSession,
    waitFor,
    writeTracedRequest
} from './pglite-traced-rallar-test-runtime.ts';

const CHAIN_TRACE_ID = 'trace-formation-chain';
const GROUP_REF: GroupRef = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'formation-chain-room' };
const GROUP_PATH = `/api/state/apps/${GROUP_REF.applicationId}/workspaces/${GROUP_REF.workspaceId}/groups`;

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

interface TracedRow {
    readonly rowId: number;
    readonly type: string;
    readonly typeId: string;
    readonly traceId: string;
}

Deno.test({
    name: 'PGlite formation keeps the join trace from the presence evidence to the activation status publication',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const server = await createPGliteTracedRallarServer();
        try {
            const runtime = server.rallar.runtime;
            const owner = await issueTracedTestSession(runtime, 'owner');
            const joiner = await issueTracedTestSession(runtime, 'joiner');
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
        }
        finally {
            await server.stop();
        }
    }
});

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
               ri_resource::jsonb #>> '{id,traceId}' as "traceId"
        from resource_inbox
        where ri_row_id > ${watermark} and ri_type_id in ('APP_INBOX', 'APP_OUTBOX', 'WS_OUTBOX')
        order by ri_row_id
    `;
}
