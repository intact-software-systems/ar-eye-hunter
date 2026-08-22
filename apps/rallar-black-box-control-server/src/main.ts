import { assertBlackBoxControlProductionEnv } from '@shared-server/http/black-box-control-production-env.ts';
import { verifyRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';
import {
    parseControlClientMessage,
    validateRallarBlackBoxTestCommand,
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlEventEnvelope,
    type ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import {
    validateDistributedRunManifestContract,
    type RallarBlackBoxDistributedRunManifest
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    validateJsonSchema
} from '@shared-test/rallar-bb-test/schema.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestCommandKind } from '@shared-test/rallar-bb-test/types.ts';
import {
    controlEventArtifactJsonl,
    controlResultArtifactJsonl,
    controlResultEventArtifactJsonl,
    controlRunArtifactContentType,
    controlRunArtifactFileNameFromValue,
    controlRunEventsJsonl,
    controlRunFailureBundle,
    controlRunResultsJsonl,
    createControlRunArtifactBundle
} from './control-artifacts.ts';
import { fleetReportFilterFromUrl } from './control-fleet.ts';
import type {
    ControlQueuedCommandSnapshot,
    ControlRunSnapshotBounds,
    ControlServerSnapshot,
    EnqueueControlCommandInput
} from './control-service.ts';
import { createRallarBlackBoxControlService } from './control-service.ts';
import { applyControlCorsHeaders, corsOriginsFromAllowedOrigins, createControlResponseHeaders } from './cors.ts';
import { handleRetentionCleanup } from './retention-cleanup.ts';
import { createRetentionPlanTokenAdapter } from './retention-plan-token.ts';
import { handleSwaggerRoute, swaggerFallbackResponse } from './routes/swagger-routes.ts';

const DEFAULT_PORT = 5180;
const OPEN_STATE = 1;
const SNAPSHOT_PERSIST_DEBOUNCE_MS = 100;
const ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS: ControlRunSnapshotBounds = {
    commands: 200,
    results: 200,
    events: 200,
    stats: 100,
    reports: 20,
    heartbeats: 100
};

type SecurityOptions = Readonly<{
    allowedOrigins: readonly string[];
    requireTls: boolean;
    requireRunToken: boolean;
    requireReadToken: boolean;
    adminToken?: string;
    operatorTokenSecret?: string;
    runTokenTtlMs: number;
    maxRequestBytes: number;
    allowedCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
    commandRateLimitMax: number;
    commandRateLimitWindowMs: number;
    httpAllowedHosts: readonly string[];
    httpAllowedOrigins: readonly string[];
    wsAllowedHosts: readonly string[];
    wsAllowedOrigins: readonly string[];
    storageDir?: string;
    retentionMaxRuns: number;
    snapshotPersistenceBounds: ControlRunSnapshotBounds;
    runtimeRetentionBounds: ControlRunSnapshotBounds;
}>;

assertBlackBoxControlProductionEnv(Deno.env);

const security = resolveSecurityOptions();
const controlService = createRallarBlackBoxControlService({
    allowedCommandKinds: security.allowedCommandKinds,
    commandRateLimitMax: security.commandRateLimitMax,
    commandRateLimitWindowMs: security.commandRateLimitWindowMs,
    runTokenTtlMs: security.runTokenTtlMs,
    runtimeRetentionBounds: security.runtimeRetentionBounds
});
const artifactRecorder = createArtifactRecorder(security.storageDir, {
    commandSnapshot: (runId, commandId) => controlService.snapshotCommand(runId, commandId)
});
const agentSockets = new Map<string, WebSocket>();
const socketAgents = new WeakMap<WebSocket, { runId: string; agentId: string; }>();
const retentionPlanTokens = createRetentionPlanTokenAdapter({
    key: crypto.getRandomValues(new Uint8Array(32))
});
let snapshotPersistSequence = 0;
let snapshotPersistScheduled = false;
let snapshotPersisting = false;
let snapshotPersistDirty = false;

const port = Number(Deno.env.get('PORT') ?? DEFAULT_PORT);
const corsOrigins = corsOriginsFromAllowedOrigins(security.allowedOrigins);

await restorePersistedSnapshot();

Deno.serve({ port }, async (request) => {
    return applyControlCorsHeaders(request, await handleRequest(request), corsOrigins);
});

console.log(`Rallar black-box control server listening on http://localhost:${port}`);
console.log(`Agent WebSocket endpoint: ws://localhost:${port}/control`);

async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const policyRejection = rejectByRequestPolicy(request, url);
    if (policyRejection) {
        return policyRejection;
    }

    if (request.method === 'OPTIONS') {
        return emptyResponse(204);
    }

    const swaggerResponse = handleSwaggerRoute(request, url, { corsOrigins });
    if (swaggerResponse) {
        return swaggerResponse;
    }

    if (url.pathname === '/control') {
        return handleControlSocket(request);
    }

    if (isRead && url.pathname === '/health') {
        return jsonResponse({
            ok: true,
            app: 'rallar-black-box-control-server',
            protocolVersion: 1
        });
    }

    if (
        isRead &&
        isProtectedControlReadPath(url.pathname) &&
        !(await authorizeReadRequest(request, url))
    ) {
        return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
    }

    if (isRead && url.pathname === '/distributed-runs') {
        return jsonResponse({
            distributedRuns: controlService.listDistributedRuns()
        });
    }

    if (isRead && url.pathname === '/fleet/reports') {
        return jsonResponse(controlService.listFleetReports(fleetReportFilterFromUrl(url)));
    }

    if (request.method === 'POST' && url.pathname === '/fleet/reports/rebuild') {
        if (!(await authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        const response = controlService.rebuildFleetReports();
        persistControlSnapshot();
        return jsonResponse(response);
    }

    const fleetReportMatch = url.pathname.match(/^\/fleet\/reports\/([^/]+)$/);
    if (isRead && fleetReportMatch) {
        const distributedRunId = decodeURIComponent(fleetReportMatch[1]);
        const report = controlService.snapshotFleetReport(distributedRunId);
        return report ? jsonResponse(report) : jsonResponse({ error: 'Fleet report not found.' }, 404);
    }

    const fleetReportArtifactMatch = url.pathname.match(/^\/fleet\/reports\/([^/]+)\/artifacts$/);
    if (isRead && fleetReportArtifactMatch) {
        const distributedRunId = decodeURIComponent(fleetReportArtifactMatch[1]);
        const bundle = controlService.fleetReportBundle(distributedRunId);
        return bundle ? jsonResponse(bundle) : jsonResponse({ error: 'Fleet report not found.' }, 404);
    }

    if (request.method === 'POST' && url.pathname === '/distributed-runs') {
        if (!(await authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        return await createDistributedRun(request);
    }

    if (request.method === 'POST' && url.pathname === '/distributed-runs/resolve-targets') {
        if (!(await authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        return await resolveDistributedTargets(request);
    }

    const distributedRunMatch = url.pathname.match(/^\/distributed-runs\/([^/]+)$/);
    if (isRead && distributedRunMatch) {
        const distributedRunId = decodeURIComponent(distributedRunMatch[1]);
        const distributedRun = controlService.snapshotDistributedRun(distributedRunId);
        return distributedRun
            ? jsonResponse(distributedRun)
            : jsonResponse({ error: 'Distributed run not found.' }, 404);
    }

    const distributedRunActionMatch = url.pathname.match(
        /^\/distributed-runs\/([^/]+)\/(stage|start|cancel)$/
    );
    if (request.method === 'POST' && distributedRunActionMatch) {
        if (!(await authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        return await mutateDistributedRun(
            request,
            decodeURIComponent(distributedRunActionMatch[1]),
            distributedRunActionMatch[2] as 'stage' | 'start' | 'cancel'
        );
    }

    const distributedRunArtifactsMatch = url.pathname.match(
        /^\/distributed-runs\/([^/]+)\/artifacts$/
    );
    if (isRead && distributedRunArtifactsMatch) {
        const distributedRunId = decodeURIComponent(distributedRunArtifactsMatch[1]);
        const bundle = controlService.distributedRunArtifactBundle(
            distributedRunId,
            ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS
        );
        return bundle
            ? jsonResponse(bundle)
            : jsonResponse({ error: 'Distributed run not found.' }, 404);
    }

    if (isRead && url.pathname === '/runs') {
        return jsonResponse(controlService.snapshot(snapshotBoundsFromUrl(url)));
    }

    if (request.method === 'POST' && url.pathname === '/retention/cleanup') {
        const cleanup = await handleRetentionCleanup({
            url,
            maxRuns: security.retentionMaxRuns,
            authorize: () => authorizeAdminRequest(request, url),
            service: {
                createRetentionPlan: (maxRuns) => controlService.createRetentionPlan(maxRuns),
                applyRetentionPlan: (plan) => controlService.applyRetentionPlan(plan),
                pruneRuns: (maxRuns) => controlService.pruneRuns(maxRuns),
                legacyRetainedRuns: () => controlService.snapshot().runs.length
            },
            tokens: retentionPlanTokens,
            persist: persistControlSnapshot
        });
        return jsonResponse(cleanup.body, cleanup.status);
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (isRead && runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const run = controlService.snapshotRun(runId, snapshotBoundsFromUrl(url));
        return run ? jsonResponse(run) : jsonResponse({ error: 'Run not found.' }, 404);
    }

    if (request.method === 'DELETE' && runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        if (!(await authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        closeRunSockets(runId);
        const deleted = controlService.deleteRun(runId);
        if (deleted) {
            artifactRecorder.deleteRun(runId);
        }
        persistControlSnapshot();
        return deleted
            ? jsonResponse({ deleted: true, runId })
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const runResetMatch = url.pathname.match(/^\/runs\/([^/]+)\/reset$/);
    if (request.method === 'POST' && runResetMatch) {
        const runId = decodeURIComponent(runResetMatch[1]);
        if (!(await authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        const run = controlService.resetRun(runId);
        if (run) {
            artifactRecorder.deleteRun(runId);
        }
        persistControlSnapshot();
        return run
            ? jsonResponse({ reset: true, run })
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const runCommandsMatch = url.pathname.match(/^\/runs\/([^/]+)\/commands$/);
    if (request.method === 'POST' && runCommandsMatch) {
        const runId = decodeURIComponent(runCommandsMatch[1]);
        if (!(await authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        return await enqueueBulkCommand(request, runId);
    }

    const runArtifactsMatch = url.pathname.match(/^\/runs\/([^/]+)\/artifacts$/);
    if (isRead && runArtifactsMatch) {
        const runId = decodeURIComponent(runArtifactsMatch[1]);
        const run = controlService.snapshotRun(runId, ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS);
        return run
            ? jsonResponse(createControlRunArtifactBundle(run))
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const runArtifactFileMatch = url.pathname.match(/^\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
    if (isRead && runArtifactFileMatch) {
        const runId = decodeURIComponent(runArtifactFileMatch[1]);
        const fileName = controlRunArtifactFileNameFromValue(
            decodeURIComponent(runArtifactFileMatch[2])
        );
        if (!fileName) {
            return jsonResponse({ error: 'Artifact file not found.' }, 404);
        }
        const run = controlService.snapshotRun(runId, ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS);
        if (!run) {
            return jsonResponse({ error: 'Run not found.' }, 404);
        }
        if (fileName === 'events.jsonl' || fileName === 'results.jsonl') {
            return await artifactJsonlResponse(
                runId,
                fileName === 'events.jsonl' ? 'events' : 'results',
                run
            );
        }
        const bundle = createControlRunArtifactBundle(run);
        return textResponse(bundle.files[fileName], 200, controlRunArtifactContentType(fileName));
    }

    const runEventsJsonlMatch = url.pathname.match(/^\/runs\/([^/]+)\/events\.jsonl$/);
    if (isRead && runEventsJsonlMatch) {
        const runId = decodeURIComponent(runEventsJsonlMatch[1]);
        const run = controlService.snapshotRun(runId, ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS);
        return run
            ? await artifactJsonlResponse(runId, 'events', run)
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const runResultsJsonlMatch = url.pathname.match(/^\/runs\/([^/]+)\/results\.jsonl$/);
    if (isRead && runResultsJsonlMatch) {
        const runId = decodeURIComponent(runResultsJsonlMatch[1]);
        const run = controlService.snapshotRun(runId, ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS);
        return run
            ? await artifactJsonlResponse(runId, 'results', run)
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const runFailureBundleMatch = url.pathname.match(/^\/runs\/([^/]+)\/failure-bundle$/);
    if (isRead && runFailureBundleMatch) {
        const runId = decodeURIComponent(runFailureBundleMatch[1]);
        const run = controlService.snapshotRun(runId, ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS);
        return run
            ? jsonResponse(controlRunFailureBundle(run))
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const agentCommandMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/commands$/);
    if (request.method === 'POST' && agentCommandMatch) {
        const runId = decodeURIComponent(agentCommandMatch[1]);
        const agentId = decodeURIComponent(agentCommandMatch[2]);
        if (!authorizeRunRequest(request, url, runId, agentId)) {
            return jsonResponse({ error: 'Run token is required or invalid.' }, 401);
        }
        return await enqueueCommand(request, runId, agentId);
    }

    const agentReportMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/report$/);
    if (request.method === 'POST' && agentReportMatch) {
        const runId = decodeURIComponent(agentReportMatch[1]);
        const agentId = decodeURIComponent(agentReportMatch[2]);
        if (!authorizeRunRequest(request, url, runId, agentId)) {
            return jsonResponse({ error: 'Run token is required or invalid.' }, 401);
        }
        return await uploadReport(request, runId, agentId);
    }

    const agentTokenMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/tokens$/);
    if (request.method === 'POST' && agentTokenMatch) {
        const runId = decodeURIComponent(agentTokenMatch[1]);
        const agentId = decodeURIComponent(agentTokenMatch[2]);
        if (!(await authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        return await issueRunToken(request, runId, agentId);
    }

    return isRead
        ? swaggerFallbackResponse(request, { corsOrigins })
        : jsonResponse({ error: 'Not found.' }, 404);
}

function handleControlSocket(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return jsonResponse({ error: 'Expected WebSocket upgrade.' }, 426);
    }

    const url = new URL(request.url);
    const socketToken = tokenFromRequest(request, url);
    const { socket, response } = Deno.upgradeWebSocket(request);

    socket.onmessage = (event) => {
        void handleControlSocketMessage(socket, socketToken, event.data);
    };

    socket.onclose = () => {
        const agent = socketAgents.get(socket);
        if (!agent) {
            return;
        }

        const key = agentKey(agent.runId, agent.agentId);
        if (agentSockets.get(key) === socket) {
            agentSockets.delete(key);
            controlService.markAgentDisconnected(agent.runId, agent.agentId);
            persistControlSnapshot();
        }
    };

    return response;
}

async function handleControlSocketMessage(
    socket: WebSocket,
    socketToken: string | undefined,
    data: unknown
): Promise<void> {
    let message: unknown;
    try {
        message = await controlSocketMessageData(data);
    }
    catch (error) {
        if (error instanceof PayloadTooLargeError) {
            socket.close(1009, error.message);
            return;
        }
        socket.close(1003, errorMessage(error));
        return;
    }

    const parsed = parseControlClientMessage(message);
    if (!parsed.ok) {
        socket.close(1003, parsed.error);
        return;
    }

    if (
        parsed.envelope.kind === 'register' &&
        !authorizeRunToken(
            parsed.envelope.runId,
            parsed.envelope.agentId,
            parsed.envelope.token ?? socketToken
        )
    ) {
        socket.close(1008, 'Run token is required or invalid.');
        return;
    }

    if (parsed.envelope.kind !== 'report') {
        artifactRecorder.record(parsed.envelope);
    }
    const received = controlService.receiveClientEnvelope(parsed.envelope);
    if (parsed.envelope.kind === 'report' && received.accepted) {
        artifactRecorder.record(parsed.envelope);
    }
    if (received.kind === 'register') {
        registerSocket(socket, received.runId, received.agentId);
    }
    sendDispatchableCommandsForRun(received.runId);
    persistControlSnapshot();
}

async function controlSocketMessageData(data: unknown): Promise<unknown> {
    if (typeof data === 'string') {
        assertPayloadByteLength(new TextEncoder().encode(data).byteLength);
        return data;
    }
    if (data instanceof ArrayBuffer) {
        assertPayloadByteLength(data.byteLength);
        return new TextDecoder().decode(data);
    }
    if (data instanceof Blob) {
        assertPayloadByteLength(data.size);
        return await data.text();
    }
    return data;
}

async function createDistributedRun(request: Request): Promise<Response> {
    let manifest: RallarBlackBoxDistributedRunManifest;
    try {
        manifest = await readDistributedRunManifest(request);
    }
    catch (error) {
        return jsonErrorResponse(error);
    }

    try {
        const distributedRun = controlService.createDistributedRun(manifest);
        persistControlSnapshot();
        return jsonResponse(distributedRun, 201);
    }
    catch (error) {
        return distributedRunErrorResponse(error);
    }
}

async function resolveDistributedTargets(request: Request): Promise<Response> {
    let manifest: RallarBlackBoxDistributedRunManifest;
    try {
        manifest = await readDistributedRunManifest(request);
    }
    catch (error) {
        return jsonErrorResponse(error);
    }

    try {
        return jsonResponse(controlService.resolveDistributedRunTargets(manifest));
    }
    catch (error) {
        return distributedRunErrorResponse(error);
    }
}

async function mutateDistributedRun(
    request: Request,
    distributedRunId: string,
    action: 'stage' | 'start' | 'cancel'
): Promise<Response> {
    let reason: string | undefined;
    if (action === 'cancel') {
        try {
            const body = await readJsonBody(request, true);
            if (isRecord(body) && typeof body.reason === 'string' && body.reason.trim().length > 0) {
                reason = body.reason.trim();
            }
        }
        catch (error) {
            return jsonErrorResponse(error);
        }
    }

    try {
        const distributedRun = action === 'stage'
            ? controlService.stageDistributedRun(distributedRunId)
            : action === 'start'
            ? controlService.startDistributedRun(distributedRunId)
            : controlService.cancelDistributedRun(distributedRunId, reason);
        distributedRun.targetAgentIds.forEach((agentId) =>
            sendDispatchableCommands(distributedRun.controlRunId, agentId)
        );
        persistControlSnapshot();
        return jsonResponse(distributedRun, 202);
    }
    catch (error) {
        return distributedRunErrorResponse(error);
    }
}

async function readDistributedRunManifest(
    request: Request
): Promise<RallarBlackBoxDistributedRunManifest> {
    const body = await readJsonBody(request);
    const manifest = isRecord(body) && 'manifest' in body ? body.manifest : body;

    const schemaValidation = validateJsonSchema(
        RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
        manifest
    );
    if (!schemaValidation.ok) {
        throw new Error(formatJsonSchemaValidationErrors(schemaValidation.errors));
    }

    const contractValidation = validateDistributedRunManifestContract(
        manifest as RallarBlackBoxDistributedRunManifest
    );
    if (!contractValidation.ok) {
        throw new Error(
            contractValidation.errors
                .map((error) => `${error.path}: ${error.message}`)
                .join('\n')
        );
    }

    return manifest as RallarBlackBoxDistributedRunManifest;
}

function distributedRunErrorResponse(error: unknown): Response {
    const message = errorMessage(error);
    const status = message.includes('not found')
        ? 404
        : message.includes('terminal state')
        ? 409
        : message.includes('rate limit')
        ? 429
        : 400;
    return jsonResponse({ error: message }, status);
}

async function enqueueCommand(
    request: Request,
    runId: string,
    agentId: string
): Promise<Response> {
    let body: Omit<EnqueueControlCommandInput, 'runId' | 'agentId'>;
    try {
        body = await readJsonBody(request) as Omit<EnqueueControlCommandInput, 'runId' | 'agentId'>;
    }
    catch (error) {
        return jsonErrorResponse(error);
    }

    if (!body || typeof body !== 'object' || !('command' in body)) {
        return jsonResponse({ error: 'Command request requires command.' }, 400);
    }

    const validation = validateRallarBlackBoxTestCommand(body.command);
    if (!validation.ok) {
        return jsonResponse({ error: validation.error }, 400);
    }

    const destinationError = validateBrowserCommandDestination(body.command);
    if (destinationError) {
        return jsonResponse({ error: destinationError }, 403);
    }

    let envelope: ControlCommandEnvelope;
    try {
        envelope = controlService.enqueueCommand({
            runId,
            agentId,
            commandId: body.commandId,
            command: body.command,
            deadlineEpochMs: body.deadlineEpochMs
        });
    }
    catch (error) {
        return jsonResponse({
            error: error instanceof Error ? error.message : String(error)
        }, error instanceof Error && error.message.includes('rate limit') ? 429 : 400);
    }
    sendDispatchableCommands(runId, agentId);
    persistControlSnapshot();
    return jsonResponse({
        accepted: true,
        command: envelope
    }, 202);
}

async function enqueueBulkCommand(
    request: Request,
    runId: string
): Promise<Response> {
    let body: unknown;
    try {
        body = await readJsonBody(request);
    }
    catch (error) {
        return jsonErrorResponse(error);
    }

    if (!body || typeof body !== 'object' || !('command' in body)) {
        return jsonResponse({ error: 'Bulk command request requires command.' }, 400);
    }

    const record = body as {
        agentIds?: unknown;
        command?: unknown;
        commandId?: unknown;
        commandIdPrefix?: unknown;
        deadlineEpochMs?: unknown;
    };
    const agentIds = Array.isArray(record.agentIds)
        ? record.agentIds
            .map((agentId) => typeof agentId === 'string' ? agentId.trim() : '')
            .filter((agentId) => agentId.length > 0)
        : [];
    if (agentIds.length === 0) {
        return jsonResponse({ error: 'Bulk command request requires agentIds.' }, 400);
    }

    const validation = validateRallarBlackBoxTestCommand(record.command);
    if (!validation.ok) {
        return jsonResponse({ error: validation.error }, 400);
    }

    const commandTemplate = record.command as RallarBlackBoxTestCommand;
    const destinationError = validateBrowserCommandDestination(commandTemplate);
    if (destinationError) {
        return jsonResponse({ error: destinationError }, 403);
    }

    const baseCommandId = typeof record.commandId === 'string' && record.commandId.trim().length > 0
        ? record.commandId.trim()
        : typeof record.commandIdPrefix === 'string' && record.commandIdPrefix.trim().length > 0
        ? record.commandIdPrefix.trim()
        : typeof commandTemplate.commandId === 'string' && commandTemplate.commandId.trim().length > 0
        ? commandTemplate.commandId.trim()
        : undefined;
    const deadlineEpochMs = typeof record.deadlineEpochMs === 'number'
        ? record.deadlineEpochMs
        : undefined;
    const commands: ControlCommandEnvelope[] = [];

    try {
        agentIds.forEach((agentId, index) => {
            const commandId = baseCommandId
                ? agentIds.length === 1 && typeof record.commandId === 'string'
                    ? baseCommandId
                    : `${baseCommandId}-${safeCommandIdSegment(agentId)}`
                : undefined;
            const command: RallarBlackBoxTestCommand = commandId
                ? {
                    ...commandTemplate,
                    commandId
                } as RallarBlackBoxTestCommand
                : commandTemplate;
            const envelope = controlService.enqueueCommand({
                runId,
                agentId,
                commandId: commandId ?? `bulk-${Date.now()}-${index + 1}`,
                command,
                deadlineEpochMs
            });
            commands.push(envelope);
        });
    }
    catch (error) {
        return jsonResponse({
            error: error instanceof Error ? error.message : String(error)
        }, error instanceof Error && error.message.includes('rate limit') ? 429 : 400);
    }

    agentIds.forEach((agentId) => sendDispatchableCommands(runId, agentId));
    persistControlSnapshot();
    return jsonResponse({
        accepted: true,
        commands
    }, 202);
}

async function uploadReport(
    request: Request,
    runId: string,
    agentId: string
): Promise<Response> {
    let body: unknown;
    try {
        body = await readJsonBody(request);
    }
    catch (error) {
        return jsonErrorResponse(error);
    }

    const parsed = parseControlClientMessage(body);
    if (!parsed.ok) {
        return jsonResponse({
            error: parsed.error
        }, 400);
    }

    if (
        parsed.envelope.kind !== 'report' ||
        parsed.envelope.runId !== runId ||
        parsed.envelope.agentId !== agentId
    ) {
        return jsonResponse({
            error: 'Report upload envelope does not match the target run and agent.'
        }, 400);
    }

    const received = controlService.receiveClientEnvelope(parsed.envelope);
    if (received.accepted) {
        artifactRecorder.record(parsed.envelope);
    }
    persistControlSnapshot();
    return jsonResponse({
        accepted: true
    }, 202);
}

async function issueRunToken(
    request: Request,
    runId: string,
    agentId: string
): Promise<Response> {
    let body: unknown = {};
    try {
        body = await readJsonBody(request, true);
    }
    catch (error) {
        return jsonErrorResponse(error);
    }

    const ttlMs = body && typeof body === 'object' && 'ttlMs' in body
        ? Number.parseInt(String((body as { ttlMs?: unknown; }).ttlMs), 10)
        : undefined;
    const effectiveTtlMs = ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs > 0
        ? ttlMs
        : security.runTokenTtlMs;
    const token = controlService.issueRunToken({
        runId,
        agentId,
        ttlMs: effectiveTtlMs
    });

    persistControlSnapshot();
    return jsonResponse(token, 201);
}

function resolveSecurityOptions(): SecurityOptions {
    const allowedCommandKinds = envList('RALLAR_BLACK_BOX_ALLOWED_COMMANDS');
    return {
        allowedOrigins: envList('RALLAR_BLACK_BOX_ALLOWED_ORIGINS'),
        requireTls: envBoolean('RALLAR_BLACK_BOX_REQUIRE_TLS'),
        requireRunToken: envBoolean('RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN'),
        requireReadToken: envBoolean('RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN'),
        adminToken: envString('RALLAR_BLACK_BOX_ADMIN_TOKEN'),
        operatorTokenSecret: envString('RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET'),
        runTokenTtlMs: envNumber('RALLAR_BLACK_BOX_RUN_TOKEN_TTL_MS', 15 * 60_000),
        maxRequestBytes: envNumber('RALLAR_BLACK_BOX_MAX_REQUEST_BYTES', 2_000_000),
        allowedCommandKinds: allowedCommandKinds.length > 0
            ? allowedCommandKinds as RallarBlackBoxTestCommandKind[]
            : undefined,
        commandRateLimitMax: envNumber('RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_MAX', 120),
        commandRateLimitWindowMs: envNumber('RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_WINDOW_MS', 60_000),
        httpAllowedHosts: envList('RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS'),
        httpAllowedOrigins: envList('RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS'),
        wsAllowedHosts: envList('RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS'),
        wsAllowedOrigins: envList('RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS'),
        storageDir: envString('RALLAR_BLACK_BOX_STORAGE_DIR'),
        retentionMaxRuns: envNumber('RALLAR_BLACK_BOX_RETENTION_MAX_RUNS', 0),
        snapshotPersistenceBounds: {
            commands: envSnapshotLimit('RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_COMMANDS', 500),
            results: envSnapshotLimit('RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_RESULTS', 500),
            events: envSnapshotLimit('RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_EVENTS', 1_000),
            stats: envSnapshotLimit('RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_STATS', 200),
            reports: envSnapshotLimit('RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_REPORTS', 100),
            heartbeats: envSnapshotLimit('RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_HEARTBEATS', 100)
        },
        runtimeRetentionBounds: {
            commands: envSnapshotLimit('RALLAR_BLACK_BOX_RUNTIME_RETAIN_COMMANDS', 1_000),
            results: envSnapshotLimit('RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS', 1_000),
            events: envSnapshotLimit('RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS', 2_000),
            stats: envSnapshotLimit('RALLAR_BLACK_BOX_RUNTIME_RETAIN_STATS', 500),
            reports: envSnapshotLimit('RALLAR_BLACK_BOX_RUNTIME_RETAIN_REPORTS', 20),
            heartbeats: envSnapshotLimit('RALLAR_BLACK_BOX_RUNTIME_RETAIN_HEARTBEATS', 500)
        }
    };
}

function envString(key: string): string | undefined {
    const value = Deno.env.get(key)?.trim();
    return value && value.length > 0 ? value : undefined;
}

function envList(key: string): string[] {
    return (Deno.env.get(key) ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

function envNumber(key: string, fallback: number): number {
    const parsed = Number.parseInt(Deno.env.get(key) ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envBoolean(key: string): boolean {
    const normalized = (Deno.env.get(key) ?? '').trim().toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}

function envSnapshotLimit(key: string, fallback: number): number | undefined {
    const normalized = (Deno.env.get(key) ?? '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }
    if (normalized === 'all' || normalized === 'unbounded' || normalized === 'none') {
        return undefined;
    }

    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function rejectByRequestPolicy(request: Request, url: URL): Response | undefined {
    if (
        security.requireTls &&
        url.protocol !== 'https:' &&
        request.headers.get('x-forwarded-proto') !== 'https'
    ) {
        return jsonResponse({ error: 'TLS is required.' }, 400);
    }

    const origin = request.headers.get('origin');
    if (
        origin &&
        security.allowedOrigins.length > 0 &&
        !security.allowedOrigins.includes(origin)
    ) {
        return jsonResponse({ error: 'Origin is not allowed.' }, 403);
    }

    return undefined;
}

function isProtectedControlReadPath(pathname: string): boolean {
    return pathname === '/runs' ||
        pathname.startsWith('/runs/') ||
        pathname === '/distributed-runs' ||
        pathname.startsWith('/distributed-runs/') ||
        pathname === '/fleet/reports' ||
        pathname.startsWith('/fleet/reports/');
}

async function authorizeReadRequest(request: Request, url: URL): Promise<boolean> {
    if (!security.requireReadToken) {
        return true;
    }

    if (!hasAdminAuthorizationBackend()) {
        return false;
    }

    return await authorizeAdminRequest(request, url);
}

function hasAdminAuthorizationBackend(): boolean {
    return Boolean(security.adminToken || security.operatorTokenSecret);
}

async function authorizeAdminRequest(request: Request, url: URL): Promise<boolean> {
    if (!security.adminToken && !security.operatorTokenSecret) {
        return true;
    }

    const token = tokenFromRequest(request, url);
    if (security.adminToken && token === security.adminToken) {
        return true;
    }

    if (!security.operatorTokenSecret) {
        return false;
    }

    const verified = await verifyRallarBlackBoxOperatorToken({
        token,
        secret: security.operatorTokenSecret
    });
    return verified.ok;
}

function authorizeRunRequest(
    request: Request,
    url: URL,
    runId: string,
    agentId: string
): boolean {
    return authorizeRunToken(runId, agentId, tokenFromRequest(request, url));
}

function authorizeRunToken(runId: string, agentId: string, token: string | undefined): boolean {
    const tokenRequired = security.requireRunToken ||
        controlService.hasActiveRunToken(runId, agentId);
    if (!tokenRequired) {
        return true;
    }

    return controlService.validateRunToken(runId, agentId, token);
}

function tokenFromRequest(request: Request, url: URL): string | undefined {
    const authorization = request.headers.get('authorization');
    if (authorization?.toLowerCase().startsWith('bearer ')) {
        return authorization.slice('bearer '.length).trim();
    }

    return request.headers.get('x-rallar-run-token')?.trim() ||
        url.searchParams.get('token')?.trim() ||
        undefined;
}

async function readJsonBody(request: Request, allowEmpty = false): Promise<unknown> {
    const text = await readTextBody(request);
    if (text.length === 0 && allowEmpty) {
        return {};
    }

    return JSON.parse(text);
}

async function readTextBody(request: Request): Promise<string> {
    const declaredLength = request.headers.get('content-length');
    if (declaredLength) {
        const parsed = Number.parseInt(declaredLength, 10);
        if (Number.isFinite(parsed)) {
            assertPayloadByteLength(parsed);
        }
    }

    const reader = request.body?.getReader();
    if (!reader) {
        return '';
    }

    const decoder = new TextDecoder();
    let byteLength = 0;
    let text = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        byteLength += value.byteLength;
        assertPayloadByteLength(byteLength);
        text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
}

function assertPayloadByteLength(byteLength: number): void {
    if (byteLength > security.maxRequestBytes) {
        throw new PayloadTooLargeError(
            `Request payload is too large: ${byteLength} bytes exceeds ${security.maxRequestBytes} bytes.`
        );
    }
}

function validateBrowserCommandDestination(command: RallarBlackBoxTestCommand): string | undefined {
    if (command.kind === 'http.request') {
        return validateDestination(
            command.request.url ?? command.request.path,
            security.httpAllowedOrigins,
            security.httpAllowedHosts,
            'HTTP'
        );
    }

    if (command.kind === 'ws.open') {
        return validateDestination(
            command.url,
            security.wsAllowedOrigins,
            security.wsAllowedHosts,
            'WebSocket'
        );
    }

    return undefined;
}

function validateDestination(
    value: string | undefined,
    allowedOrigins: readonly string[],
    allowedHosts: readonly string[],
    label: string
): string | undefined {
    if (!value || (allowedOrigins.length === 0 && allowedHosts.length === 0)) {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(value);
    }
    catch (_error) {
        return undefined;
    }

    if (allowedOrigins.includes(parsed.origin)) {
        return undefined;
    }

    if (allowedHosts.some((allowedHost) => hostMatches(parsed.host, parsed.hostname, allowedHost))) {
        return undefined;
    }

    return `${label} destination is not allowed: ${parsed.origin}`;
}

function hostMatches(host: string, hostname: string, allowedHost: string): boolean {
    if (allowedHost === host || allowedHost === hostname) {
        return true;
    }
    if (!allowedHost.startsWith('*.')) {
        return false;
    }

    const suffix = allowedHost.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

function registerSocket(socket: WebSocket, runId: string, agentId: string): void {
    const key = agentKey(runId, agentId);
    const existing = agentSockets.get(key);
    if (existing && existing !== socket) {
        controlService.recordDuplicateAgentSocketReplacement(runId, agentId);
        existing.close(4000, 'agent re-registered');
    }

    socketAgents.set(socket, { runId, agentId });
    agentSockets.set(key, socket);
}

function closeRunSockets(runId: string): void {
    const prefix = `${runId}\u0000`;
    for (const [key, socket] of agentSockets.entries()) {
        if (!key.startsWith(prefix)) {
            continue;
        }

        agentSockets.delete(key);
        try {
            socket.close(1000, 'run deleted');
        }
        catch (_error) {
            // Socket cleanup is best-effort when a run is removed.
        }
    }
}

function sendDispatchableCommands(runId: string, agentId: string): void {
    const socket = agentSockets.get(agentKey(runId, agentId));
    if (!socket || socket.readyState !== OPEN_STATE) {
        return;
    }

    const commands = controlService.takeDispatchableCommands(runId, agentId);
    for (const command of commands) {
        sendCommand(socket, command);
    }
}

function sendDispatchableCommandsForRun(runId: string): void {
    const prefix = `${runId}\u0000`;
    for (const key of agentSockets.keys()) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        const agentId = key.slice(prefix.length);
        sendDispatchableCommands(runId, agentId);
    }
}

function sendCommand(socket: WebSocket, command: ControlCommandEnvelope): void {
    socket.send(JSON.stringify(command));
}

function agentKey(runId: string, agentId: string): string {
    return `${runId}\u0000${agentId}`;
}

function safeCommandIdSegment(value: string): string {
    return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') ||
        'agent';
}

function snapshotBoundsFromUrl(url: URL): ControlRunSnapshotBounds {
    return {
        commands: limitParam(url, 'limitCommands'),
        results: limitParam(url, 'limitResults'),
        events: limitParam(url, 'limitEvents'),
        stats: limitParam(url, 'limitStats'),
        reports: limitParam(url, 'limitReports'),
        heartbeats: limitParam(url, 'limitHeartbeats')
    };
}

function limitParam(url: URL, key: string): number | undefined {
    const value = url.searchParams.get(key);
    if (!value) {
        return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

type ArtifactJsonlKind = 'events' | 'results';

type ArtifactRecorder = Readonly<{
    record(envelope: ControlClientEnvelope): void;
    flush(): Promise<void>;
    jsonlPath(runId: string, kind: ArtifactJsonlKind): string | undefined;
    deleteRun(runId: string): void;
}>;

type ArtifactRecorderOptions = Readonly<{
    commandSnapshot?: (
        runId: string,
        commandId: string
    ) => ControlQueuedCommandSnapshot | undefined;
}>;

function createArtifactRecorder(
    storageDir: string | undefined,
    options: ArtifactRecorderOptions = {}
): ArtifactRecorder {
    let writeQueue: Promise<void> = Promise.resolve();
    return {
        record(envelope) {
            const commandId = commandIdFromArtifactEnvelope(envelope);
            const command = commandId ? options.commandSnapshot?.(envelope.runId, commandId) : undefined;
            const writes = artifactJsonlWrites(envelope, command);
            if (!storageDir || writes.length === 0) {
                return;
            }
            const runDir = artifactRunDir(storageDir, envelope.runId);
            writeQueue = writeQueue
                .then(async () => {
                    await Deno.mkdir(runDir, { recursive: true });
                    for (const write of writes) {
                        await Deno.writeTextFile(`${runDir}/${write.fileName}`, write.text, {
                            append: true,
                            create: true
                        });
                    }
                })
                .catch((error) => {
                    console.warn(
                        `Could not append control artifact JSONL for ${envelope.runId}: ${errorMessage(error)}`
                    );
                });
        },
        flush() {
            return writeQueue;
        },
        jsonlPath(runId, kind) {
            return storageDir ? `${artifactRunDir(storageDir, runId)}/${kind}.jsonl` : undefined;
        },
        deleteRun(runId) {
            if (!storageDir) {
                return;
            }
            writeQueue = writeQueue
                .then(() => Deno.remove(artifactRunDir(storageDir, runId), { recursive: true }))
                .catch(() => undefined);
        }
    };
}

function artifactJsonlWrites(
    envelope: ControlClientEnvelope,
    command?: ControlQueuedCommandSnapshot
): readonly { fileName: 'events.jsonl' | 'results.jsonl'; text: string; }[] {
    if (envelope.kind === 'result') {
        return [
            { fileName: 'results.jsonl', text: controlResultArtifactJsonl(envelope, command) },
            { fileName: 'events.jsonl', text: controlResultEventArtifactJsonl(envelope, command) }
        ];
    }
    if (
        envelope.kind === 'event' || envelope.kind === 'diagnostic' || envelope.kind === 'stats' ||
        envelope.kind === 'report'
    ) {
        return [{ fileName: 'events.jsonl', text: controlEventArtifactJsonl(envelope, command) }];
    }
    return [];
}

function commandIdFromArtifactEnvelope(envelope: ControlClientEnvelope): string | undefined {
    return 'commandId' in envelope && typeof envelope.commandId === 'string'
        ? envelope.commandId
        : undefined;
}

function artifactRunDir(storageDir: string, runId: string): string {
    return `${storageDir.replace(/\/+$/, '')}/runs/${safePathSegment(runId)}`;
}

function safePathSegment(value: string): string {
    return encodeURIComponent(value).replace(/%/g, '_');
}

async function artifactJsonlResponse(
    runId: string,
    kind: ArtifactJsonlKind,
    fallbackRun: NonNullable<ReturnType<typeof controlService.snapshotRun>>
): Promise<Response> {
    const storedPath = artifactRecorder.jsonlPath(runId, kind);
    if (storedPath) {
        try {
            await artifactRecorder.flush();
            const file = await Deno.open(storedPath, { read: true });
            return new Response(file.readable, {
                status: 200,
                headers: responseHeaders('application/x-ndjson; charset=utf-8')
            });
        }
        catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
                console.warn(`Could not read control artifact ${storedPath}: ${errorMessage(error)}`);
            }
        }
    }

    const text = kind === 'events'
        ? controlRunEventsJsonl(fallbackRun)
        : controlRunResultsJsonl(fallbackRun);
    return textResponse(text, 200, 'application/x-ndjson; charset=utf-8');
}

function persistedSnapshotPath(): string | undefined {
    if (!security.storageDir) {
        return undefined;
    }

    return `${security.storageDir.replace(/\/+$/, '')}/control-snapshot.json`;
}

async function restorePersistedSnapshot(): Promise<void> {
    const path = persistedSnapshotPath();
    if (!path) {
        return;
    }

    try {
        const text = await Deno.readTextFile(path);
        const parsed = JSON.parse(text) as { snapshot?: ControlServerSnapshot; };
        if (parsed.snapshot?.runs) {
            controlService.restoreSnapshot(parsed.snapshot);
            console.log(`Restored Rallar black-box control snapshot from ${path}`);
        }
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return;
        }
        console.warn(`Could not restore control snapshot from ${path}: ${errorMessage(error)}`);
    }
}

function persistControlSnapshot(): void {
    const deletedRunIds = controlService.pruneRuns(security.retentionMaxRuns);
    if (deletedRunIds.length > 0) {
        closeDeletedRunSockets(deletedRunIds);
    }

    if (!persistedSnapshotPath()) {
        return;
    }
    snapshotPersistDirty = true;
    if (snapshotPersistScheduled || snapshotPersisting) {
        return;
    }
    snapshotPersistScheduled = true;
    setTimeout(() => {
        void flushPersistedSnapshot();
    }, SNAPSHOT_PERSIST_DEBOUNCE_MS);
}

async function flushPersistedSnapshot(): Promise<void> {
    snapshotPersistScheduled = false;
    if (!snapshotPersistDirty || snapshotPersisting) {
        return;
    }
    snapshotPersistDirty = false;
    snapshotPersisting = true;
    try {
        await writePersistedSnapshot();
    }
    finally {
        snapshotPersisting = false;
        if (snapshotPersistDirty) {
            persistControlSnapshot();
        }
    }
}

async function writePersistedSnapshot(): Promise<void> {
    const path = persistedSnapshotPath();
    if (!path) {
        return;
    }
    const tempPath = `${path}.tmp-${Deno.pid}-${Date.now()}-${snapshotPersistSequence += 1}`;

    const snapshot = controlService.snapshotForPersistence(security.snapshotPersistenceBounds);
    const payload = JSON.stringify(
        {
            schemaVersion: 1,
            savedAtEpochMs: Date.now(),
            snapshot
        },
        null,
        2
    );
    try {
        await Deno.mkdir(security.storageDir!, { recursive: true });
        await Deno.writeTextFile(tempPath, payload);
        await Deno.rename(tempPath, path);
    }
    catch (error) {
        Deno.remove(tempPath).catch(() => undefined);
        console.warn(`Could not persist control snapshot to ${path}: ${errorMessage(error)}`);
    }
}

function closeDeletedRunSockets(runIds: readonly string[]): void {
    for (const runId of runIds) {
        closeRunSockets(runId);
        artifactRecorder.deleteRun(runId);
    }
}

class PayloadTooLargeError extends Error {}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: responseHeaders('application/json')
    });
}

function jsonErrorResponse(error: unknown, fallbackStatus = 400): Response {
    return jsonResponse(
        { error: errorMessage(error) },
        error instanceof PayloadTooLargeError ? 413 : fallbackStatus
    );
}

function textResponse(
    value: string,
    status = 200,
    contentType = 'text/plain; charset=utf-8'
): Response {
    return new Response(value, {
        status,
        headers: responseHeaders(contentType)
    });
}

function emptyResponse(status: number): Response {
    return new Response(null, {
        status,
        headers: responseHeaders()
    });
}

function responseHeaders(contentType?: string): Headers {
    return createControlResponseHeaders(undefined, {
        contentType,
        corsOrigins
    });
}
