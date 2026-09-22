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
    'recordDuplicateAgentSocketReplacement' | 'takeDispatchableCommands'
>;

const OPEN_SOCKET_STATE = 1;
const DUPLICATE_AGENT_CLOSE_CODE = 4000;
const RUN_DELETED_CLOSE_CODE = 1000;

export class ControlAgentSockets {
    private readonly controlService: ControlAgentSocketService;
    private readonly socketsByRun = new Map<string, Map<string, ControlAgentSocket>>();
    private readonly agentBySocket = new WeakMap<ControlAgentSocket, ControlAgentIdentity>();

    constructor(controlService: ControlAgentSocketService) {
        this.controlService = controlService;
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
        const socket = this.socketsByRun.get(agent.runId)?.get(agent.agentId);
        if (!socket || socket.readyState !== OPEN_SOCKET_STATE) {
            return;
        }
        for (const command of this.controlService.takeDispatchableCommands(agent.runId, agent.agentId)) {
            socket.send(JSON.stringify(command));
        }
    }

    sendDispatchableCommandsForRun(runId: string): void {
        for (const agentId of this.socketsByRun.get(runId)?.keys() ?? []) {
            this.sendDispatchableCommands({ runId, agentId });
        }
    }
}
