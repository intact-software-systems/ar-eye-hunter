import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
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

import type { GroupPolicyCapacityConfig } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import type { GroupLifecyclePolicyRead } from '../persistence/group-lifecycle-policy-repository.ts';
import type { InitialGroupPresenceSummaryCandidate } from '../presence/group-initial-presence-summary.ts';

type NullableActorInput = Readonly<{
    actorPrincipalId: string | null;
    actorSessionId: string | null;
    reason: string | null;
    traceId: string | null;
}>;

type GroupMutationCommandBase = Readonly<{
    aggregateRef: GroupRef;
    commandId: string;
    requestId: string | null;
}>;

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
            operation: 'startGroupEstablishment' | 'reopenGroupEstablishment';
            input: NullableActorInput;
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
                }>;
        }>
    )
    | (
        & GroupMutationCommandBase
        & Readonly<{
            operation: 'failGroupFormation';
            input: NullableActorInput & Readonly<{ observedRate: number; }>;
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

export type GroupMutationReceipt = Readonly<{
    commandId: string;
    requestId: string | null;
    commandHash: string;
    aggregateRef: GroupRef;
    outcome: 'applied' | 'no-op' | 'rejected';
    attemptCount: number;
    acceptedStorageRevision: number | null;
    snapshotVersion: number;
    causalRevision: GroupStateCausalRevision;
    eventId: string | null;
    outboxIds: readonly string[];
    joinCode: string | null;
    joinCodeExpiresAtEpochMs: number | null;
    rejection: string | null;
}>;

export type GroupMutationIdempotencyRecord = Readonly<{
    aggregateRef: GroupRef;
    requestId: string;
    commandHash: string;
    receipt: GroupMutationReceipt;
}>;

export type GroupMutationRead = Readonly<{
    idempotency: RuntimeStateEntryValue<GroupMutationIdempotencyRecord> | null;
    group: RuntimeStateEntryValue<Group> | null;
    expiredGroupEntry: RuntimeStateEntry | null;
    actorMember: GroupMember | null;
    targetMember: GroupMember | null;
    authorityMember: GroupMember | null;
    directorMember: GroupMember | null;
    actorMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    targetMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    authorityMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    directorMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    targetPresence: RuntimeStateEntryValue<GroupPresenceSession> | null;
    expiredTargetPresenceEntry: RuntimeStateEntry | null;
    targetAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    authorityAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    directorAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    authorityPresenceSessions: readonly GroupPresenceSession[];
    authorityPresenceSessionEntries: readonly RuntimeStateEntryValue<GroupPresenceSession>[];
    presenceSummary: RuntimeStateEntryValue<GroupPresenceSummary> | null;
    /** Loaded only for the lifecycle transition operations; null everywhere else. */
    lifecyclePolicy: GroupLifecyclePolicyRead | null;
    /**
     * The active member principal ids at read time, loaded only for the
     * lifecycle transition operations; the compare-and-set on the group row
     * (membership writes bump snapshotVersion) makes the pinned electorate
     * consistent with the transition that records it.
     */
    activeMemberPrincipalIds: readonly string[] | null;
}>;

export type GroupMutationFacts = Readonly<{
    nowEpochMs: number;
    expireAtEpochMs: number;
    serviceId: string;
    eventId: string;
    commandHash: string;
    attemptCount: number;
    resolvedJoinCode: string | null;
    joinCodeVerifier: string | null;
    internalAuthority: 'none' | 'expiry' | 'session-cleanup' | 'formation-criterion';
    /**
     * Operational capacity defaults captured at preparation time; absent when
     * the runtime configured no defaults, which preserves stored-cap-only
     * admission and keeps pre-existing durable preparations valid.
     */
    capacity?: GroupPolicyCapacityConfig;
    authenticatedAuthority:
        | Readonly<{
            principalId: string;
            sessionId: string;
        }>
        | null;
}>;

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

export type GroupMutationComputed =
    | Readonly<{ outcome: 'replay'; receipt: GroupMutationReceipt; }>
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>
    | Readonly<{
        outcome: 'no-op' | 'rejected';
        receipt: GroupMutationReceipt;
    }>
    | Readonly<{
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
    }>;

export type GroupMutationComputedWrite = Extract<GroupMutationComputed, { outcome: 'write'; }>;

export type GroupLifecycleTransitionOperation = Extract<
    GroupMutationCommand['operation'],
    'startGroupEstablishment' | 'activateGroup' | 'reopenGroupEstablishment' | 'failGroupFormation'
>;

export function isGroupLifecycleTransitionOperation(
    operation: GroupMutationCommand['operation']
): operation is GroupLifecycleTransitionOperation {
    return (
        operation === 'startGroupEstablishment' ||
        operation === 'activateGroup' ||
        operation === 'reopenGroupEstablishment' ||
        operation === 'failGroupFormation'
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
