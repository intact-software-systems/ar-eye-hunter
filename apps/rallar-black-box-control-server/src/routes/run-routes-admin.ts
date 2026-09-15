import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ControlAgentSockets } from '../control-agent-sockets.ts';
import type { ControlArtifactRecorder } from '../control-artifact-recorder.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import type { ControlHttpRejection, ControlHttpResponses } from '../http/control-http-responses.ts';
import type { ControlHttpSecurity } from '../http/control-http-security.ts';
import type { ControlRequestBodyReader } from '../http/control-request-body.ts';
import type { BrowserCommandDestinationPolicy } from '../validate-browser-command-destination.ts';
import {
    decodeBulkCommandRequest,
    toBulkCommandInputs,
    toDestinationAdmittedRequest,
    type BulkCommandRequest
} from './command-request-codec.ts';
import {
    ADMIN_TOKEN_REJECTION,
    toBadRequestRejection,
    toControlServiceRejection,
    toNotFoundRejection,
    toRejected
} from './control-route-errors.ts';
import { toPathParameters } from './control-route-requests.ts';

export interface RunAdminRouteDependencies {
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        'deleteRun' | 'enqueueCommand' | 'issueRunToken' | 'resetRun'
    >;
    readonly security: Pick<ControlHttpSecurity, 'authorizeAdminRequest'>;
    readonly requestBody: ControlRequestBodyReader;
    readonly commandDestinations: BrowserCommandDestinationPolicy;
    readonly runTokenTtlMs: number;
    readonly now: () => number;
    readonly agentSockets: Pick<ControlAgentSockets, 'closeRun' | 'sendDispatchableCommands'>;
    readonly artifactRecorder: Pick<ControlArtifactRecorder, 'deleteRun'>;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly responses: ControlHttpResponses;
}

interface BulkCommandsEnqueued {
    readonly agentIds: readonly string[];
    readonly commands: readonly ControlCommandEnvelope[];
}

interface RunAdminRouteRequest {
    readonly request: Request;
    readonly url: URL;
    readonly runId: string;
}

const RUN_PATH = /^\/runs\/([^/]+)$/;
const RUN_RESET_PATH = /^\/runs\/([^/]+)\/reset$/;
const RUN_COMMANDS_PATH = /^\/runs\/([^/]+)\/commands$/;
const AGENT_TOKENS_PATH = /^\/runs\/([^/]+)\/agents\/([^/]+)\/tokens$/;
const RUN_NOT_FOUND = toNotFoundRejection('Run not found.');

export async function routeRunAdminRequest(
    request: Request,
    url: URL,
    dependencies: RunAdminRouteDependencies
): Promise<Response | undefined> {
    const [deletedRunId] = request.method === 'DELETE' ? toPathParameters(url.pathname, RUN_PATH) ?? [] : [];
    if (deletedRunId !== undefined) {
        return await deleteRunRoute({ request, url, runId: deletedRunId }, dependencies);
    }
    if (request.method !== 'POST') {
        return undefined;
    }

    const [resetRunId] = toPathParameters(url.pathname, RUN_RESET_PATH) ?? [];
    if (resetRunId !== undefined) {
        return await resetRunRoute({ request, url, runId: resetRunId }, dependencies);
    }
    const [commandsRunId] = toPathParameters(url.pathname, RUN_COMMANDS_PATH) ?? [];
    if (commandsRunId !== undefined) {
        return await enqueueBulkCommandsRoute({ request, url, runId: commandsRunId }, dependencies);
    }
    const [tokenRunId, tokenAgentId] = toPathParameters(url.pathname, AGENT_TOKENS_PATH) ?? [];
    return tokenRunId === undefined || tokenAgentId === undefined
        ? undefined
        : await issueAgentTokenRoute({ request, url, runId: tokenRunId }, tokenAgentId, dependencies);
}

async function deleteRunRoute(
    { request, url, runId }: RunAdminRouteRequest,
    { agentSockets, artifactRecorder, controlService, persistence, responses, security }: RunAdminRouteDependencies
): Promise<Response> {
    if (!(await security.authorizeAdminRequest(request, url))) {
        return responses.rejection(ADMIN_TOKEN_REJECTION);
    }

    agentSockets.closeRun(runId);
    const deleted = controlService.deleteRun(runId);
    if (deleted) {
        artifactRecorder.deleteRun(runId);
    }
    persistence.persist();
    return deleted ? responses.json({ deleted: true, runId }, 200) : responses.rejection(RUN_NOT_FOUND);
}

async function resetRunRoute(
    { request, url, runId }: RunAdminRouteRequest,
    { artifactRecorder, controlService, persistence, responses, security }: RunAdminRouteDependencies
): Promise<Response> {
    if (!(await security.authorizeAdminRequest(request, url))) {
        return responses.rejection(ADMIN_TOKEN_REJECTION);
    }

    const run = controlService.resetRun(runId);
    if (run) {
        artifactRecorder.deleteRun(runId);
    }
    persistence.persist();
    return run ? responses.json({ reset: true, run }, 200) : responses.rejection(RUN_NOT_FOUND);
}

async function enqueueBulkCommandsRoute(
    { request, url, runId }: RunAdminRouteRequest,
    dependencies: RunAdminRouteDependencies
): Promise<Response> {
    const { agentSockets, persistence, responses, security } = dependencies;
    if (!(await security.authorizeAdminRequest(request, url))) {
        return responses.rejection(ADMIN_TOKEN_REJECTION);
    }

    const enqueued = (await readAdmittedBulkRequest(request, dependencies)).flatMap<
        ControlHttpRejection,
        BulkCommandsEnqueued
    >(
        toRejected,
        (bulkRequest) => enqueueBulkCommands(runId, bulkRequest, dependencies)
    );
    return enqueued.fold(
        (rejection) => responses.rejection(rejection),
        ({ agentIds, commands }) => {
            for (const agentId of agentIds) {
                agentSockets.sendDispatchableCommands({ runId, agentId });
            }
            persistence.persist();
            return responses.json({ accepted: true, commands }, 202);
        }
    );
}

async function issueAgentTokenRoute(
    { request, url, runId }: RunAdminRouteRequest,
    agentId: string,
    { controlService, persistence, requestBody, responses, runTokenTtlMs, security }: RunAdminRouteDependencies
): Promise<Response> {
    if (!(await security.authorizeAdminRequest(request, url))) {
        return responses.rejection(ADMIN_TOKEN_REJECTION);
    }

    const body = await requestBody.readOptionalJsonBody(request);
    return body.fold(
        (rejection) => responses.rejection(rejection),
        (value) => {
            const token = controlService.issueRunToken({
                runId,
                agentId,
                ttlMs: decodeRunTokenTtlMs(value, runTokenTtlMs)
            });
            persistence.persist();
            return responses.json(token, 201);
        }
    );
}

async function readAdmittedBulkRequest(
    request: Request,
    { commandDestinations, requestBody }: Pick<RunAdminRouteDependencies, 'commandDestinations' | 'requestBody'>
): Promise<Either<ControlHttpRejection, BulkCommandRequest>> {
    return (await requestBody.readJsonBody(request))
        .flatMap<ControlHttpRejection, BulkCommandRequest>(
            toRejected,
            (body) => decodeBulkCommandRequest(body).mapLeft(toBadRequestRejection)
        )
        .flatMap<ControlHttpRejection, BulkCommandRequest>(
            toRejected,
            (bulkRequest) => toDestinationAdmittedRequest(bulkRequest, commandDestinations)
        );
}

function enqueueBulkCommands(
    runId: string,
    request: BulkCommandRequest,
    { controlService, now }: Pick<RunAdminRouteDependencies, 'controlService' | 'now'>
): Either<ControlHttpRejection, BulkCommandsEnqueued> {
    const commands: ControlCommandEnvelope[] = [];
    for (const input of toBulkCommandInputs({ runId, request, nowEpochMs: now() })) {
        const rejection = controlService.enqueueCommand(input).fold(
            (failure) => toControlServiceRejection(failure),
            (command) => {
                commands.push(command);
                return undefined;
            }
        );
        if (rejection) {
            return Either.ofLeft(rejection);
        }
    }
    return Either.ofRight({ agentIds: request.agentIds, commands });
}

function decodeRunTokenTtlMs(body: unknown, defaultTtlMs: number): number {
    if (!isJsonRecordValue(body) || !('ttlMs' in body)) {
        return defaultTtlMs;
    }
    const ttlMs = Number.parseInt(String(body.ttlMs), 10);
    return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : defaultTtlMs;
}
