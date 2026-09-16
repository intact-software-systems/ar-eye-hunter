import type { ControlAgentSnapshot, ControlRunSnapshot } from '../control-snapshots.ts';
import {
    distributedRecipeCommandKinds,
    distributedRecipeCrdtTransports,
    hasCrdtCommandKind
} from '../distributed-recipe-preflight/distributed-recipe-command-preview.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import { collectDistributedAssertionFeatures } from '../distributed/control-agent-capabilities.ts';
import { toUniqueSortedValues } from '../distributed/to-unique-sorted-values.ts';
import type {
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestRecipe
} from '../rallar-black-box-test-contracts.ts';
import type {
    DistributedRecipeTargetRow,
    DistributedRecipeTargetStatus
} from './distributed-recipe-target-contracts.ts';
import { toDistributedRecipeTargetRow } from './to-distributed-recipe-target-row.ts';

export function distributedRecipeTargetRows(
    input: Readonly<{
        run: ControlRunSnapshot | undefined;
        group: RallarBlackBoxDistributedGroupRef;
        requiredCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
        requiredRecipes?: readonly RallarBlackBoxTestRecipe[];
        nowEpochMs?: number;
        staleAfterMs?: number;
    }>
): readonly DistributedRecipeTargetRow[] {
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const staleAfterMs = input.staleAfterMs ?? 30_000;
    const agents = [...(input.run?.agents ?? [])]
        .sort((left, right) => left.agentId.localeCompare(right.agentId));
    const requiredCommandKinds = toUniqueSortedValues([
        ...(input.requiredCommandKinds ?? []),
        ...(input.requiredRecipes ?? []).flatMap(distributedRecipeCommandKinds)
    ]);
    const requiresCrdtRuntime = hasCrdtCommandKind(requiredCommandKinds);
    const requiredCrdtTransports = toUniqueSortedValues(
        (input.requiredRecipes ?? []).flatMap(distributedRecipeCrdtTransports)
    );
    const requiredAssertionFeatures = collectDistributedAssertionFeatures(
        input.requiredRecipes ?? []
    );
    const rows = agents.map((agent) =>
        toDistributedRecipeTargetRow({
            agent,
            group: input.group,
            nowEpochMs,
            staleAfterMs,
            requiresCrdtRuntime,
            requiredCrdtTransports,
            requiredAssertionFeatures
        })
    );
    return toDuplicateSessionTargetRows(rows, agents);
}

export function distributedRecipeTargetIdentityKey(
    agent: ControlAgentSnapshot
): string | undefined {
    const identity = agent.identity;
    const principal = toNormalizedIdentityPart(
        identity?.principalId ?? identity?.clientId ?? identity?.username
    );
    const session = toNormalizedIdentityPart(identity?.sessionId);
    const applicationId = toNormalizedIdentityPart(identity?.applicationId);
    const workspaceId = toNormalizedIdentityPart(identity?.workspaceId);
    const groupId = toNormalizedIdentityPart(identity?.groupId);

    if (!principal || !session || !applicationId || !workspaceId || !groupId) {
        return undefined;
    }

    return [applicationId, workspaceId, groupId, principal, session].join('\u0000');
}

export function defaultDistributedRecipeTargetIds(
    rows: readonly DistributedRecipeTargetRow[]
): readonly string[] {
    return rows
        .filter((row) => row.targetable)
        .map((row) => row.agentId);
}

export function reconcileDistributedRecipeTargetIds(
    selectedAgentIds: readonly string[],
    rows: readonly DistributedRecipeTargetRow[]
): readonly string[] {
    const defaults = defaultDistributedRecipeTargetIds(rows);
    const targetable = new Set(defaults);
    const retained = selectedAgentIds.filter((agentId) => targetable.has(agentId));
    return retained.length > 0 ? retained : defaults;
}

function isFreshGroupTargetStatus(status: DistributedRecipeTargetStatus): boolean {
    return status === 'matched' ||
        status === 'missing-crdt-runtime' ||
        status === 'missing-crdt-transport';
}

function toNormalizedIdentityPart(value: string | undefined): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim().toLowerCase()
        : undefined;
}

/**
 * Duplicate-session marking runs after status selection, so only fresh group targets
 * can be demoted.
 */
function toDuplicateSessionTargetRows(
    rows: readonly DistributedRecipeTargetRow[],
    agents: readonly ControlAgentSnapshot[]
): readonly DistributedRecipeTargetRow[] {
    const duplicateIdentityCounts = new Map<string, number>();

    rows.forEach((row, index) => {
        if (!isFreshGroupTargetStatus(row.status)) {
            return;
        }
        const identityKey = distributedRecipeTargetIdentityKey(agents[index]);
        if (identityKey) {
            duplicateIdentityCounts.set(
                identityKey,
                (duplicateIdentityCounts.get(identityKey) ?? 0) + 1
            );
        }
    });

    return rows.map((row, index) => {
        if (!isFreshGroupTargetStatus(row.status)) {
            return row;
        }
        const identityKey = distributedRecipeTargetIdentityKey(agents[index]);
        if (!identityKey || (duplicateIdentityCounts.get(identityKey) ?? 0) < 2) {
            return row;
        }
        return {
            ...row,
            status: 'duplicate-session',
            targetable: false,
            reason: 'Multiple fresh control agents report the same normalized Rallar identity and session.'
        };
    });
}
