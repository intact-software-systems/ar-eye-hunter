import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ControlAgentSockets } from '../control-agent-sockets.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import type { ControlHttpRejection, ControlHttpResponses } from '../http/control-http-responses.ts';
import type { ControlHttpSecurity } from '../http/control-http-security.ts';
import type { ControlRequestBodyReader } from '../http/control-request-body.ts';
import { ADMIN_TOKEN_REJECTION, toBadRequestRejection, toControlServiceRejection } from './control-route-errors.ts';
import {
    decodeDistributedRunCancelReason,
    decodeDistributedRunManifestRequest
} from './distributed-run-request-codec.ts';

export interface DistributedRunAdminRouteDependencies {
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        | 'cancelDistributedRun'
        | 'createDistributedRun'
        | 'resolveDistributedRunTargets'
        | 'stageDistributedRun'
        | 'startDistributedRun'
    >;
    readonly security: Pick<ControlHttpSecurity, 'authorizeAdminRequest'>;
    readonly requestBody: ControlRequestBodyReader;
    readonly agentSockets: Pick<ControlAgentSockets, 'sendDispatchableCommands'>;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly responses: ControlHttpResponses;
}

interface DistributedRunActionRequest {
    readonly request: Request;
    readonly distributedRunId: string;
    readonly action: 'stage' | 'start' | 'cancel';
}

const DISTRIBUTED_RUN_ACTION_PATH = /^\/distributed-runs\/([^/]+)\/(stage|start|cancel)$/;

export async function routeDistributedRunAdminRequest(
    request: Request,
    url: URL,
    dependencies: DistributedRunAdminRouteDependencies
): Promise<Response | undefined> {
    const actionMatch = DISTRIBUTED_RUN_ACTION_PATH.exec(url.pathname);
    const isCollectionPath = url.pathname === '/distributed-runs' ||
        url.pathname === '/distributed-runs/resolve-targets';
    if (request.method !== 'POST' || (!actionMatch && !isCollectionPath)) {
        return undefined;
    }
    if (!(await dependencies.security.authorizeAdminRequest(request, url))) {
        return dependencies.responses.rejection(ADMIN_TOKEN_REJECTION);
    }

    if (actionMatch) {
        const distributedRunId = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2] as DistributedRunActionRequest['action'];
        return await mutateDistributedRunRoute({ request, distributedRunId, action }, dependencies);
    }
    return url.pathname === '/distributed-runs'
        ? await createDistributedRunRoute(request, dependencies)
        : await resolveDistributedRunTargetsRoute(request, dependencies);
}

async function createDistributedRunRoute(
    request: Request,
    { controlService, persistence, requestBody, responses }: DistributedRunAdminRouteDependencies
): Promise<Response> {
    const created = (await readDistributedRunManifest(request, requestBody)).flatMap(
        (rejection) => Either.ofLeft<ControlHttpRejection, ControlDistributedRunSnapshot>(rejection),
        (manifest) => controlService.createDistributedRun(manifest).mapLeft(toControlServiceRejection)
    );
    return created.fold(
        (rejection) => responses.rejection(rejection),
        (distributedRun) => {
            persistence.persist();
            return responses.json(distributedRun, 201);
        }
    );
}

async function resolveDistributedRunTargetsRoute(
    request: Request,
    { controlService, requestBody, responses }: DistributedRunAdminRouteDependencies
): Promise<Response> {
    const manifest = await readDistributedRunManifest(request, requestBody);
    return manifest.fold(
        (rejection) => responses.rejection(rejection),
        (distributedRunManifest) =>
            responses.json(controlService.resolveDistributedRunTargets(distributedRunManifest), 200)
    );
}

async function mutateDistributedRunRoute(
    actionRequest: DistributedRunActionRequest,
    { agentSockets, persistence, responses, ...dependencies }: DistributedRunAdminRouteDependencies
): Promise<Response> {
    const mutated = await applyDistributedRunAction(actionRequest, dependencies);
    return mutated.fold(
        (rejection) => responses.rejection(rejection),
        (distributedRun) => {
            for (const agentId of distributedRun.targetAgentIds) {
                agentSockets.sendDispatchableCommands({ runId: distributedRun.controlRunId, agentId });
            }
            persistence.persist();
            return responses.json(distributedRun, 202);
        }
    );
}

async function applyDistributedRunAction(
    { request, distributedRunId, action }: DistributedRunActionRequest,
    { controlService, requestBody }: Pick<DistributedRunAdminRouteDependencies, 'controlService' | 'requestBody'>
): Promise<Either<ControlHttpRejection, ControlDistributedRunSnapshot>> {
    if (action === 'stage') {
        return controlService.stageDistributedRun(distributedRunId).mapLeft(toControlServiceRejection);
    }
    if (action === 'start') {
        return controlService.startDistributedRun(distributedRunId).mapLeft(toControlServiceRejection);
    }

    const body = await requestBody.readOptionalJsonBody(request);
    return body.flatMap(
        (rejection) => Either.ofLeft<ControlHttpRejection, ControlDistributedRunSnapshot>(rejection),
        (value) =>
            controlService
                .cancelDistributedRun(distributedRunId, decodeDistributedRunCancelReason(value))
                .mapLeft(toControlServiceRejection)
    );
}

async function readDistributedRunManifest(
    request: Request,
    requestBody: ControlRequestBodyReader
): Promise<Either<ControlHttpRejection, RallarBlackBoxDistributedRunManifest>> {
    const body = await requestBody.readJsonBody(request);
    return body.flatMap(
        (rejection) => Either.ofLeft<ControlHttpRejection, RallarBlackBoxDistributedRunManifest>(rejection),
        (value) => decodeDistributedRunManifestRequest(value).mapLeft(toBadRequestRejection)
    );
}
