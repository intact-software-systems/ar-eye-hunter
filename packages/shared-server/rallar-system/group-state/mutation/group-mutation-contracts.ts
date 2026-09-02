import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type {
    GroupLifecyclePolicy,
    GroupTopologyReconfigureLanding
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import type {
    AuditStamp,
    Group,
    GroupEvent,
    GroupJoinMode,
    GroupMember,
    GroupMemberStatus,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupRole,
    GroupStateCausalRevision,
    GroupStatus
} from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type {
    RuntimeStateGuardedBatch,
    RuntimeStateGuardedBatchEffect
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { GroupConnectTriggerLatchRow } from '../persistence/group-connect-trigger-latch-repository.ts';
import type {
    GroupAcceptedLayoutRow,
    GroupPlannedLayoutRow,
    PlannedLayoutPromotion
} from './aggregate/compute-planned-layout-promotion.ts';
import type { GroupMutationRejectionCode } from './group-mutation-rejection-codes.ts';

import type { GroupPolicyCapacityConfig } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import type { GroupLifecyclePolicyRead } from '../persistence/group-lifecycle-policy-repository.ts';
import type { InitialGroupPresenceSummaryCandidate } from '../presence/group-initial-presence-summary.ts';

interface NullableActorInput {
    readonly actorPrincipalId: string | null;
    readonly actorSessionId: string | null;
    readonly reason: string | null;
    readonly traceId: string | null;
}

interface GroupMutationCommandBase {
    readonly aggregateRef: GroupRef;
    readonly commandId: string;
    readonly requestId: string | null;
}

export type GroupMutationCommand =
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'createGroup';
            input:
                & NullableActorInput
                & Readonly<{
                    slug: string | null;
                    displayName: string;
                    description: string | null;
                    kind: Group['kind'];
                    joinMode: GroupJoinMode;
                    maxMembers: number | null;
                    maxSessionsPerMember: number | null;
                    metadata: Readonly<Group['metadata']>;
                    createdByPrincipalId: string;
                    expiresAtEpochMs: number | null;
                    purgeAfterEpochMs: number | null;
                    lifecyclePolicy?: GroupLifecyclePolicy;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'updateGroup';
            input:
                & NullableActorInput
                & Readonly<{
                    slug: string | null;
                    displayName: string | null;
                    description: string | null;
                    kind: Group['kind'] | null;
                    status: GroupStatus | null;
                    joinMode: GroupJoinMode | null;
                    maxMembers: number | null;
                    maxSessionsPerMember: number | null;
                    metadata: Readonly<Group['metadata']> | null;
                    expiresAtEpochMs: number | null;
                    emptySinceEpochMs: number | null;
                    purgeAfterEpochMs: number | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'appointDirector';
            input: NullableActorInput & Readonly<{ heartbeatTtlMs: number; }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'reconfigureGroup';
            input:
                & NullableActorInput
                & Readonly<{
                    /** Null on principal commands; the retry leg's causal fence when internal. */
                    expectedFormationEpoch: number | null;
                    /** Null preserves the stored or absent-policy landing decision. */
                    landing: GroupTopologyReconfigureLanding | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            // Principal planning and durable retry planning share one command.
            operation: 'planGroupLayout';
            input:
                & NullableActorInput
                & Readonly<{
                    /** Null on principal commands; the plan trigger's causal fence when internal. */
                    expectedFormationEpoch: number | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            // `connect` names the exact planned layout it means to dial (product
            // decision 32), so both fences are required — a manual caller
            // reads them from the formation and topology views.
            operation: 'connectGroup';
            input:
                & NullableActorInput
                & Readonly<{
                    expectedFormationEpoch: number;
                    expectedLayout: GroupLayoutIdentity;
                    connectTriggerGeneration: string | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            // `start` opens a formation series from the clean slate and is denied while the
            // attempt budget is spent (product decisions 35/37).
            operation: 'startGroupFormation' | 'resetGroupFormation';
            input:
                & NullableActorInput
                & Readonly<{
                    /** Null on principal commands; a trigger's causal fence when internal. */
                    expectedFormationEpoch: number | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'activateGroup';
            input:
                & NullableActorInput
                & Readonly<{
                    /** Null on operator commands; the criterion's rate when internal. */
                    observedRate: number | null;
                    degraded: boolean | null;
                    /** Null on operator commands; the criterion's causal fence when internal. */
                    expectedFormationEpoch: number | null;
                    expectedLayout: GroupLayoutIdentity | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'failGroupFormation';
            input:
                & NullableActorInput
                & Readonly<{
                    observedRate: number;
                    /** Null on operator commands; the criterion's causal fence when internal. */
                    expectedFormationEpoch: number | null;
                    expectedLayout: GroupLayoutIdentity | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            // Route-less (I8): only the accepted planned-publication
            // transaction enqueues it, under topology-publication authority.
            // It promotes without advancing stage, epoch or electorate. The
            // fences are non-null by construction: the one builder always
            // supplies them and no authenticated route exists.
            operation: 'applyPlannedLayout';
            input:
                & NullableActorInput
                & Readonly<{
                    expectedFormationEpoch: number;
                    expectedLayout: GroupLayoutIdentity;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            // The valve is a transport fact, not a stage (product decision 25): these
            // carry no fence, land in no transition table cell, and advance
            // neither the formation epoch nor the electorate.
            operation: 'pauseGroupTransport' | 'resumeGroupTransport';
            input: NullableActorInput;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'joinGroup' | 'acceptGroupInvite';
            targetPrincipalId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    inviteToken: string | null;
                    joinCode: string | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'createGroupInvite';
            targetPrincipalId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    invitationExpiresAtEpochMs: number | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation:
                | 'revokeGroupInvite'
                | 'removeGroupMember'
                | 'banGroupMember'
                | 'unbanGroupMember'
                | 'grantGroupAdmission'
                | 'declineGroupAdmission';
            targetPrincipalId: string;
            input: NullableActorInput;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'setGroupMemberRole';
            targetPrincipalId: string;
            input: NullableActorInput & Readonly<{ role: GroupRole; }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'transferGroupOwnership';
            targetPrincipalId: string;
            input: NullableActorInput;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'upsertMember';
            targetPrincipalId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    role: GroupRole | null;
                    status: GroupMemberStatus;
                    invitedByPrincipalId: string | null;
                    invitationExpiresAtEpochMs: number | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'rotateGroupJoinCode';
            input:
                & NullableActorInput
                & Readonly<{
                    joinCode: string | null;
                    expiresAtEpochMs: number | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'connectPresence';
            sessionId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    principalId: string;
                    generationId: string;
                    connectedAtEpochMs: number | null;
                    lastHeartbeatAtEpochMs: number | null;
                    expiresAtEpochMs: number | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'heartbeatPresence';
            sessionId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    principalId: string | null;
                    generationId: string;
                    lastHeartbeatAtEpochMs: number | null;
                    expiresAtEpochMs: number | null;
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'disconnectPresence';
            sessionId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    principalId: string | null;
                    generationId: string;
                    generationVersion: number | null;
                    observedExpiresAtEpochMs: number | null;
                    disconnectedAtEpochMs: number | null;
                    lastHeartbeatAtEpochMs: number | null;
                    expiresAtEpochMs: number | null;
                }>;
        }>
    );

export interface GroupMutationReceipt {
    readonly commandId: string;
    readonly requestId: string | null;
    readonly commandHash: string;
    readonly aggregateRef: GroupRef;
    readonly outcome: 'applied' | 'no-op' | 'rejected';
    readonly attemptCount: number;
    readonly acceptedStorageRevision: number | null;
    readonly snapshotVersion: number;
    readonly causalRevision: GroupStateCausalRevision;
    readonly eventId: string | null;
    readonly outboxIds: readonly string[];
    readonly joinCode: string | null;
    readonly joinCodeExpiresAtEpochMs: number | null;
    readonly rejection: string | null;
}

export interface GroupMutationIdempotencyRecord {
    readonly aggregateRef: GroupRef;
    readonly requestId: string;
    readonly commandHash: string;
    readonly receipt: GroupMutationReceipt;
}

export interface GroupMutationRead {
    readonly idempotency: RuntimeStateEntryValue<GroupMutationIdempotencyRecord> | null;
    readonly group: RuntimeStateEntryValue<Group> | null;
    readonly expiredGroupEntry: RuntimeStateEntry | null;
    readonly actorMember: GroupMember | null;
    readonly targetMember: GroupMember | null;
    readonly authorityMember: GroupMember | null;
    readonly directorMember: GroupMember | null;
    readonly actorMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    readonly targetMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    readonly authorityMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    readonly directorMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    readonly targetPresence: RuntimeStateEntryValue<GroupPresenceSession> | null;
    readonly expiredTargetPresenceEntry: RuntimeStateEntry | null;
    readonly targetAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    readonly authorityAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    readonly directorAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    readonly authorityPresenceSessions: readonly GroupPresenceSession[];
    readonly authorityPresenceSessionEntries: readonly RuntimeStateEntryValue<GroupPresenceSession>[];
    readonly presenceSummary: RuntimeStateEntryValue<GroupPresenceSummary> | null;
    /** Loaded only for the operations the read scope's policy rule names. */
    readonly lifecyclePolicy: GroupLifecyclePolicyRead | null;
    /**
     * The active member principal ids at read time, loaded only for the
     * operations the read scope's roster rule names; the
     * compare-and-set on the group row (membership writes bump
     * snapshotVersion) makes the pinned electorate consistent with the
     * transition that records it.
     */
    readonly activeMemberPrincipalIds: readonly string[] | null;
    /**
     * The stored planned layout row — identity, snapshot and revision — read
     * for commands whose fence or promotion consumes it (activateGroup
     * always, layout-fenced failGroupFormation, applyPlannedLayout). Null
     * when the command reads no layout, when no planned row exists, or when
     * the deployment wired the constant null reader — the last two are
     * indistinguishable here and both fence layout-bound commands closed as
     * no-planned-layout.
     */
    readonly connectTriggerLatch: GroupConnectTriggerLatchRow | null;
    readonly plannedLayoutRow: GroupPlannedLayoutRow | null;
    /** The accepted slot, read only by the promotion-capable operations. */
    readonly acceptedLayoutRow: GroupAcceptedLayoutRow | null;
}

/**
 * The internal authority mode registry. The facts codec validates against
 * this tuple and the type derives from it, so adding a mode is a compile
 * error at every decision site and never a silent runtime rejection.
 */
export const GROUP_MUTATION_INTERNAL_AUTHORITY_MODES = [
    'none',
    'expiry',
    'session-cleanup',
    'formation-criterion',
    'formation-automation',
    'topology-publication',
    'activation-status'
] as const;

export interface GroupMutationFacts {
    readonly nowEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly serviceId: string;
    readonly eventId: string;
    readonly commandHash: string;
    readonly attemptCount: number;
    readonly resolvedJoinCode: string | null;
    readonly joinCodeVerifier: string | null;
    readonly internalAuthority: (typeof GROUP_MUTATION_INTERNAL_AUTHORITY_MODES)[number];
    /**
     * Operational capacity defaults captured at preparation time; absent when
     * the runtime configured no defaults, which preserves stored-cap-only
     * admission and keeps pre-existing durable preparations valid.
     */
    readonly capacity?: GroupPolicyCapacityConfig;
    readonly authenticatedAuthority:
        | Readonly<{
            principalId: string;
            sessionId: string;
        }>
        | null;
}

export type GroupGuardCandidate =
    | Readonly<{ kind: 'group'; operation: 'insert'; value: Group; }>
    | Readonly<{
        kind: 'group';
        operation: 'update';
        value: Group;
        expectedRevision: number;
    }>;

export type PresenceGuardCandidate =
    | Readonly<{
        kind: 'presence';
        operation: 'insert';
        value: GroupPresenceSession;
    }>
    | Readonly<{
        kind: 'presence';
        operation: 'update';
        value: GroupPresenceSession;
        expectedRevision: number;
    }>
    | Readonly<{
        kind: 'presence';
        operation: 'delete';
        value: GroupPresenceSession;
        expectedRevision: number;
    }>;

export type PresenceAdmissionCandidate =
    | Readonly<{
        operation: 'insert';
        value: GroupPresenceAdmission;
    }>
    | Readonly<{
        operation: 'update';
        value: GroupPresenceAdmission;
        expectedRevision: number;
    }>;

export type GroupMutationDomainWrite = Readonly<{
    outcome: 'write';
    guard: GroupGuardCandidate | PresenceGuardCandidate;
    members: readonly GroupMember[];
    initialPresenceSummary: InitialGroupPresenceSummaryCandidate | null;
    presenceAdmission: PresenceAdmissionCandidate | null;
    event: GroupEvent;
    receipt: GroupMutationReceipt;
    idempotency: GroupMutationIdempotencyRecord | null;
    outboxEntries: readonly ResourceEntry[];
    lifecyclePolicy: GroupLifecyclePolicy | null;
    /** Accepted layout committed atomically with the authoritative group row. */
    acceptedLayoutPromotion: Extract<PlannedLayoutPromotion, { outcome: 'apply'; }> | null;
    /** Planned layout revision re-asserted by a layout-fenced command. */
    plannedLayoutFence: GroupPlannedLayoutRow | null;
    layoutTombstones: GroupLayoutTombstones | null;
    connectTriggerLatchEffect: RuntimeStateGuardedBatchEffect | null;
}>;

export type GroupMutationPersistence = Readonly<{
    guardedBatch: RuntimeStateGuardedBatch;
    lifecyclePolicyWrite:
        | Readonly<{
            namespace: string;
            key: string;
            value: string;
            expireAtIsoTimestamp: string;
        }>
        | null;
    eventWrite: Readonly<{
        event: GroupEvent;
        workspaceKey: string;
        eventJson: string;
    }>;
}>;

export type GroupMutationComputedWrite =
    & GroupMutationDomainWrite
    & Readonly<{ persistence: GroupMutationPersistence; }>;

export type GroupMutationComputed =
    | Readonly<{
        outcome: 'replay' | 'no-op';
        rejectionCode: null;
        receipt: GroupMutationReceipt;
    }>
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>
    | Readonly<{
        outcome: 'rejected';
        rejectionCode: Exclude<GroupMutationRejectionCode, 'group-policy-denied'>;
        receipt: GroupMutationReceipt;
    }>
    | Readonly<{
        outcome: 'rejected';
        rejectionCode: 'group-policy-denied';
        policyDenial: GroupPolicyDenied;
        receipt: GroupMutationReceipt;
    }>
    | GroupMutationComputedWrite;

export interface GroupLayoutTombstones {
    readonly planned: GroupPlannedLayoutRow | null;
    readonly accepted: GroupAcceptedLayoutRow | null;
}

export type GroupLifecycleTransitionOperation = Extract<
    GroupMutationCommand['operation'],
    | 'activateGroup'
    | 'reconfigureGroup'
    | 'failGroupFormation'
    | 'planGroupLayout'
    | 'connectGroup'
    | 'startGroupFormation'
    | 'resetGroupFormation'
>;

export function isGroupLifecycleTransitionOperation(
    operation: GroupMutationCommand['operation']
): operation is GroupLifecycleTransitionOperation {
    return (
        operation === 'activateGroup' ||
        operation === 'reconfigureGroup' ||
        operation === 'failGroupFormation' ||
        operation === 'planGroupLayout' ||
        operation === 'connectGroup' ||
        operation === 'startGroupFormation' ||
        operation === 'resetGroupFormation'
    );
}

/**
 * The transport valve's two commands (product decision 25). They are not
 * lifecycle transitions: they write `transportState` alone, so they never
 * enter the transition table or any registry keyed on it.
 */
export type GroupTransportOperation = Extract<
    GroupMutationCommand['operation'],
    'pauseGroupTransport' | 'resumeGroupTransport'
>;

export function isGroupTransportOperation(
    operation: GroupMutationCommand['operation']
): operation is GroupTransportOperation {
    return operation === 'pauseGroupTransport' || operation === 'resumeGroupTransport';
}

/** True exactly when the command names a planned layout its fence must match. */
export function isLayoutFencedGroupMutationCommand(command: GroupMutationCommand): boolean {
    return (
        (
            command.operation === 'activateGroup' ||
            command.operation === 'failGroupFormation' ||
            command.operation === 'applyPlannedLayout' ||
            command.operation === 'connectGroup'
        ) &&
        command.input.expectedLayout !== null
    );
}

export type GroupAdmissionDecisionOperation = Extract<
    GroupMutationCommand['operation'],
    'grantGroupAdmission' | 'declineGroupAdmission'
>;

/** Grant/decline resolve managers, so they read the roster like transitions. */
export function isGroupAdmissionDecisionOperation(
    operation: GroupMutationCommand['operation']
): operation is GroupAdmissionDecisionOperation {
    return operation === 'grantGroupAdmission' || operation === 'declineGroupAdmission';
}

/**
 * The operations whose compute consults the admission policy (plan decision
 * 5.1): the two join surfaces park under `manager-approval`, and grant
 * re-checks the admission windows before completing membership.
 */
export function isGroupAdmissionPolicyReadOperation(
    operation: GroupMutationCommand['operation']
): boolean {
    return (
        operation === 'joinGroup' ||
        operation === 'acceptGroupInvite' ||
        operation === 'upsertMember' ||
        isGroupAdmissionDecisionOperation(operation)
    );
}

export type GroupMutationIdempotencyProbe =
    | Readonly<{ outcome: 'miss'; }>
    | Readonly<{ outcome: 'replay'; receipt: GroupMutationReceipt; }>
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>;

export class GroupMutationRejectedError extends Error {
    readonly status = 400;
    readonly code = 'group-mutation-rejected';

    constructor(message: string) {
        super(message);
        this.name = 'GroupMutationRejectedError';
    }
}

export class GroupAlreadyExistsError extends Error {
    readonly status = 409;
    readonly code = 'group-already-exists';

    constructor(message: string) {
        super(message);
        this.name = 'GroupAlreadyExistsError';
    }
}
