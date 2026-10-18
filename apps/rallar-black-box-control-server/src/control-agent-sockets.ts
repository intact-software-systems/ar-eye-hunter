import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlClientEnvelope,
    type ControlEventEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ResultReleaseEnvelope,
    ResultReleaseOutcome
} from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import { toCommandIdSegment } from './control-command-queue-policy.ts';
import type { RallarBlackBoxControlService } from './control-service.ts';

export interface ControlAgentSocket {
    readonly readyState: number;
    send(text: string): void;
    close(code: number, reason: string): void;
}

export interface ControlAgentIdentity {
    readonly runId: string;
    readonly agentId: string;
}

export type ControlAgentSocketService = Pick<
    RallarBlackBoxControlService,
    'recordDuplicateAgentSocketReplacement' | 'takeDispatchableCommandsForAgents' | 'takeBarrierResolutions'
>;

interface PendingResultRelease {
    readonly socket: ControlAgentSocket;
    readonly finish: (outcome: Either<string, ResultReleaseOutcome>) => void;
}

const OPEN_SOCKET_STATE = 1;
const DUPLICATE_AGENT_CLOSE_CODE = 4000;
const RUN_DELETED_CLOSE_CODE = 1000;

export class ControlAgentSockets {
    private readonly resultReleases = new Map<string, PendingResultRelease>();
    private readonly controlService: ControlAgentSocketService;
    private readonly socketsByRun = new Map<string, Map<string, ControlAgentSocket>>();
    private readonly agentBySocket = new WeakMap<ControlAgentSocket, ControlAgentIdentity>();

    constructor(controlService: ControlAgentSocketService) {
        this.controlService = controlService;
    }

    requestResultRelease(
        request: ResultReleaseEnvelope,
        signal: AbortSignal
    ): Promise<Either<string, ResultReleaseOutcome>> {
        const socket = this.socketsByRun.get(request.runId)?.get(request.agentId);
        if (
            !socket || socket.readyState !== OPEN_SOCKET_STATE || signal.aborted ||
            this.resultReleases.has(request.requestId)
        ) {
            return Promise.resolve(
                Either.ofLeft('The agent is disconnected or the release request is already pending.')
            );
        }
        return new Promise((resolve) => {
            const finish = (outcome: Either<string, ResultReleaseOutcome>) => {
                signal.removeEventListener('abort', abort);
                this.resultReleases.delete(request.requestId);
                resolve(outcome);
            };
            const abort = () =>
                finish(Either.ofLeft('Browser result release was not acknowledged before the deadline.'));
            this.resultReleases.set(request.requestId, { socket, finish });
            signal.addEventListener('abort', abort, { once: true });
            try {
                socket.send(JSON.stringify(request));
            }
            catch (error) {
                finish(Either.ofLeft(error instanceof Error ? error.message : String(error)));
            }
        });
    }

    acceptResultReleaseOutcome(socket: ControlAgentSocket, envelope: ControlClientEnvelope): void {
        if (envelope.kind !== 'diagnostic' || !isJsonRecordValue(envelope.payload)) {
            return;
        }
        const outcome = envelope.payload;
        if (
            outcome.topic !== 'rallar.bb.results.release' || typeof outcome.requestId !== 'string' ||
            (outcome.status !== 'released' && outcome.status !== 'deferred' && outcome.status !== 'rejected') ||
            typeof outcome.reason !== 'string' || typeof outcome.releasedResults !== 'number'
        ) {
            return;
        }
        const pending = this.resultReleases.get(outcome.requestId);
        if (pending?.socket === socket && this.isCurrentAgentSocket(socket, envelope)) {
            pending.finish(
                Either.ofRight({
                    requestId: outcome.requestId,
                    status: outcome.status,
                    reason: outcome.reason,
                    releasedResults: outcome.releasedResults
                })
            );
        }
    }

    isUnregisteredSocket(socket: ControlAgentSocket): boolean {
        return !this.agentBySocket.has(socket);
    }

    isCurrentAgentSocket(socket: ControlAgentSocket, agent: ControlAgentIdentity): boolean {
        const registered = this.agentBySocket.get(socket);
        return registered?.runId === agent.runId && registered.agentId === agent.agentId &&
            this.socketsByRun.get(agent.runId)?.get(agent.agentId) === socket;
    }

    register(socket: ControlAgentSocket, agent: ControlAgentIdentity): void {
        const sockets = this.socketsByRun.get(agent.runId) ?? new Map<string, ControlAgentSocket>();
        const existing = sockets.get(agent.agentId);
        if (existing && existing !== socket) {
            this.controlService.recordDuplicateAgentSocketReplacement(agent.runId, agent.agentId);
            existing.close(DUPLICATE_AGENT_CLOSE_CODE, 'agent re-registered');
        }

        this.agentBySocket.set(socket, agent);
        sockets.set(agent.agentId, socket);
        this.socketsByRun.set(agent.runId, sockets);
    }

    release(socket: ControlAgentSocket): ControlAgentIdentity | undefined {
        const agent = this.agentBySocket.get(socket);
        if (!agent || this.socketsByRun.get(agent.runId)?.get(agent.agentId) !== socket) {
            return undefined;
        }
        for (const pending of this.resultReleases.values()) {
            if (pending.socket === socket) {
                pending.finish(Either.ofLeft('Agent disconnected before acknowledging result release.'));
            }
        }
        const sockets = this.socketsByRun.get(agent.runId)!;
        sockets.delete(agent.agentId);
        if (sockets.size === 0) {
            this.socketsByRun.delete(agent.runId);
        }
        return agent;
    }

    closeRun(runId: string): void {
        const sockets = this.socketsByRun.get(runId);
        this.socketsByRun.delete(runId);
        for (const socket of sockets?.values() ?? []) {
            try {
                socket.close(RUN_DELETED_CLOSE_CODE, 'run deleted');
            }
            catch (_error) {
                // Socket cleanup is best-effort when a run is removed.
            }
        }
    }

    sendDispatchableCommands(agent: ControlAgentIdentity): void {
        this.sendDispatchableCommandsToAgents(agent.runId, [agent.agentId]);
    }

    sendDispatchableCommandsForRun(runId: string): void {
        this.sendDispatchableCommandsToAgents(runId, [...this.socketsByRun.get(runId)?.keys() ?? []]);
    }

    /** The deadline sweep over every run with a registered socket; answers how many runs it swept. */
    sendDispatchableCommandsForConnectedRuns(): number {
        const runIds = [...this.socketsByRun.keys()];
        for (const runId of runIds) {
            this.sendDispatchableCommandsForRun(runId);
        }
        return runIds.length;
    }

    private sendDispatchableCommandsToAgents(runId: string, agentIds: readonly string[]): void {
        const sockets = this.socketsByRun.get(runId);
        const openSockets = new Map(agentIds.flatMap((agentId) => {
            const socket = sockets?.get(agentId);
            return socket?.readyState === OPEN_SOCKET_STATE ? [[agentId, socket] as const] : [];
        }));
        if (openSockets.size === 0) {
            return;
        }
        const commandsByAgentId = this.controlService.takeDispatchableCommandsForAgents(runId, [...openSockets.keys()]);
        for (const [agentId, socket] of openSockets) {
            for (const command of commandsByAgentId.get(agentId) ?? []) {
                socket.send(JSON.stringify(command));
            }
            for (const resolution of this.controlService.takeBarrierResolutions(runId, agentId)) {
                socket.send(JSON.stringify(resolution));
            }
        }
    }
}

/** The run-level record of a socket replaced by a later registration of the same agent. */
export function toDuplicateAgentSocketDiagnostic(
    runId: string,
    agentId: string,
    atEpochMs: number
): ControlEventEnvelope {
    return {
        kind: 'diagnostic',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId,
        agentId,
        atEpochMs,
        eventId: `duplicate-agent-socket-${toCommandIdSegment(agentId, 'segment')}-${atEpochMs}`,
        payload: {
            topic: 'rallar.bb.control.duplicate-agent-socket',
            severity: 'warning',
            message: 'Another websocket registered with the same runId and agentId; replacing the previous socket.',
            runId,
            agentId
        }
    };
}
