import { assertBlackBoxControlProductionEnv } from '@shared-server/http/black-box-control-production-env.ts';
import {
    parseControlClientMessage,
    validateRallarBlackBoxTestCommand,
    type ControlCommandEnvelope
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
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';
import { createControlArtifactRecorder } from './control-artifact-recorder.ts';
import {
    controlRunArtifactContentType,
    controlRunArtifactFileNameFromValue,
    controlRunFailureBundle,
    createControlRunArtifactBundle
} from './control-artifacts.ts';
import { fleetReportFilterFromUrl } from './control-fleet.ts';
import { createControlHttpSecurity } from './control-http-security.ts';
import { PayloadTooLargeError } from './control-request-body.ts';
import { readBlackBoxControlServerConfiguration } from './control-server-configuration.ts';
import type { ControlRunSnapshotBounds, EnqueueControlCommandInput } from './control-service.ts';
import { createRallarBlackBoxControlService } from './control-service.ts';
import { createControlSnapshotPersistence } from './control-snapshot-persistence.ts';
import { applyControlCorsHeaders, corsOriginsFromAllowedOrigins, createControlResponseHeaders } from './cors.ts';
import { handleRetentionCleanup } from './retention-cleanup.ts';
import { createRetentionPlanTokenAdapter } from './retention-plan-token.ts';
import { handleSwaggerRoute, swaggerFallbackResponse } from './routes/swagger-routes.ts';

const DEFAULT_PORT = 5180;
const OPEN_STATE = 1;
const ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS: ControlRunSnapshotBounds = {
    commands: 200,
    results: 200,
    events: 200,
    stats: 100,
    reports: 20,
    heartbeats: 100
};

assertBlackBoxControlProductionEnv(Deno.env);

const security = readBlackBoxControlServerConfiguration(Deno.env);
const controlService = createRallarBlackBoxControlService({
    allowedCommandKinds: security.allowedCommandKinds,
    commandRateLimitMax: security.commandRateLimitMax,
    commandRateLimitWindowMs: security.commandRateLimitWindowMs,
    runTokenTtlMs: security.runTokenTtlMs,
    runtimeRetentionBounds: security.runtimeRetentionBounds
});
const artifactRecorder = createControlArtifactRecorder({
    storageDir: security.storageDir,
    commandSnapshot: (runId, commandId) => controlService.snapshotCommand(runId, commandId)
});
const agentSockets = new Map<string, WebSocket>();
const socketAgents = new WeakMap<WebSocket, { runId: string; agentId: string; }>();
const retentionPlanTokens = createRetentionPlanTokenAdapter({
    key: crypto.getRandomValues(new Uint8Array(32))
});
const port = Number(Deno.env.get('PORT') ?? DEFAULT_PORT);
const corsOrigins = corsOriginsFromAllowedOrigins(security.allowedOrigins);
const httpSecurity = createControlHttpSecurity({
    configuration: security,
    controlService,
    jsonResponse
});
const snapshotPersistence = createControlSnapshotPersistence({
    storageDir: security.storageDir,
    retentionMaxRuns: security.retentionMaxRuns,
    snapshotBounds: security.snapshotPersistenceBounds,
    controlService,
    deleteRuns: (runIds) => {
        for (const runId of runIds) {
            closeRunSockets(runId);
            artifactRecorder.deleteRun(runId);
        }
    }
});

await snapshotPersistence.restore();

Deno.serve({ port }, async (request) => {
    return applyControlCorsHeaders(request, await handleRequest(request), corsOrigins);
});

console.log(`Rallar black-box control server listening on http://localhost:${port}`);
console.log(`Agent WebSocket endpoint: ws://localhost:${port}/control`);

async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const policyRejection = httpSecurity.rejectByRequestPolicy(request, url);
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
        httpSecurity.isProtectedControlReadPath(url.pathname) &&
        !(await httpSecurity.authorizeReadRequest(request, url))
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
        if (!(await httpSecurity.authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        const response = controlService.rebuildFleetReports();
        snapshotPersistence.persist();
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
        if (!(await httpSecurity.authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        return await createDistributedRun(request);
    }

    if (request.method === 'POST' && url.pathname === '/distributed-runs/resolve-targets') {
        if (!(await httpSecurity.authorizeAdminRequest(request, url))) {
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
        if (!(await httpSecurity.authorizeAdminRequest(request, url))) {
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
            authorize: () => httpSecurity.authorizeAdminRequest(request, url),
            service: {
                createRetentionPlan: (maxRuns) => controlService.createRetentionPlan(maxRuns),
                applyRetentionPlan: (plan) => controlService.applyRetentionPlan(plan),
                pruneRuns: (maxRuns) => controlService.pruneRuns(maxRuns),
                legacyRetainedRuns: () => controlService.snapshot().runs.length
            },
            tokens: retentionPlanTokens,
            persist: () => snapshotPersistence.persist()
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
        if (!(await httpSecurity.authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        closeRunSockets(runId);
        const deleted = controlService.deleteRun(runId);
        if (deleted) {
            artifactRecorder.deleteRun(runId);
        }
        snapshotPersistence.persist();
        return deleted
            ? jsonResponse({ deleted: true, runId })
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const runResetMatch = url.pathname.match(/^\/runs\/([^/]+)\/reset$/);
    if (request.method === 'POST' && runResetMatch) {
        const runId = decodeURIComponent(runResetMatch[1]);
        if (!(await httpSecurity.authorizeAdminRequest(request, url))) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        const run = controlService.resetRun(runId);
        if (run) {
            artifactRecorder.deleteRun(runId);
        }
        snapshotPersistence.persist();
        return run
            ? jsonResponse({ reset: true, run })
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const runCommandsMatch = url.pathname.match(/^\/runs\/([^/]+)\/commands$/);
    if (request.method === 'POST' && runCommandsMatch) {
        const runId = decodeURIComponent(runCommandsMatch[1]);
        if (!(await httpSecurity.authorizeAdminRequest(request, url))) {
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
            return await artifactRecorder.response(
                runId,
                fileName === 'events.jsonl' ? 'events' : 'results',
                run,
                corsOrigins
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
            ? await artifactRecorder.response(runId, 'events', run, corsOrigins)
            : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const runResultsJsonlMatch = url.pathname.match(/^\/runs\/([^/]+)\/results\.jsonl$/);
    if (isRead && runResultsJsonlMatch) {
        const runId = decodeURIComponent(runResultsJsonlMatch[1]);
        const run = controlService.snapshotRun(runId, ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS);
        return run
            ? await artifactRecorder.response(runId, 'results', run, corsOrigins)
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
        if (!httpSecurity.authorizeRunRequest(request, url, runId, agentId)) {
            return jsonResponse({ error: 'Run token is required or invalid.' }, 401);
        }
        return await enqueueCommand(request, runId, agentId);
    }

    const agentReportMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/report$/);
    if (request.method === 'POST' && agentReportMatch) {
        const runId = decodeURIComponent(agentReportMatch[1]);
        const agentId = decodeURIComponent(agentReportMatch[2]);
        if (!httpSecurity.authorizeRunRequest(request, url, runId, agentId)) {
            return jsonResponse({ error: 'Run token is required or invalid.' }, 401);
        }
        return await uploadReport(request, runId, agentId);
    }

    const agentTokenMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/tokens$/);
    if (request.method === 'POST' && agentTokenMatch) {
        const runId = decodeURIComponent(agentTokenMatch[1]);
        const agentId = decodeURIComponent(agentTokenMatch[2]);
        if (!(await httpSecurity.authorizeAdminRequest(request, url))) {
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
    const socketToken = httpSecurity.tokenFromRequest(request, url);
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
            snapshotPersistence.persist();
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
        !httpSecurity.authorizeRunToken(
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
    snapshotPersistence.persist();
}

async function controlSocketMessageData(data: unknown): Promise<unknown> {
    if (typeof data === 'string') {
        httpSecurity.assertPayloadByteLength(new TextEncoder().encode(data).byteLength);
        return data;
    }
    if (data instanceof ArrayBuffer) {
        httpSecurity.assertPayloadByteLength(data.byteLength);
        return new TextDecoder().decode(data);
    }
    if (data instanceof Blob) {
        httpSecurity.assertPayloadByteLength(data.size);
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
        snapshotPersistence.persist();
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
            const body = await httpSecurity.readJsonBody(request, true);
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
        snapshotPersistence.persist();
        return jsonResponse(distributedRun, 202);
    }
    catch (error) {
        return distributedRunErrorResponse(error);
    }
}

async function readDistributedRunManifest(
    request: Request
): Promise<RallarBlackBoxDistributedRunManifest> {
    const body = await httpSecurity.readJsonBody(request);
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
        body = await httpSecurity.readJsonBody(request) as Omit<EnqueueControlCommandInput, 'runId' | 'agentId'>;
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

    const destinationError = httpSecurity.validateBrowserCommandDestination(body.command);
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
    snapshotPersistence.persist();
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
        body = await httpSecurity.readJsonBody(request);
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
    const destinationError = httpSecurity.validateBrowserCommandDestination(commandTemplate);
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
    snapshotPersistence.persist();
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
        body = await httpSecurity.readJsonBody(request);
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
    snapshotPersistence.persist();
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
        body = await httpSecurity.readJsonBody(request, true);
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

    snapshotPersistence.persist();
    return jsonResponse(token, 201);
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
