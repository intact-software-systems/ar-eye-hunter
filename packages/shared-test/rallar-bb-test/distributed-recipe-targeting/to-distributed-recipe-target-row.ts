import type { ControlAgentSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import {
    validateAgentAssertionCapability,
    type DistributedAssertionFeatures
} from '../distributed/control-agent-capabilities.ts';
import type { RallarBlackBoxTestCrdtTransport } from '../rallar-black-box-test-contracts.ts';
import type { DistributedRecipeTargetRow } from './distributed-recipe-target-contracts.ts';

export interface ToDistributedRecipeTargetRowInput {
    readonly agent: ControlAgentSnapshot;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly nowEpochMs: number;
    readonly staleAfterMs: number;
    readonly requiresCrdtRuntime: boolean;
    readonly requiredCrdtTransports: readonly RallarBlackBoxTestCrdtTransport[];
    readonly requiredAssertionFeatures: DistributedAssertionFeatures;
}

export function toDistributedRecipeTargetRow(
    input: ToDistributedRecipeTargetRowInput
): DistributedRecipeTargetRow {
    const { agent, group, nowEpochMs, staleAfterMs, requiresCrdtRuntime, requiredCrdtTransports } = input;
    const identity = agent.identity;
    const crdt = identity?.capabilities?.crdt;
    const crdtTransports = crdt?.transports ?? [];
    const lastActiveAtEpochMs = agent.lastHeartbeatAtEpochMs ?? agent.lastSeenAtEpochMs ?? identity?.updatedAtEpochMs;
    const stale = typeof lastActiveAtEpochMs === 'number' && nowEpochMs - lastActiveAtEpochMs > staleAfterMs;
    const base = {
        agentId: agent.agentId,
        connected: agent.connected,
        principalId: identity?.principalId ?? identity?.clientId ?? identity?.username,
        sessionId: identity?.sessionId,
        groupId: identity?.groupId,
        applicationId: identity?.applicationId,
        workspaceId: identity?.workspaceId,
        crdtSupported: crdt?.supported,
        crdtTransports,
        lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
        lastSeenAtEpochMs: agent.lastSeenAtEpochMs
    };

    if (!identity?.applicationId || !identity.workspaceId || !identity.groupId) {
        return {
            ...base,
            status: 'missing-identity',
            targetable: false,
            reason: 'Agent has not reported enough Rallar identity metadata.'
        };
    }

    if (
        identity.applicationId !== group.applicationId ||
        identity.workspaceId !== group.workspaceId ||
        identity.groupId !== group.groupId
    ) {
        return {
            ...base,
            status: 'different-group',
            targetable: false,
            reason: 'Agent identity does not match the selected global group.'
        };
    }

    if (!agent.connected) {
        return {
            ...base,
            status: 'offline',
            targetable: false,
            reason: 'Agent matches the group but is disconnected from the control server.'
        };
    }

    if (stale) {
        return {
            ...base,
            status: 'stale',
            targetable: false,
            reason: 'Agent matches the group but the last heartbeat is stale.'
        };
    }

    if (requiresCrdtRuntime && !crdt?.supported) {
        return {
            ...base,
            status: 'missing-crdt-runtime',
            targetable: false,
            reason: 'Agent matches the group but has not reported a CRDT runtime.'
        };
    }

    const missingCrdtTransport = requiredCrdtTransports
        .find((transport) => !crdtTransports.includes(transport));
    if (missingCrdtTransport) {
        return {
            ...base,
            status: 'missing-crdt-transport',
            targetable: false,
            reason: `Agent CRDT runtime does not report ${missingCrdtTransport} transport support.`
        };
    }

    const unmetAssertionReason = validateAgentAssertionCapability(
        input.requiredAssertionFeatures,
        identity?.capabilities
    );
    if (unmetAssertionReason) {
        return {
            ...base,
            status: 'missing-assertion-capability',
            targetable: false,
            reason: unmetAssertionReason
        };
    }

    return {
        ...base,
        status: 'matched',
        targetable: true,
        reason: 'Agent is connected and reports the selected global group.'
    };
}
