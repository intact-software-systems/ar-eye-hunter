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

    const blocked = toBlockedTargetStatus({
        identity,
        group,
        connected: agent.connected,
        stale,
        requiresCrdtRuntime,
        requiredCrdtTransports,
        crdtSupported: crdt?.supported,
        crdtTransports,
        requiredAssertionFeatures: input.requiredAssertionFeatures
    });
    if (blocked) {
        return { ...base, ...blocked };
    }

    return {
        ...base,
        status: 'matched',
        targetable: true,
        reason: 'Agent is connected and reports the selected global group.'
    };
}

type BlockedTargetStatus = Readonly<{
    status: DistributedRecipeTargetRow['status'];
    targetable: false;
    reason: string;
}>;

/**
 * Status precedence: identity, then group scope, then connection, then staleness,
 * then CRDT runtime and transport, then assertion capability.
 */
interface BlockedTargetStatusInput {
    readonly identity: ControlAgentSnapshot['identity'];
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly connected: boolean;
    readonly stale: boolean;
    readonly requiresCrdtRuntime: boolean;
    readonly requiredCrdtTransports: readonly RallarBlackBoxTestCrdtTransport[];
    readonly crdtSupported: boolean | undefined;
    readonly crdtTransports: readonly RallarBlackBoxTestCrdtTransport[];
    readonly requiredAssertionFeatures: DistributedAssertionFeatures;
}

function toBlockedTargetStatus(
    input: BlockedTargetStatusInput
): BlockedTargetStatus | undefined {
    const { identity, group } = input;
    if (!identity?.applicationId || !identity.workspaceId || !identity.groupId) {
        return blocked('missing-identity', 'Agent has not reported enough Rallar identity metadata.');
    }
    if (
        identity.applicationId !== group.applicationId ||
        identity.workspaceId !== group.workspaceId ||
        identity.groupId !== group.groupId
    ) {
        return blocked('different-group', 'Agent identity does not match the selected global group.');
    }
    if (!input.connected) {
        return blocked('offline', 'Agent matches the group but is disconnected from the control server.');
    }
    if (input.stale) {
        return blocked('stale', 'Agent matches the group but the last heartbeat is stale.');
    }
    return toUnmetCapabilityStatus(input);
}

function toUnmetCapabilityStatus(
    input: BlockedTargetStatusInput
): BlockedTargetStatus | undefined {
    if (input.requiresCrdtRuntime && !input.crdtSupported) {
        return blocked('missing-crdt-runtime', 'Agent matches the group but has not reported a CRDT runtime.');
    }

    const missingCrdtTransport = input.requiredCrdtTransports
        .find((transport) => !input.crdtTransports.includes(transport));
    if (missingCrdtTransport) {
        return blocked(
            'missing-crdt-transport',
            `Agent CRDT runtime does not report ${missingCrdtTransport} transport support.`
        );
    }

    const unmetAssertionReason = validateAgentAssertionCapability(
        input.requiredAssertionFeatures,
        input.identity?.capabilities
    );
    return unmetAssertionReason
        ? blocked('missing-assertion-capability', unmetAssertionReason)
        : undefined;
}

function blocked(
    status: DistributedRecipeTargetRow['status'],
    reason: string
): BlockedTargetStatus {
    return { status, targetable: false, reason };
}
