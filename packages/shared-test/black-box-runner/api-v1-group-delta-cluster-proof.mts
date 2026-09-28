import { assertEquals } from '@std/assert';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import {
    decodeWsOutboxProvenance,
    type WsOutboxProvenance
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';

import {
    parseApiV1BlackBoxArgs,
    toApiV1BlackBoxEnvironment,
    toApiV1ServerCommand,
    toManagedApiServerPlans,
    type ApiV1BlackBoxOptions
} from './api-v1-black-box-run.mts';
import { createDefaultExecutionDependencies } from './execution/black-box-scenario-context.ts';
import {
    closeWs,
    openWs,
    type LocalWsContext
} from './execution/local-websocket-session.ts';
import {
    managedApiDiagnosticSecrets,
    waitForManagedApiReady
} from './managed-api/api-v1-managed-api-readiness.mts';
import { withManagedPostgresRunDatabase } from './managed-api/api-v1-managed-postgres-run-database.mts';
import { startManagedApiServer, stopManagedApiServer } from './managed-api/api-v1-managed-process-lifecycle.mts';
import {
    withManagedApiServerPlans,
    type ManagedApiServerPlan
} from './managed-api/with-managed-api-server-plans.mts';
import { verifyApiV1FairnessProof } from './state-write-evidence/api-v1-fairness-proof.ts';
import {
    ApiV1RtcTopologyProofApi,
    type ProofGroupInput,
    type ProofSession
} from './topology-replay/api-v1-rtc-topology-proof-api.mts';
import {
    waitForWsMessage,
    waitForWsMessageAbsence,
    type WsInteraction
} from './ws/ws-wait-expectations.ts';

interface GroupDeltaClusterRun {
    readonly options: ApiV1BlackBoxOptions;
    readonly environment: Record<string, string>;
    readonly artifactDir: string;
    readonly repoRoot: string;
}

interface GroupDeltaClusterScenario {
    readonly databaseUrl: string;
    readonly artifactDir: string;
    readonly plans: readonly ManagedApiServerPlan[];
}

interface GroupDeltaClusterActors {
    readonly api: ApiV1RtcTopologyProofApi;
    readonly recipient: ProofSession;
    readonly outsider: ProofSession;
    readonly group: ProofGroupInput;
}

interface GroupDeltaProofRow {
    readonly proof: string;
}

interface GroupDeltaClusterEvidence {
    readonly producer: 'A';
    readonly receiver: 'B';
    readonly outsider: 'C';
    readonly queueWorkers: readonly string[];
    readonly requestId: string;
    readonly messageId: string;
    readonly target: WsOutboxProvenance['target'];
    readonly ports: readonly number[];
}

async function runGroupDeltaClusterProof(): Promise<void> {
    const options = parseApiV1BlackBoxArgs(Deno.args);
    if (options.backend !== 'postgres' || !options.secondaryPort || !options.tertiaryPort || options.recipesOnly) {
        throw new Error('Group delta proof requires a managed three-process PostgreSQL cluster.');
    }
    const environment = toApiV1BlackBoxEnvironment(options, Deno.env.toObject());
    const run: GroupDeltaClusterRun = {
        options,
        environment,
        artifactDir: resolve(options.artifactDir, environment.RALLAR_BB_EXECUTION_TOKEN!),
        repoRoot: fileURLToPath(new URL('../../../', import.meta.url))
    };
    await Deno.mkdir(run.artifactDir, { recursive: true });
    await withManagedPostgresRunDatabase(environment.DATABASE_URL!, options.runId, async (databaseUrl) => {
        await runGroupDeltaClusterInDatabase(run, databaseUrl);
    });
    console.log(`Group delta proof artifacts: ${run.artifactDir}`);
}

async function runGroupDeltaClusterInDatabase(run: GroupDeltaClusterRun, databaseUrl: string): Promise<void> {
    const environment = { ...run.environment, DATABASE_URL: databaseUrl };
    const migration = await new Deno.Command('npm', {
        args: ['run', 'db:migrate'],
        cwd: run.repoRoot,
        env: environment,
        stdout: 'null',
        stderr: 'inherit'
    }).output();
    assertEquals(migration.code, 0, 'Fresh proof database migration');
    const plans = toManagedApiServerPlans(run.options, environment, run.artifactDir).map((plan, index) => ({
        ...plan,
        env: { ...plan.env, RALLAR_API_QUEUE_WORKERS: index === 0 ? 'enabled' : 'disabled' }
    }));
    await withManagedApiServerPlans({
        plans,
        serverCommand: toApiV1ServerCommand(run.options),
        repoRootPath: run.repoRoot,
        artifactDir: run.artifactDir
    }, {
        writeEmptyLogFile: (path) => Deno.writeTextFile(path, ''),
        startServer: startManagedApiServer,
        waitForReady: waitForManagedApiReady,
        toDiagnosticSecrets: managedApiDiagnosticSecrets,
        runRecipes: () => assertGroupDeltaCrossProcessDelivery({ databaseUrl, artifactDir: run.artifactDir, plans }),
        verifyFairness: async (artifactDir, logPaths) => {
            await verifyApiV1FairnessProof(artifactDir, logPaths);
        },
        stopServer: stopManagedApiServer
    });
}

async function writeGroupDeltaClusterFixture(plans: readonly ManagedApiServerPlan[]): Promise<GroupDeltaClusterActors> {
    const [primary, secondary, tertiary] = plans;
    if (!primary || !secondary || !tertiary || plans.length !== 3) {
        throw new Error('Group delta proof requires exactly three API processes.');
    }
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
    const proofId = `group-delta-${crypto.randomUUID()}`;
    const group: ProofGroupInput = { proofId, applicationId: proofId, workspaceId: 'workspace', groupId: 'room' };
    await api.createGroup({ ...group, owner: recipient });
    await api.connectPresence({ ...group, actor: recipient });
    return { api, recipient, outsider, group };
}

async function assertGroupDeltaCrossProcessDelivery(scenario: GroupDeltaClusterScenario): Promise<void> {
    const actors = await writeGroupDeltaClusterFixture(scenario.plans);
    const context: LocalWsContext = {
        dependencies: createDefaultExecutionDependencies(),
        wsConnections: {},
        wsMessages: {},
        wsCloseEvents: {}
    };
    try {
        await openGroupDeltaSocket(actors, actors.recipient, context);
        await openGroupDeltaSocket(actors, actors.outsider, context);
        const evidence = await writeGroupDeltaAndAssertDelivery(actors, context, scenario);
        await Deno.writeTextFile(
            `${scenario.artifactDir}/group-delta-cluster-proof.json`,
            JSON.stringify(evidence, null, 2)
        );
    }
    finally {
        for (const connection of Object.keys(context.wsConnections)) {
            const interaction = { request: { connection, code: 1000, reason: 'proof-complete' } };
            await closeWs(interaction, { interaction }, context);
        }
    }
}

async function writeGroupDeltaAndAssertDelivery(
    actors: GroupDeltaClusterActors,
    context: LocalWsContext,
    scenario: GroupDeltaClusterScenario
): Promise<GroupDeltaClusterEvidence> {
    const revision = await actors.api.updateDescription({ ...actors.group, actor: actors.recipient, phase: 'live-a' });
    const requestId = `${actors.group.proofId}-live-a-description`;
    const { applicationId, workspaceId, groupId } = actors.group;
    const expected = {
        route: { topicId: 'group-state.event' },
        targets: { groupRef: { applicationId, workspaceId, groupId } },
        payload: {
            resource: {
                event: { requestId },
                resultingCausalRevision: revision,
                audienceSessionIds: [actors.recipient.sessionId]
            }
        }
    };
    const interaction: WsInteraction = {
        request: { connection: actors.recipient.label },
        response: { withinMs: 10_000, decodeJsonPaths: ['payload.resource'], message: expected }
    };
    const delivery = await waitForWsMessage({ interaction, config: { interaction }, context });
    assertEquals(delivery.status, 'SUCCESS', 'Process B must receive the exact delta caused by the mutation on A');
    const proof = await readGroupDeltaProof(scenario.databaseUrl, requestId);
    assertEquals(proof.target, {
        kind: 'scoped-room-broadcast',
        groupRef: { applicationId, workspaceId, groupId },
        admittedAudience: [actors.recipient.sessionId]
    });
    const received = context.wsMessages[actors.recipient.label]!.map((frame) => decodeALMessageValue(frame.data))
        .find((message) => message.right?.id.msgId === proof.messageId)?.right;
    assertEquals(received?.id.msgId, proof.messageId, 'The received frame must be the committed proved row');
    const excluded: WsInteraction = {
        request: { connection: actors.outsider.label },
        response: { withinMs: 500, decodeJsonPaths: ['payload.resource'], absent: expected }
    };
    assertEquals(
        (await waitForWsMessageAbsence({ interaction: excluded, config: { interaction: excluded }, context })).status,
        'SUCCESS'
    );
    return {
        producer: 'A',
        receiver: 'B',
        outsider: 'C',
        queueWorkers: scenario.plans.map((plan) => plan.env.RALLAR_API_QUEUE_WORKERS!),
        requestId,
        messageId: proof.messageId,
        target: proof.target,
        ports: scenario.plans.map((plan) => plan.port)
    };
}

async function openGroupDeltaSocket(
    actors: GroupDeltaClusterActors,
    session: ProofSession,
    context: LocalWsContext
): Promise<void> {
    const ticket = await actors.api.issueWebSocketTicket(session);
    const scope = { applicationId: actors.group.applicationId, workspaceId: actors.group.workspaceId };
    const query = new URLSearchParams({ ticket, ...scope });
    const interaction: WsInteraction = {
        request: {
            connection: session.label,
            url: `${session.wsBaseUrl}/api/ws/${session.sessionId}?${query}`,
            snapshotScope: scope
        }
    };
    assertEquals(
        (await openWs(interaction, { interaction }, context)).status,
        'SUCCESS',
        `${session.label} authenticated socket`
    );
}

async function readGroupDeltaProof(databaseUrl: string, requestId: string): Promise<WsOutboxProvenance> {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
        const rows = await sql<GroupDeltaProofRow[]>`
            select proof.store_value as proof
            from resource_inbox outbox join runtime_state_store proof
              on proof.store_namespace = 'ws-outbox-provenance'
              and proof.store_value::jsonb->>'messageId' = outbox.ri_resource::jsonb->'id'->>'msgId'
            where outbox.ri_type_id = 'WS_OUTBOX'
              and outbox.ri_resource::jsonb->'route'->>'topicId' = 'group-state.event'
              and (outbox.ri_resource::jsonb->'payload'->>'resource')::jsonb->'event'->>'requestId' = ${requestId}
        `;
        assertEquals(rows.length, 1, 'Exactly one committed delta row and matching sidecar');
        return decodeWsOutboxProvenance(JSON.parse(rows[0]!.proof));
    }
    finally {
        await sql.end();
    }
}

if (import.meta.main) {
    await runGroupDeltaClusterProof();
    console.log('PASS: real group delta produced on A reached its frozen authenticated session only on B.');
}
