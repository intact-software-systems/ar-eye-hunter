import { isSameGroupLayoutIdentity, toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { computeTopologyPromotionEntry } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '../../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';

/**
 * The route-less promotion producer's read surface (decision 27): present
 * only when a consumer is installed, and enqueueing only for groups whose
 * topology policy lands reconfigurations with `apply`.
 */
export interface TopologyPromotionPublicationPort {
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    /** The current group facts, never the work payload's enqueue-time copy. */
    readonly findCurrentGroup: (ref: GroupRef) => Promise<Group | null>;
}

export interface ReadTopologyPromotionRequestInput {
    readonly publication: TopologyPromotionPublicationPort | undefined;
    readonly serviceId: string | undefined;
    readonly entry: ResourceEntry;
    readonly target: RallarOverlayTopologySnapshot | null;
}

/**
 * Decision 27's gate, read BEFORE the publication transaction opens: the
 * port's group and policy reads run on the shared database handle, and a
 * single-session backend (PGlite) deadlocks if they run while the
 * transaction holds that session. Every gate fact is read fresh here — the
 * current group snapshot, never the work payload's enqueue-time copy — and
 * the read also reconciles: an entry is produced whenever the group's
 * accepted identity trails the target layout, so a cycle that once saw a
 * stale stage heals on the next pass. The cheap checks run before the
 * policy read; hold promotes only through activate; a corrupt policy and an
 * absent consumer port fail closed; and the entry never expires, so an
 * outbox backlog delays a promotion but cannot drop it.
 */
export async function readTopologyPromotionRequest(
    input: ReadTopologyPromotionRequestInput
): Promise<ResourceEntry | null> {
    const { publication, target } = input;
    if (!publication || target === null || target.state !== 'active') {
        return null;
    }
    const group = await publication.findCurrentGroup(target.groupRef);
    if (group === null || group.lifecycleState !== 'active') {
        return null;
    }
    const targetIdentity = toGroupLayoutIdentity(target);
    if (
        group.acceptedLayoutIdentity !== null &&
        isSameGroupLayoutIdentity(group.acceptedLayoutIdentity, targetIdentity)
    ) {
        return null;
    }
    const policyRead = await publication.readLifecyclePolicy(target.groupRef);
    if (policyRead.status === 'corrupt') {
        return null;
    }
    const policy = policyRead.status === 'present'
        ? policyRead.policy
        : createDefaultGroupLifecyclePolicy();
    if (policy.topology.reconfigureLanding !== 'apply') {
        return null;
    }
    return computeTopologyPromotionEntry({
        work: {
            groupRef: target.groupRef,
            formationEpoch: group.formationEpoch,
            expectedLayout: targetIdentity
        },
        senderId: input.serviceId ?? 'topology-promotion',
        createdAtEpochMs: input.entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds,
        expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS
    });
}

/**
 * The durable half, inside the publication transaction: the mint commits or
 * rolls back with the row it promotes (decision 27's atomicity).
 */
export async function writeTopologyPromotionRequest(
    transaction: PSqlSql,
    requestEntry: ResourceEntry | null
): Promise<void> {
    if (requestEntry === null) {
        return;
    }
    await new PSqlResourceInboxEntryRepository(transaction).writeIfAbsentOrMatch(requestEntry);
}
