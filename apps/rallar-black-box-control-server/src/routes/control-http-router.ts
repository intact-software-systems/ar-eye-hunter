import type { ControlAgentSockets } from '../control-agent-sockets.ts';
import type { ControlArtifactRecorder } from '../control-artifact-recorder.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import type { ControlHttpResponses } from '../http/control-http-responses.ts';
import { isProtectedControlReadPath, type ControlHttpSecurity } from '../http/control-http-security.ts';
import type { ControlRequestBodyReader } from '../http/control-request-body.ts';
import type { RetentionPlanTokenAdapter } from '../retention-plan-token.ts';
import type { BrowserCommandDestinationPolicy } from '../validate-browser-command-destination.ts';
import { routeAgentWriteRequest } from './agent-routes-write.ts';
import { ADMIN_TOKEN_REJECTION, toNotFoundRejection } from './control-route-errors.ts';
import { isReadRequest } from './control-route-requests.ts';
import { openControlSocket } from './control-socket-route.ts';
import { routeDistributedRunAdminRequest } from './distributed-run-routes-admin.ts';
import { routeDistributedRunReadRequest } from './distributed-run-routes-read.ts';
import { routeFleetReportAdminRequest } from './fleet-report-routes-admin.ts';
import { routeFleetReportReadRequest } from './fleet-report-routes-read.ts';
import { routeRetentionAdminRequest } from './retention-routes-admin.ts';
import { routeRunAdminRequest } from './run-routes-admin.ts';
import { routeRunReadRequest } from './run-routes-read.ts';
import { handleSwaggerRoute, swaggerFallbackResponse } from './swagger-routes.ts';

export interface ControlHttpRouteDependencies {
    readonly controlService: RallarBlackBoxControlService;
    readonly security: ControlHttpSecurity;
    readonly requestBody: ControlRequestBodyReader;
    readonly responses: ControlHttpResponses;
    readonly agentSockets: ControlAgentSockets;
    readonly artifactRecorder: ControlArtifactRecorder;
    readonly persistence: ControlSnapshotPersistence;
    readonly retentionPlanTokens: RetentionPlanTokenAdapter;
    readonly commandDestinations: BrowserCommandDestinationPolicy;
    readonly retentionMaxRuns: number;
    readonly runTokenTtlMs: number;
    readonly now: () => number;
}

const CONTROL_SERVER_HEALTH = {
    ok: true,
    app: 'rallar-black-box-control-server',
    protocolVersion: 1
};
const ROUTE_NOT_FOUND = toNotFoundRejection('Not found.');

export async function routeControlHttpRequest(
    request: Request,
    dependencies: ControlHttpRouteDependencies
): Promise<Response> {
    const url = new URL(request.url);
    const policyRejection = dependencies.security.toRequestPolicyRejection(request, url);
    if (policyRejection) {
        return dependencies.responses.rejection(policyRejection);
    }
    if (request.method === 'OPTIONS') {
        return dependencies.responses.empty(204);
    }

    const swaggerResponse = handleSwaggerRoute(request, url, { corsOrigins: dependencies.responses.corsOrigins });
    if (swaggerResponse) {
        return swaggerResponse;
    }
    if (url.pathname === '/control') {
        return openControlSocket(request, dependencies);
    }
    return await routeControlApiRequest(request, url, dependencies);
}

async function routeControlApiRequest(
    request: Request,
    url: URL,
    dependencies: ControlHttpRouteDependencies
): Promise<Response> {
    const isRead = isReadRequest(request);
    if (isRead && url.pathname === '/health') {
        return dependencies.responses.json(CONTROL_SERVER_HEALTH, 200);
    }
    if (
        isRead &&
        isProtectedControlReadPath(url.pathname) &&
        !(await dependencies.security.authorizeReadRequest(request, url))
    ) {
        return dependencies.responses.rejection(ADMIN_TOKEN_REJECTION);
    }

    if (isRead) {
        const readResponse = await routeControlReadRequest(url, dependencies);
        return readResponse ?? swaggerFallbackResponse(request, { corsOrigins: dependencies.responses.corsOrigins });
    }
    const writeResponse = await routeControlWriteRequest(request, url, dependencies);
    return writeResponse ?? dependencies.responses.rejection(ROUTE_NOT_FOUND);
}

async function routeControlReadRequest(
    url: URL,
    dependencies: ControlHttpRouteDependencies
): Promise<Response | undefined> {
    return routeFleetReportReadRequest(url, dependencies) ??
        routeDistributedRunReadRequest(url, dependencies) ??
        await routeRunReadRequest(url, dependencies);
}

async function routeControlWriteRequest(
    request: Request,
    url: URL,
    dependencies: ControlHttpRouteDependencies
): Promise<Response | undefined> {
    return await routeRetentionAdminRequest(request, url, dependencies) ??
        await routeFleetReportAdminRequest(request, url, dependencies) ??
        await routeDistributedRunAdminRequest(request, url, dependencies) ??
        await routeRunAdminRequest(request, url, dependencies) ??
        await routeAgentWriteRequest(request, url, dependencies);
}
