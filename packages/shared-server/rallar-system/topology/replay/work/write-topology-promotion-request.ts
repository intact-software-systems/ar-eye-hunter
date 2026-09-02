import { isSameGroupLayoutIdentity, toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    validateAppInboxComputedProjection,
    type AppInboxComputedValidationIssue
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-computed-validation.ts';
import {
    computeAppOutboxInsertOrMatch,
    writeAppOutboxInsertOrMatch,
    type AppOutboxInsertOrMatch
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { computeTopologyPromotionEntry } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';

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
    readonly target: RallarOverlayTopologySnapshot | null;
}

export type TopologyPromotionRequestRead =
    | Readonly<{ status: 'not-requested'; }>
    | Readonly<{
        status: 'eligible';
        group: Group;
        policyRead: GroupLifecyclePolicyRead;
    }>;

export interface ComputeTopologyPromotionRequestInput {
    readonly serviceId: string | undefined;
    readonly entry: ResourceEntry;
    readonly target: RallarOverlayTopologySnapshot | null;
    readonly read: TopologyPromotionRequestRead;
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
 * policy read. The returned facts are not persistence data: the pure compute
 * step below owns entry construction and database-column materialization.
 */
export async function readTopologyPromotionRequest(
    input: ReadTopologyPromotionRequestInput
): Promise<TopologyPromotionRequestRead> {
    const { publication, target } = input;
    if (!publication || target === null || target.state !== 'active') {
        return { status: 'not-requested' };
    }
    const group = await publication.findCurrentGroup(target.groupRef);
    if (group === null || group.lifecycleState !== 'active') {
        return { status: 'not-requested' };
    }
    const targetIdentity = toGroupLayoutIdentity(target);
    if (
        group.acceptedLayoutIdentity !== null &&
        isSameGroupLayoutIdentity(group.acceptedLayoutIdentity, targetIdentity)
    ) {
        return { status: 'not-requested' };
    }
    const policyRead = await publication.readLifecyclePolicy(target.groupRef);
    return { status: 'eligible', group, policyRead };
}

/** Purely computes the exact ResourceInbox row consumed by the transaction. */
export function computeTopologyPromotionRequest(
    input: ComputeTopologyPromotionRequestInput
): AppOutboxInsertOrMatch | null {
    const { read, target } = input;
    if (read.status === 'not-requested' || target === null || target.state !== 'active') {
        return null;
    }
    if (read.policyRead.status === 'corrupt') {
        return null;
    }
    const targetIdentity = toGroupLayoutIdentity(target);
    if (
        read.group.lifecycleState !== 'active' ||
        read.group.acceptedLayoutIdentity !== null &&
            isSameGroupLayoutIdentity(read.group.acceptedLayoutIdentity, targetIdentity)
    ) {
        return null;
    }
    const policy = read.policyRead.status === 'present'
        ? read.policyRead.policy
        : createDefaultGroupLifecyclePolicy();
    if (policy.topology.reconfigureLanding !== 'apply') {
        return null;
    }
    return computeAppOutboxInsertOrMatch(computeTopologyPromotionEntry({
        work: {
            groupRef: target.groupRef,
            formationEpoch: read.group.formationEpoch,
            expectedLayout: targetIdentity
        },
        senderId: input.serviceId ?? 'topology-promotion',
        createdAtEpochMs: input.entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds,
        expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS
    }));
}

/** Pure validation retains the exact computed projection passed to write. */
export function validateTopologyPromotionRequest(
    input: ComputeTopologyPromotionRequestInput,
    computed: AppOutboxInsertOrMatch | null
): readonly AppInboxComputedValidationIssue[] {
    return validateAppInboxComputedProjection(
        computeTopologyPromotionRequest(input),
        computed,
        'topology promotion request'
    );
}

/**
 * The durable half, inside the publication transaction: the mint commits or
 * rolls back with the row it promotes (decision 27's atomicity).
 */
export async function writeTopologyPromotionRequest(
    transaction: PSqlSql,
    computed: AppOutboxInsertOrMatch | null
): Promise<void> {
    if (computed === null) {
        return;
    }
    try {
        await writeAppOutboxInsertOrMatch(transaction, computed);
    }
    catch (error) {
        // A same-identity request with different audit bytes already exists:
        // the promotion is already durably requested, which is this write's
        // whole goal — swallow the mismatch instead of wedging the
        // publication transaction.
        if (!(error instanceof ResourceInboxInvariantCorruptionError)) {
            throw error;
        }
    }
}
