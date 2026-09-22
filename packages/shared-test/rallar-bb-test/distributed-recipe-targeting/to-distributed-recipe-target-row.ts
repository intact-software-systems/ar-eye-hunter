import type { ControlAgentSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import {
    toMissingAssertionCapabilityReason,
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

    const blockedStatus = toBlockedTargetStatus({
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
    if (blockedStatus) {
        return { ...base, ...blockedStatus };
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
        return createBlockedTargetStatus('missing-identity', 'Agent has not reported enough Rallar identity metadata.');
    }
    if (
        identity.applicationId !== group.applicationId ||
        identity.workspaceId !== group.workspaceId ||
        identity.groupId !== group.groupId
    ) {
        return createBlockedTargetStatus('different-group', 'Agent identity does not match the selected global group.');
    }
    if (!input.connected) {
        return createBlockedTargetStatus(
            'offline',
            'Agent matches the group but is disconnected from the control server.'
        );
    }
    if (input.stale) {
        return createBlockedTargetStatus('stale', 'Agent matches the group but the last heartbeat is stale.');
    }
    return toUnmetCapabilityStatus(input);
}

function toUnmetCapabilityStatus(
    input: BlockedTargetStatusInput
): BlockedTargetStatus | undefined {
    if (input.requiresCrdtRuntime && !input.crdtSupported) {
        return createBlockedTargetStatus(
            'missing-crdt-runtime',
            'Agent matches the group but has not reported a CRDT runtime.'
        );
    }

    const missingCrdtTransport = input.requiredCrdtTransports
        .find((transport) => !input.crdtTransports.includes(transport));
    if (missingCrdtTransport) {
        return createBlockedTargetStatus(
            'missing-crdt-transport',
            `Agent CRDT runtime does not report ${missingCrdtTransport} transport support.`
        );
    }

    const missingAssertionCapabilities = validateAgentAssertionCapability(
        input.requiredAssertionFeatures,
        input.identity?.capabilities
    );
    return missingAssertionCapabilities.length > 0
        ? createBlockedTargetStatus(
            'missing-assertion-capability',
            toMissingAssertionCapabilityReason(missingAssertionCapabilities)
        )
        : undefined;
}

function createBlockedTargetStatus(
    status: DistributedRecipeTargetRow['status'],
    reason: string
): BlockedTargetStatus {
    return { status, targetable: false, reason };
}
