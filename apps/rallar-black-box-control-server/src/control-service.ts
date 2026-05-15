import type {
    ControlClientEnvelope,
    ControlCommandEnvelope,
    ControlEventEnvelope,
    ControlHeartbeatEnvelope,
    ControlRegisterEnvelope,
    ControlResultEnvelope,
} from '../../rallar-black-box/src/control-protocol.ts';
import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '../../rallar-black-box/src/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestRedactionOptions,
} from '@shared-test/rallar-bb-test/types.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';

export type EnqueueControlCommandInput = Readonly<{
    runId: string;
    agentId: string;
    commandId?: string;
    command: RallarBlackBoxTestCommand;
    deadlineEpochMs?: number;
}>;

export type RallarBlackBoxControlServiceOptions = Readonly<{
    now?: () => number;
    commandIdFactory?: () => string;
    redaction?: RallarBlackBoxTestRedactionOptions;
    allowedCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
    commandRateLimitMax?: number;
    commandRateLimitWindowMs?: number;
    runTokenTtlMs?: number;
}>;

export type ControlRunToken = Readonly<{
    runId: string;
    agentId: string;
    token: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export type RallarBlackBoxControlServiceReceiveResult = Readonly<{
    kind: ControlClientEnvelope['kind'];
    runId: string;
    agentId: string;
}>;

export type ControlQueuedCommandSnapshot = Readonly<{
    envelope: ControlCommandEnvelope;
    queuedAtEpochMs: number;
    dispatchedAtEpochMs?: number;
    completedAtEpochMs?: number;
    dispatchCount: number;
}>;

export type ControlAgentSnapshot = Readonly<{
    runId: string;
    agentId: string;
    connected: boolean;
    registeredAtEpochMs?: number;
    disconnectedAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    status?: string;
    connectionSequence: number;
    reconnectCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    completedCommandIds: readonly string[];
    resumeCompletedCommandIds: readonly string[];
}>;

export type ControlRunSnapshot = Readonly<{
    runId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    agents: readonly ControlAgentSnapshot[];
    commands: readonly ControlQueuedCommandSnapshot[];
    results: readonly ControlResultEnvelope[];
    events: readonly ControlEventEnvelope[];
    stats: readonly ControlEventEnvelope[];
    reports: readonly ControlEventEnvelope[];
    heartbeats: readonly ControlHeartbeatEnvelope[];
}>;

export type ControlServerSnapshot = Readonly<{
    runs: readonly ControlRunSnapshot[];
}>;

type StoredCommand = {
    envelope: ControlCommandEnvelope;
    fingerprint: string;
    queuedAtEpochMs: number;
    dispatchedAtEpochMs?: number;
    completedAtEpochMs?: number;
    dispatchCount: number;
    lastDispatchedConnectionSequence?: number;
};

type StoredAgent = {
    runId: string;
    agentId: string;
    connected: boolean;
    registeredAtEpochMs?: number;
    disconnectedAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    status?: string;
    connectionSequence: number;
    reconnectCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    completedCommandIds: Set<string>;
    resumeCompletedCommandIds: Set<string>;
    commandEnqueueTimestamps: number[];
};

type StoredToken = {
    runId: string;
    agentId: string;
    token: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
};

type StoredRun = {
    runId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    agents: Map<string, StoredAgent>;
    commands: Map<string, StoredCommand>;
    results: Map<string, ControlResultEnvelope>;
    events: ControlEventEnvelope[];
    stats: ControlEventEnvelope[];
    reports: ControlEventEnvelope[];
    heartbeats: ControlHeartbeatEnvelope[];
    tokens: Map<string, StoredToken>;
};

export class RallarBlackBoxControlService {
    private readonly now: () => number;
    private readonly commandIdFactory: () => string;
    private readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
    private readonly allowedCommandKinds: Set<RallarBlackBoxTestCommandKind> | undefined;
    private readonly commandRateLimitMax: number;
    private readonly commandRateLimitWindowMs: number;
    private readonly runTokenTtlMs: number;
    private readonly runs = new Map<string, StoredRun>();

    constructor(options: RallarBlackBoxControlServiceOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.commandIdFactory = options.commandIdFactory ?? (() => crypto.randomUUID());
        this.redaction = options.redaction;
        this.allowedCommandKinds = options.allowedCommandKinds
            ? new Set(options.allowedCommandKinds)
            : undefined;
        this.commandRateLimitMax = options.commandRateLimitMax ?? 120;
        this.commandRateLimitWindowMs = options.commandRateLimitWindowMs ?? 60_000;
        this.runTokenTtlMs = options.runTokenTtlMs ?? 15 * 60_000;
    }

    receiveClientEnvelope(
        envelope: ControlClientEnvelope,
    ): RallarBlackBoxControlServiceReceiveResult {
        switch (envelope.kind) {
            case 'register':
                this.register(envelope);
                break;
            case 'heartbeat':
                this.receiveHeartbeat(envelope);
                break;
            case 'result':
                this.receiveResult(envelope);
                break;
            case 'event':
            case 'diagnostic':
            case 'stats':
            case 'report':
                this.receiveEvent(envelope);
                break;
        }

        return {
            kind: envelope.kind,
            runId: envelope.runId,
            agentId: envelope.agentId,
        };
    }

    enqueueCommand(input: EnqueueControlCommandInput): ControlCommandEnvelope {
        const run = this.ensureRun(input.runId);
        const agent = this.ensureAgent(run, input.agentId);
        this.assertCommandAllowed(input.command.kind);
        const commandId = input.commandId ?? this.commandIdFactory();
        const envelope: ControlCommandEnvelope = {
            kind: 'command',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: input.runId,
            agentId: input.agentId,
            commandId,
            command: input.command,
            deadlineEpochMs: input.deadlineEpochMs,
        };
        const fingerprint = this.commandFingerprint(envelope);
        const existing = run.commands.get(commandId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) {
                throw new Error(`Command ${commandId} already exists with a different payload.`);
            }
            return existing.envelope;
        }

        this.assertCommandRateLimit(agent);
        run.commands.set(commandId, {
            envelope,
            fingerprint,
            queuedAtEpochMs: this.now(),
            dispatchCount: 0,
        });
        this.touch(run);
        return envelope;
    }

    issueRunToken(
        input: Readonly<{
            runId: string;
            agentId: string;
            ttlMs?: number;
        }>,
    ): ControlRunToken {
        const run = this.ensureRun(input.runId);
        this.ensureAgent(run, input.agentId);
        const issuedAtEpochMs = this.now();
        const token: StoredToken = {
            runId: input.runId,
            agentId: input.agentId,
            token: crypto.randomUUID(),
            issuedAtEpochMs,
            expiresAtEpochMs: issuedAtEpochMs + Math.max(1, input.ttlMs ?? this.runTokenTtlMs),
        };
        run.tokens.set(token.token, token);
        this.touch(run);
        return token;
    }

    hasActiveRunToken(runId: string, agentId: string): boolean {
        const run = this.runs.get(runId);
        if (!run) {
            return false;
        }

        const now = this.now();
        return Array.from(run.tokens.values())
            .some(token =>
                token.agentId === agentId &&
                token.expiresAtEpochMs > now
            );
    }

    validateRunToken(
        runId: string,
        agentId: string,
        token: string | undefined,
    ): boolean {
        if (!token) {
            return false;
        }

        const stored = this.runs.get(runId)?.tokens.get(token);
        return Boolean(
            stored &&
                stored.agentId === agentId &&
                stored.expiresAtEpochMs > this.now(),
        );
    }

    takeDispatchableCommands(runId: string, agentId: string): readonly ControlCommandEnvelope[] {
        const run = this.runs.get(runId);
        const agent = run?.agents.get(agentId);
        if (!run || !agent?.connected) {
            return [];
        }

        const dispatchable: ControlCommandEnvelope[] = [];
        for (const command of run.commands.values()) {
            if (command.envelope.agentId !== agentId) {
                continue;
            }
            if (command.completedAtEpochMs !== undefined) {
                continue;
            }
            if (agent.resumeCompletedCommandIds.has(command.envelope.commandId)) {
                continue;
            }
            if (command.lastDispatchedConnectionSequence === agent.connectionSequence) {
                continue;
            }

            command.dispatchedAtEpochMs = this.now();
            command.lastDispatchedConnectionSequence = agent.connectionSequence;
            command.dispatchCount += 1;
            dispatchable.push(command.envelope);
        }

        if (dispatchable.length > 0) {
            this.touch(run);
        }
        return dispatchable;
    }

    markAgentDisconnected(runId: string, agentId: string): void {
        const run = this.runs.get(runId);
        const agent = run?.agents.get(agentId);
        if (!run || !agent) {
            return;
        }

        agent.connected = false;
        agent.disconnectedAtEpochMs = this.now();
        agent.lastSeenAtEpochMs = agent.disconnectedAtEpochMs;
        this.touch(run);
    }

    snapshot(): ControlServerSnapshot {
        return {
            runs: Array.from(this.runs.values(), (run) => this.snapshotRunValue(run)),
        };
    }

    snapshotRun(runId: string): ControlRunSnapshot | undefined {
        const run = this.runs.get(runId);
        return run ? this.snapshotRunValue(run) : undefined;
    }

    private register(envelope: ControlRegisterEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        const reconnecting = agent.registeredAtEpochMs !== undefined && !agent.connected;
        agent.connected = true;
        agent.registeredAtEpochMs = envelope.atEpochMs;
        agent.disconnectedAtEpochMs = undefined;
        agent.lastSeenAtEpochMs = this.now();
        agent.connectionSequence += 1;
        if (reconnecting) {
            agent.reconnectCount += 1;
        }
        agent.resumeCompletedCommandIds = new Set(envelope.resume.completedCommandIds);
        this.touch(run);
    }

    private receiveHeartbeat(envelope: ControlHeartbeatEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        agent.lastHeartbeatAtEpochMs = envelope.atEpochMs;
        agent.lastSeenAtEpochMs = this.now();
        agent.status = envelope.status;
        run.heartbeats.push(envelope);
        this.touch(run);
    }

    private receiveResult(envelope: ControlResultEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        agent.receivedResultCount += 1;
        agent.lastSeenAtEpochMs = this.now();
        agent.completedCommandIds.add(envelope.commandId);
        agent.resumeCompletedCommandIds.delete(envelope.commandId);
        run.results.set(envelope.commandId, envelope);

        const command = run.commands.get(envelope.commandId);
        if (command) {
            command.completedAtEpochMs = this.now();
        }
        this.touch(run);
    }

    private receiveEvent(envelope: ControlEventEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        const storedEnvelope = envelope.kind === 'report'
            ? this.redactReportEnvelope(envelope)
            : envelope;
        agent.receivedEventCount += 1;
        agent.lastSeenAtEpochMs = this.now();
        run.events.push(storedEnvelope);
        if (storedEnvelope.kind === 'stats') {
            run.stats.push(storedEnvelope);
        }
        if (storedEnvelope.kind === 'report') {
            run.reports.push(storedEnvelope);
        }
        this.touch(run);
    }

    private redactReportEnvelope(envelope: ControlEventEnvelope): ControlEventEnvelope {
        return {
            ...envelope,
            payload: redactRallarBlackBoxValue(envelope.payload, this.redaction),
        };
    }

    private assertCommandAllowed(kind: RallarBlackBoxTestCommandKind): void {
        if (!this.allowedCommandKinds || this.allowedCommandKinds.has(kind)) {
            return;
        }

        throw new Error(`Command kind is not allowed: ${kind}.`);
    }

    private assertCommandRateLimit(agent: StoredAgent): void {
        if (this.commandRateLimitMax <= 0) {
            return;
        }

        const now = this.now();
        const windowStart = now - this.commandRateLimitWindowMs;
        agent.commandEnqueueTimestamps = agent.commandEnqueueTimestamps
            .filter(timestamp => timestamp >= windowStart);
        if (agent.commandEnqueueTimestamps.length >= this.commandRateLimitMax) {
            throw new Error('Command rate limit exceeded.');
        }

        agent.commandEnqueueTimestamps.push(now);
    }

    private commandFingerprint(envelope: ControlCommandEnvelope): string {
        return JSON.stringify({
            command: envelope.command,
            deadlineEpochMs: envelope.deadlineEpochMs,
        });
    }

    private ensureRun(runId: string): StoredRun {
        const existing = this.runs.get(runId);
        if (existing) {
            return existing;
        }

        const now = this.now();
        const run: StoredRun = {
            runId,
            createdAtEpochMs: now,
            updatedAtEpochMs: now,
            agents: new Map(),
            commands: new Map(),
            results: new Map(),
            events: [],
            stats: [],
            reports: [],
            heartbeats: [],
            tokens: new Map(),
        };
        this.runs.set(runId, run);
        return run;
    }

    private ensureAgent(run: StoredRun, agentId: string): StoredAgent {
        const existing = run.agents.get(agentId);
        if (existing) {
            return existing;
        }

        const agent: StoredAgent = {
            runId: run.runId,
            agentId,
            connected: false,
            connectionSequence: 0,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: new Set(),
            resumeCompletedCommandIds: new Set(),
            commandEnqueueTimestamps: [],
        };
        run.agents.set(agentId, agent);
        this.touch(run);
        return agent;
    }

    private touch(run: StoredRun): void {
        run.updatedAtEpochMs = this.now();
    }

    private snapshotRunValue(run: StoredRun): ControlRunSnapshot {
        return {
            runId: run.runId,
            createdAtEpochMs: run.createdAtEpochMs,
            updatedAtEpochMs: run.updatedAtEpochMs,
            agents: Array.from(run.agents.values(), (agent) => ({
                runId: agent.runId,
                agentId: agent.agentId,
                connected: agent.connected,
                registeredAtEpochMs: agent.registeredAtEpochMs,
                disconnectedAtEpochMs: agent.disconnectedAtEpochMs,
                lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
                lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
                status: agent.status,
                connectionSequence: agent.connectionSequence,
                reconnectCount: agent.reconnectCount,
                receivedResultCount: agent.receivedResultCount,
                receivedEventCount: agent.receivedEventCount,
                completedCommandIds: Array.from(agent.completedCommandIds),
                resumeCompletedCommandIds: Array.from(agent.resumeCompletedCommandIds),
            })),
            commands: Array.from(run.commands.values(), (command) => ({
                envelope: command.envelope,
                queuedAtEpochMs: command.queuedAtEpochMs,
                dispatchedAtEpochMs: command.dispatchedAtEpochMs,
                completedAtEpochMs: command.completedAtEpochMs,
                dispatchCount: command.dispatchCount,
            })),
            results: Array.from(run.results.values()),
            events: [...run.events],
            stats: [...run.stats],
            reports: [...run.reports],
            heartbeats: [...run.heartbeats],
        };
    }
}

export function createRallarBlackBoxControlService(
    options: RallarBlackBoxControlServiceOptions = {},
): RallarBlackBoxControlService {
    return new RallarBlackBoxControlService(options);
}
