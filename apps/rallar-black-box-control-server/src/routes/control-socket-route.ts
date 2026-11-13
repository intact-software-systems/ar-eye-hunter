import type { Server, WebSocketHandler } from 'bun';

import { parseControlClientMessage, type ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { Either } from '@shared/resilience/Either.ts';

import type { ControlAgentSocket, ControlAgentSockets } from '../control-agent-sockets.ts';
import type { ControlArtifactRecorder } from '../control-artifact-recorder.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import type { ControlHttpRejection, ControlHttpResponses } from '../http/control-http-responses.ts';
import { toControlRequestToken, type ControlHttpSecurity } from '../http/control-http-security.ts';
import { decodeControlMessageText, type ControlRequestBodyReader } from '../http/control-request-body.ts';
import { RUN_TOKEN_REJECTION } from './control-route-errors.ts';

export interface ControlSocketRouteDependencies {
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        'markAgentDisconnected' | 'receiveClientEnvelope' | 'snapshotCommand'
    >;
    readonly security: Pick<ControlHttpSecurity, 'authorizeRunToken'>;
    readonly requestBody: Pick<ControlRequestBodyReader, 'maxRequestBytes'>;
    readonly agentSockets: ControlAgentSockets;
    readonly artifactRecorder: Pick<ControlArtifactRecorder, 'record'>;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly responses: ControlHttpResponses;
}

/** Per-connection state handed to `server.upgrade` and read back from `ws.data`. */
export interface ControlSocketData {
    readonly socketToken: string | undefined;
}

interface ControlSocketMessage {
    readonly socket: ControlAgentSocket;
    readonly socketToken: string | undefined;
    readonly frameText: Either<ControlHttpRejection, string>;
}

const MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const UNSUPPORTED_DATA_CLOSE_CODE = 1003;
const POLICY_VIOLATION_CLOSE_CODE = 1008;

export function openControlSocket(
    request: Request,
    server: Server<ControlSocketData>,
    dependencies: ControlSocketRouteDependencies
): Response | undefined {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return dependencies.responses.rejection({ status: 426, message: 'Expected WebSocket upgrade.' });
    }

    const socketToken = toControlRequestToken(request, new URL(request.url));
    const upgraded = server.upgrade(request, { data: { socketToken } });
    if (!upgraded) {
        return dependencies.responses.rejection({ status: 426, message: 'Expected WebSocket upgrade.' });
    }
    return undefined;
}

export function createControlWebSocketHandlers(
    dependencies: ControlSocketRouteDependencies
): WebSocketHandler<ControlSocketData> {
    return {
        message(ws, message) {
            const { socketToken } = ws.data;
            void decodeControlMessageText(toControlFrameText(message), dependencies.requestBody.maxRequestBytes).then(
                (frameText) => receiveControlSocketMessage({ socket: ws, socketToken, frameText }, dependencies)
            );
        },
        close(ws) {
            const agent = dependencies.agentSockets.release(ws);
            if (agent) {
                dependencies.controlService.markAgentDisconnected(agent.runId, agent.agentId);
                dependencies.persistence.persist();
            }
        }
    };
}

function receiveControlSocketMessage(
    { socket, socketToken, frameText }: ControlSocketMessage,
    dependencies: ControlSocketRouteDependencies
): void {
    if (frameText.left !== undefined) {
        const closeCode = frameText.left.status === 413 ? MESSAGE_TOO_BIG_CLOSE_CODE : UNSUPPORTED_DATA_CLOSE_CODE;
        socket.close(closeCode, frameText.left.message);
        return;
    }
    const parsed = parseControlClientMessage(frameText.right);
    if (!parsed.ok) {
        socket.close(UNSUPPORTED_DATA_CLOSE_CODE, parsed.error);
        return;
    }
    const envelope = parsed.envelope;
    const validSocket = envelope.kind === 'register'
        ? dependencies.agentSockets.isUnregisteredSocket(socket)
        : dependencies.agentSockets.isCurrentAgentSocket(socket, envelope);
    if (!validSocket) {
        socket.close(POLICY_VIOLATION_CLOSE_CODE, 'Control envelope does not belong to the current registered socket.');
        return;
    }
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
    socket: ControlAgentSocket,
    envelope: ControlClientEnvelope,
    { agentSockets, artifactRecorder, controlService, persistence }: ControlSocketRouteDependencies
): void {
    const command = 'commandId' in envelope && typeof envelope.commandId === 'string'
        ? controlService.snapshotCommand(envelope.runId, envelope.commandId)
        : undefined;
    agentSockets.acceptResultReleaseOutcome(socket, envelope);
    const received = controlService.receiveClientEnvelope(envelope);
    if (received.kind === 'register' && !received.accepted) {
        socket.close(POLICY_VIOLATION_CLOSE_CODE, 'Run is completed; register with another run id.');
        return;
    }
    if (received.accepted) {
        artifactRecorder.record(envelope, command);
    }
    if (received.kind === 'register') {
        agentSockets.register(socket, { runId: received.runId, agentId: received.agentId });
    }
    if (received.affectsDispatch) {
        agentSockets.sendDispatchableCommandsForRun(received.runId);
    }
    persistence.persist();
}

/** Bun delivers text frames as strings and binary frames as `Buffer`; the decoder reads string or `ArrayBuffer`. */
function toControlFrameText(frame: string | Buffer): string | ArrayBuffer {
    if (typeof frame === 'string') {
        return frame;
    }
    return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
}
