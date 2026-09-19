import type { RallarBlackBoxDistributedTargetResolution } from '../distributed-run.ts';

export type DistributedRecipeTargetStatus =
    | 'matched'
    | 'duplicate-session'
    | 'stale'
    | 'offline'
    | 'different-group'
    | 'missing-identity'
    | 'missing-crdt-runtime'
    | 'missing-assertion-capability'
    | 'missing-crdt-transport';

export type DistributedRecipeTargetRow = Readonly<{
    agentId: string;
    connected: boolean;
    status: DistributedRecipeTargetStatus;
    targetable: boolean;
    reason: string;
    principalId?: string;
    sessionId?: string;
    groupId?: string;
    applicationId?: string;
    workspaceId?: string;
    crdtSupported?: boolean;
    crdtTransports?: readonly string[];
    lastHeartbeatAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
}>;

export type DistributedWorldFleetTargetGate = Readonly<{
    usesWorldFleetTargets: boolean;
    targetResolution?: RallarBlackBoxDistributedTargetResolution;
    expectedParticipantCount?: number;
    previewSelected?: number;
    blocked: boolean;
    blockReason?: string;
}>;
