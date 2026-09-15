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
    private readonly socketByAgentKey = new Map<string, ControlAgentSocket>();
    private readonly agentBySocket = new WeakMap<ControlAgentSocket, ControlAgentIdentity>();

    constructor(controlService: ControlAgentSocketService) {
        this.controlService = controlService;
    }

    register(socket: ControlAgentSocket, agent: ControlAgentIdentity): void {
        const key = toAgentSocketKey(agent);
        const existing = this.socketByAgentKey.get(key);
        if (existing && existing !== socket) {
            this.controlService.recordDuplicateAgentSocketReplacement(agent.runId, agent.agentId);
            existing.close(DUPLICATE_AGENT_CLOSE_CODE, 'agent re-registered');
        }

        this.agentBySocket.set(socket, agent);
        this.socketByAgentKey.set(key, socket);
    }

    release(socket: ControlAgentSocket): ControlAgentIdentity | undefined {
        const agent = this.agentBySocket.get(socket);
        if (!agent || this.socketByAgentKey.get(toAgentSocketKey(agent)) !== socket) {
            return undefined;
        }
        this.socketByAgentKey.delete(toAgentSocketKey(agent));
        return agent;
    }

    closeRun(runId: string): void {
        for (const [key, socket] of this.socketByAgentKey.entries()) {
            if (!key.startsWith(toRunSocketKeyPrefix(runId))) {
                continue;
            }
            this.socketByAgentKey.delete(key);
            try {
                socket.close(RUN_DELETED_CLOSE_CODE, 'run deleted');
            }
            catch (_error) {
                // Socket cleanup is best-effort when a run is removed.
            }
        }
    }

    sendDispatchableCommands(agent: ControlAgentIdentity): void {
        const socket = this.socketByAgentKey.get(toAgentSocketKey(agent));
        if (!socket || socket.readyState !== OPEN_SOCKET_STATE) {
            return;
        }
        for (const command of this.controlService.takeDispatchableCommands(agent.runId, agent.agentId)) {
            socket.send(JSON.stringify(command));
        }
    }

    sendDispatchableCommandsForRun(runId: string): void {
        const prefix = toRunSocketKeyPrefix(runId);
        const agentIds = Array.from(this.socketByAgentKey.keys())
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length));
        for (const agentId of agentIds) {
            this.sendDispatchableCommands({ runId, agentId });
        }
    }
}

function toAgentSocketKey({ runId, agentId }: ControlAgentIdentity): string {
    return `${toRunSocketKeyPrefix(runId)}${agentId}`;
}

function toRunSocketKeyPrefix(runId: string): string {
    return `${runId}\u0000`;
}
