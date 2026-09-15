import {
    parseControlClientMessage,
    type ControlCommandEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { Either } from '@shared/resilience/Either.ts';

import type { ControlAgentIdentity, ControlAgentSockets } from '../control-agent-sockets.ts';
import type { ControlArtifactRecorder } from '../control-artifact-recorder.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import type { ControlHttpRejection, ControlHttpResponses } from '../http/control-http-responses.ts';
import { toControlRequestToken, type ControlHttpSecurity } from '../http/control-http-security.ts';
import type { ControlRequestBodyReader } from '../http/control-request-body.ts';
import type { BrowserCommandDestinationPolicy } from '../validate-browser-command-destination.ts';
import {
    decodeCommandRequest,
    toDestinationAdmittedRequest,
    type CommandRequest
} from './command-request-codec.ts';
import {
    RUN_TOKEN_REJECTION,
    toBadRequestRejection,
    toControlServiceRejection,
    toRejected
} from './control-route-errors.ts';
import { toPathParameters } from './control-route-requests.ts';

export interface AgentWriteRouteDependencies {
    readonly controlService: Pick<RallarBlackBoxControlService, 'enqueueCommand' | 'receiveClientEnvelope'>;
    readonly security: Pick<ControlHttpSecurity, 'authorizeRunToken'>;
    readonly requestBody: ControlRequestBodyReader;
    readonly commandDestinations: BrowserCommandDestinationPolicy;
    readonly agentSockets: Pick<ControlAgentSockets, 'sendDispatchableCommands'>;
    readonly artifactRecorder: Pick<ControlArtifactRecorder, 'record'>;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly responses: ControlHttpResponses;
}

const AGENT_COMMANDS_PATH = /^\/runs\/([^/]+)\/agents\/([^/]+)\/commands$/;
const AGENT_REPORT_PATH = /^\/runs\/([^/]+)\/agents\/([^/]+)\/report$/;
const REPORT_TARGET_MISMATCH = toBadRequestRejection('Report upload envelope does not match the target run and agent.');

export async function routeAgentWriteRequest(
    request: Request,
    url: URL,
    dependencies: AgentWriteRouteDependencies
): Promise<Response | undefined> {
    if (request.method !== 'POST') {
        return undefined;
    }
    const commandTarget = toPathParameters(url.pathname, AGENT_COMMANDS_PATH);
    const [runId, agentId] = commandTarget ?? toPathParameters(url.pathname, AGENT_REPORT_PATH) ?? [];
    if (runId === undefined || agentId === undefined) {
        return undefined;
    }

    const agent: ControlAgentIdentity = { runId, agentId };
    if (!dependencies.security.authorizeRunToken({ ...agent, token: toControlRequestToken(request, url) })) {
        return dependencies.responses.rejection(RUN_TOKEN_REJECTION);
    }
    return commandTarget
        ? await enqueueAgentCommandRoute(request, agent, dependencies)
        : await uploadAgentReportRoute(request, agent, dependencies);
}

async function enqueueAgentCommandRoute(
    request: Request,
    agent: ControlAgentIdentity,
    dependencies: AgentWriteRouteDependencies
): Promise<Response> {
    const { agentSockets, controlService, persistence, responses } = dependencies;
    const enqueued = (await readAdmittedCommandRequest(request, dependencies))
        .flatMap<ControlHttpRejection, ControlCommandEnvelope>(
            toRejected,
            (commandRequest) =>
                controlService.enqueueCommand({ ...agent, ...commandRequest }).mapLeft(toControlServiceRejection)
        );
    return enqueued.fold(
        (rejection) => responses.rejection(rejection),
        (command) => {
            agentSockets.sendDispatchableCommands(agent);
            persistence.persist();
            return responses.json({ accepted: true, command }, 202);
        }
    );
}

async function readAdmittedCommandRequest(
    request: Request,
    { commandDestinations, requestBody }: Pick<AgentWriteRouteDependencies, 'commandDestinations' | 'requestBody'>
): Promise<Either<ControlHttpRejection, CommandRequest>> {
    return (await requestBody.readJsonBody(request))
        .flatMap<ControlHttpRejection, CommandRequest>(
            toRejected,
            (body) => decodeCommandRequest(body).mapLeft(toBadRequestRejection)
        )
        .flatMap<ControlHttpRejection, CommandRequest>(
            toRejected,
            (commandRequest) => toDestinationAdmittedRequest(commandRequest, commandDestinations)
        );
}

async function uploadAgentReportRoute(
    request: Request,
    agent: ControlAgentIdentity,
    { artifactRecorder, controlService, persistence, requestBody, responses }: AgentWriteRouteDependencies
): Promise<Response> {
    const body = await requestBody.readJsonBody(request);
    if (body.left !== undefined) {
        return responses.rejection(body.left);
    }
    const parsed = parseControlClientMessage(body.right);
    if (!parsed.ok) {
        return responses.rejection(toBadRequestRejection(parsed.error));
    }
    const envelope = parsed.envelope;
    if (envelope.kind !== 'report' || envelope.runId !== agent.runId || envelope.agentId !== agent.agentId) {
        return responses.rejection(REPORT_TARGET_MISMATCH);
    }

    if (controlService.receiveClientEnvelope(envelope).accepted) {
        artifactRecorder.record(envelope);
    }
    persistence.persist();
    return responses.json({ accepted: true }, 202);
}
