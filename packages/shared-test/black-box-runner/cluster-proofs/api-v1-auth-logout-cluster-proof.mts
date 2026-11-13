import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import {
    decodeWsOutboxProvenance,
    type WsOutboxProvenance
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import {
    parseApiV1BlackBoxArgs,
    toApiV1BlackBoxEnvironment,
    toApiV1ServerCommand,
    toManagedApiServerPlans
} from '../api-v1-black-box-run.mts';
import { managedApiDiagnosticSecrets, waitForManagedApiReady } from '../managed-api/api-v1-managed-api-readiness.mts';
import { withManagedPostgresRunDatabase } from '../managed-api/api-v1-managed-postgres-run-database.mts';
import { startManagedApiServer, stopManagedApiServer } from '../managed-api/api-v1-managed-process-lifecycle.mts';
import { withManagedApiServerPlans, type ManagedApiServerPlan } from '../managed-api/with-managed-api-server-plans.mts';
import { ApiV1RtcTopologyProofApi, type ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';

interface LogoutClusterScenario {
    readonly plans: readonly ManagedApiServerPlan[];
    readonly databaseUrl: string;
    readonly artifactDir: string;
}

interface LogoutProofSocket {
    readonly socket: WebSocket;
    readonly frames: string[];
    readonly closeCodes: number[];
}

async function runLogoutClusterProof(): Promise<void> {
    const options = parseApiV1BlackBoxArgs(process.argv.slice(2));
    assert.ok(options.backend === 'postgres' && options.secondaryPort && options.tertiaryPort && !options.recipesOnly);
    const environment = toApiV1BlackBoxEnvironment(options, process.env);
    const artifactDir = resolve(options.artifactDir, environment.RALLAR_BB_EXECUTION_TOKEN!);
    const repoRootPath = fileURLToPath(new URL('../../../../', import.meta.url));
    await mkdir(artifactDir, { recursive: true });
    await withManagedPostgresRunDatabase(environment.DATABASE_URL!, options.runId, async (databaseUrl) => {
        const env = { ...environment, DATABASE_URL: databaseUrl };
        const migration = Bun.spawn({
            cmd: ['npm', 'run', 'db:migrate'],
            cwd: repoRootPath,
            env,
            stdout: 'ignore',
            stderr: 'inherit'
        });
        assert.deepEqual(await migration.exited, 0);
        const plans = toManagedApiServerPlans(options, env, artifactDir).map((plan, index) => ({
            ...plan,
            env: { ...plan.env, RALLAR_API_QUEUE_WORKERS: index === 0 ? 'enabled' : 'disabled' }
        }));
        await withManagedApiServerPlans({
            plans,
            serverCommand: toApiV1ServerCommand(options),
            repoRootPath,
            artifactDir
        }, {
            writeEmptyLogFile: (path) => writeFile(path, ''),
            startServer: startManagedApiServer,
            waitForReady: waitForManagedApiReady,
            toDiagnosticSecrets: managedApiDiagnosticSecrets,
            runRecipes: () => assertLogoutClusterDelivery({ plans, databaseUrl, artifactDir }),
            verifyFairness: async () => {},
            stopServer: stopManagedApiServer
        });
    });
    console.log(`PASS: auth logout A -> B; unrelated C remains open. Artifacts: ${artifactDir}`);
}

async function assertLogoutClusterDelivery(scenario: LogoutClusterScenario): Promise<void> {
    const [primary, secondary, tertiary] = scenario.plans;
    assert.ok(primary && secondary && tertiary);
    const api = new ApiV1RtcTopologyProofApi({
        alice: { username: 'alice', password: 'secret' },
        bob: { username: 'bob', password: 'secret' },
        admin: { username: 'admin', password: 'admin' }
    });
    const recipient = await api.login({
        label: 'recipient-B',
        principal: 'alice',
        apiBaseUrl: primary.baseUrl,
        wsBaseUrl: secondary.baseUrl.replace(/^http/, 'ws')
    });
    const outsider = await api.login({
        label: 'outsider-C',
        principal: 'bob',
        apiBaseUrl: primary.baseUrl,
        wsBaseUrl: tertiary.baseUrl.replace(/^http/, 'ws')
    });
    const target = await openLogoutProofSocket(api, recipient);
    const unrelated = await openLogoutProofSocket(api, outsider);
    assert.deepEqual(unrelated.socket.readyState, WebSocket.OPEN);
    assert.deepEqual(unrelated.closeCodes, []);
    const requestId = `auth-logout-proof-${crypto.randomUUID()}`;
    try {
        const delivery = waitForLogoutFrame(target.socket);
        const response = await fetch(`${primary.baseUrl}/api/auth/logout/requests/${requestId}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${recipient.accessToken}`, 'x-client-id': recipient.clientId }
        });
        assert.deepEqual(response.status, 200);
        assert.deepEqual(await response.json(), { loggedOut: true });
        const frame = JSON.parse(await delivery);
        assert.deepEqual(frame.targets, { mode: 'unicast', toPeerId: recipient.sessionId });
        assert.deepEqual(JSON.parse(frame.payload.resource), {
            sessionId: recipient.sessionId,
            closeCode: 1000,
            reason: 'auth-logout'
        });
        const proof = await readLogoutProof(scenario.databaseUrl, requestId);
        assert.deepEqual(proof.messageId, frame.id.msgId);
        if (proof.target.kind !== 'exact-invalidated-session') {
            throw new Error(`Expected exact invalidated session proof, got ${proof.target.kind}`);
        }
        assert.deepEqual(proof.target.admittedAudience, [recipient.sessionId]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.deepEqual(target.frames.filter((value) => JSON.parse(value).id?.msgId === frame.id.msgId).length, 1);
        assert.deepEqual(
            unrelated.frames.filter((value) => JSON.parse(value).route?.topicId === 'auth.session.logout'),
            []
        );
        assert.deepEqual(unrelated.socket.readyState, WebSocket.OPEN);
        assert.deepEqual(unrelated.closeCodes, []);
        await writeLogoutEvidence(scenario, requestId, proof);
    }
    finally {
        target.socket.close(1000, 'proof-complete');
        unrelated.socket.close(1000, 'proof-complete');
    }
}

async function writeLogoutEvidence(
    scenario: LogoutClusterScenario,
    requestId: string,
    proof: WsOutboxProvenance
): Promise<void> {
    await writeFile(
        `${scenario.artifactDir}/auth-logout-cluster-proof.json`,
        JSON.stringify(
            {
                producer: 'A',
                receiver: 'B',
                outsider: 'C',
                requestId,
                messageId: proof.messageId,
                target: proof.target,
                queueWorkers: scenario.plans.map((plan) => plan.env.RALLAR_API_QUEUE_WORKERS)
            },
            null,
            2
        ),
        'utf8'
    );
}

async function openLogoutProofSocket(api: ApiV1RtcTopologyProofApi, session: ProofSession): Promise<LogoutProofSocket> {
    const ticket = await api.issueWebSocketTicket(session);
    const query = new URLSearchParams({ ticket, applicationId: 'logout-proof', workspaceId: 'workspace' });
    const socket = new WebSocket(`${session.wsBaseUrl}/api/ws/${session.sessionId}?${query}`);
    const frames: string[] = [];
    const closeCodes: number[] = [];
    socket.addEventListener('message', (event) => frames.push(String(event.data)));
    socket.addEventListener('close', (event) => closeCodes.push(event.code));
    await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('Authenticated proof socket failed')), { once: true });
    });
    return { socket, frames, closeCodes };
}

function waitForLogoutFrame(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
        const listener = (event: MessageEvent) => {
            const frame = JSON.parse(String(event.data));
            if (frame.route?.topicId !== 'auth.session.logout') {
                return;
            }
            clearTimeout(timeout);
            socket.removeEventListener('message', listener);
            resolve(String(event.data));
        };
        const timeout = setTimeout(() => {
            socket.removeEventListener('message', listener);
            reject(new Error('Process B did not receive the exact logout notice'));
        }, 10_000);
        socket.addEventListener('message', listener);
    });
}

async function readLogoutProof(databaseUrl: string, requestId: string): Promise<WsOutboxProvenance> {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
        const rows = await sql<{ proof: string; }[]>`
            select proof.store_value as proof from resource_inbox outbox join runtime_state_store proof
            on proof.store_namespace = 'ws-outbox-provenance'
            and proof.store_value::jsonb->>'messageId' = outbox.ri_resource::jsonb->'id'->>'msgId'
            where outbox.ri_type_id = 'WS_OUTBOX' and outbox.ri_resource::jsonb->'route'->>'topicId' = 'auth.session.logout'
            and outbox.ri_resource::jsonb->'route'->>'resourceId' = ${requestId}
        `;
        assert.deepEqual(rows.length, 1, 'Exactly one committed logout row and proof');
        return decodeWsOutboxProvenance(JSON.parse(rows[0]!.proof));
    }
    finally {
        await sql.end();
    }
}

if (import.meta.main) {
    await runLogoutClusterProof();
}
