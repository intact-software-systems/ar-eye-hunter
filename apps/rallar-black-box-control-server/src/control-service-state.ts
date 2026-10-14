import type {
    ControlBarrierFailureReason,
    ControlBarrierResolution
} from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import type {
    ControlCommandEnvelope,
    ControlEventEnvelope,
    ControlHeartbeatEnvelope,
    ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunState,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxDistributedRunRollup
} from '@shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';

export interface ControlCommandState {
    envelope: ControlCommandEnvelope;
    fingerprint: string;
    queuedAtEpochMs: number;
    dispatchedAtEpochMs?: number;
    completedAtEpochMs?: number;
    dispatchCount: number;
    lastDispatchedConnectionSequence?: number;
}

export interface ControlAgentState {
    runId: string;
    agentId: string;
    connected: boolean;
    registeredAtEpochMs?: number;
    disconnectedAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    status?: string;
    identity?: RallarBlackBoxControlAgentIdentity;
    connectionSequence: number;
    reconnectCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    completedCommandIds: Set<string>;
    resumeCompletedCommandIds: Set<string>;
    commandEnqueueTimestamps: number[];
}

export interface ControlTokenState {
    runId: string;
    agentId: string;
    token: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}

export interface ControlRunState {
    runId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    agents: Map<string, ControlAgentState>;
    commands: Map<string, ControlCommandState>;
    results: Map<string, ControlResultEnvelope>;
    events: ControlEventEnvelope[];
    stats: ControlEventEnvelope[];
    reports: ControlEventEnvelope[];
    reportKeys: Set<string>;
    heartbeats: ControlHeartbeatEnvelope[];
    tokens: Map<string, ControlTokenState>;
    retentionRevision: number;
    issuedRunTokenStateRevision: number;
    barriers: Map<string, ControlRecipeBarrierState>;
}

export interface ControlRecipeBarrierParticipant {
    readonly agentId: string;
    /** Its distributed start root: a failed result ends the barrier for the agents that arrived. */
    readonly startCommandId: string;
}

/** One recipe barrier of a control run, in memory only: a restarted control server forgets it. */
export interface ControlRecipeBarrierState {
    readonly barrierId: string;
    readonly timeoutMs: number;
    /** The authored participant roles, sorted and JSON-encoded, or `every-started-agent`; arrivals must agree. */
    readonly authoredParticipants: string;
    readonly participants: readonly ControlRecipeBarrierParticipant[];
    readonly openedAtEpochMs: number;
    readonly arrivedAgentIds: readonly string[];
    /** Undefined until an arrival makes the barrier unpassable. */
    readonly issue: ControlBarrierFailureReason | undefined;
    /** Undefined until every participant arrived or the barrier failed; then it never changes. */
    readonly resolution: ControlBarrierResolution | undefined;
    /** An outsider or disagreeing agent that arrived after the resolution fails alone; the verdict stands for the rest. */
    readonly lateArrivalIssues: Readonly<Record<string, ControlBarrierFailureReason>>;
    readonly deliveredConnectionSequences: Readonly<Record<string, number>>;
}

export interface ControlDistributedRunState {
    distributedRunId: string;
    controlRunId: string;
    manifest: RallarBlackBoxDistributedRunManifest;
    state: RallarBlackBoxDistributedRunState;
    rollup?: RallarBlackBoxDistributedRunRollup;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    stagedAtEpochMs?: number;
    barrierStartedAtEpochMs?: number;
    barrierCompletedAtEpochMs?: number;
    startedAtEpochMs?: number;
    cancelledAtEpochMs?: number;
    completedAtEpochMs?: number;
    targetAgentIds: string[];
    targetResolution?: RallarBlackBoxDistributedTargetResolution;
    commandLinks: ControlDistributedRunCommandLink[];
    error?: ControlDistributedRunSnapshot['error'];
}

export function toInitialControlAgentState(runId: string, agentId: string): ControlAgentState {
    return {
        runId,
        agentId,
        connected: false,
        connectionSequence: 0,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: new Set(),
        resumeCompletedCommandIds: new Set(),
        commandEnqueueTimestamps: []
    };
}

export function toInitialControlRunState(runId: string, nowEpochMs: number): ControlRunState {
    return {
        runId,
        createdAtEpochMs: nowEpochMs,
        updatedAtEpochMs: nowEpochMs,
        agents: new Map(),
        commands: new Map(),
        results: new Map(),
        events: [],
        stats: [],
        reports: [],
        reportKeys: new Set(),
        heartbeats: [],
        tokens: new Map(),
        retentionRevision: 0,
        issuedRunTokenStateRevision: 0,
        barriers: new Map()
    };
}

export function toInitialControlDistributedRunState(
    manifest: RallarBlackBoxDistributedRunManifest,
    controlRunId: string,
    nowEpochMs: number
): ControlDistributedRunState {
    return {
        distributedRunId: manifest.distributedRunId,
        controlRunId,
        manifest,
        state: 'draft',
        createdAtEpochMs: nowEpochMs,
        updatedAtEpochMs: nowEpochMs,
        targetAgentIds: [],
        commandLinks: []
    };
}
