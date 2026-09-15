import { parseControlClientMessage, type ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';

import type { ControlAgentSockets } from '../control-agent-sockets.ts';
import type { ControlArtifactRecorder } from '../control-artifact-recorder.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import type { ControlHttpResponses } from '../http/control-http-responses.ts';
import { toControlRequestToken, type ControlHttpSecurity } from '../http/control-http-security.ts';
import type { ControlRequestBodyReader } from '../http/control-request-body.ts';
import { RUN_TOKEN_REJECTION } from './control-route-errors.ts';

export interface ControlSocketRouteDependencies {
    readonly controlService: Pick<RallarBlackBoxControlService, 'markAgentDisconnected' | 'receiveClientEnvelope'>;
    readonly security: Pick<ControlHttpSecurity, 'authorizeRunToken'>;
    readonly requestBody: Pick<ControlRequestBodyReader, 'decodeMessageText'>;
    readonly agentSockets: ControlAgentSockets;
    readonly artifactRecorder: Pick<ControlArtifactRecorder, 'record'>;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly responses: ControlHttpResponses;
}

interface ControlSocketMessage {
    readonly socket: WebSocket;
    readonly socketToken: string | undefined;
    readonly data: MessageEvent['data'];
}

const MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const UNSUPPORTED_DATA_CLOSE_CODE = 1003;
const POLICY_VIOLATION_CLOSE_CODE = 1008;

export function openControlSocket(request: Request, dependencies: ControlSocketRouteDependencies): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return dependencies.responses.rejection({ status: 426, message: 'Expected WebSocket upgrade.' });
    }

    const socketToken = toControlRequestToken(request, new URL(request.url));
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onmessage = (event) => {
        void receiveControlSocketMessage({ socket, socketToken, data: event.data }, dependencies);
    };
    socket.onclose = () => {
        const agent = dependencies.agentSockets.release(socket);
        if (agent) {
            dependencies.controlService.markAgentDisconnected(agent.runId, agent.agentId);
            dependencies.persistence.persist();
        }
    };
    return response;
}

async function receiveControlSocketMessage(
    { socket, socketToken, data }: ControlSocketMessage,
    dependencies: ControlSocketRouteDependencies
): Promise<void> {
    const text = await dependencies.requestBody.decodeMessageText(data);
    if (text.left !== undefined) {
        const closeCode = text.left.status === 413 ? MESSAGE_TOO_BIG_CLOSE_CODE : UNSUPPORTED_DATA_CLOSE_CODE;
        socket.close(closeCode, text.left.message);
        return;
    }
    const parsed = parseControlClientMessage(text.right);
    if (!parsed.ok) {
        socket.close(UNSUPPORTED_DATA_CLOSE_CODE, parsed.error);
        return;
    }
    const envelope = parsed.envelope;
    if (
        envelope.kind === 'register' &&
        !dependencies.security.authorizeRunToken({
            runId: envelope.runId,
            agentId: envelope.agentId,
            token: envelope.token ?? socketToken
        })
    ) {
        socket.close(POLICY_VIOLATION_CLOSE_CODE, RUN_TOKEN_REJECTION.message);
        return;
    }
    acceptControlClientEnvelope(socket, envelope, dependencies);
}

function acceptControlClientEnvelope(
    socket: WebSocket,
    envelope: ControlClientEnvelope,
    { agentSockets, artifactRecorder, controlService, persistence }: ControlSocketRouteDependencies
): void {
    if (envelope.kind !== 'report') {
        artifactRecorder.record(envelope);
    }
    const received = controlService.receiveClientEnvelope(envelope);
    if (envelope.kind === 'report' && received.accepted) {
        artifactRecorder.record(envelope);
    }
    if (received.kind === 'register') {
        agentSockets.register(socket, { runId: received.runId, agentId: received.agentId });
    }
    agentSockets.sendDispatchableCommandsForRun(received.runId);
    persistence.persist();
}
