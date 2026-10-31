import type {
    GroupLifecyclePolicy
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import type { GroupTopicSubscriptionOutcome } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type {
    AuditStamp,
    Group,
    GroupEvent,
    GroupEventType,
    GroupMember,
    GroupRef,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { computeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { GroupPolicyDeniedError } from '../policy/group-policy-result.ts';
import type { InitialGroupPresenceSummaryCandidate } from '../presence/group-initial-presence-summary.ts';
import type { GroupPlannedLayoutRow, PlannedLayoutPromotion } from './aggregate/compute-planned-layout-promotion.ts';
import type {
    GroupGuardCandidate,
    GroupLayoutTombstones,
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationDomainWrite,
    GroupMutationFacts,
    GroupMutationIdempotencyRecord,
    GroupMutationRead,
    GroupMutationReceipt,
    GroupPublicationGrantEffect,
    GroupTopicSubscriptionDeleteEffect,
    PresenceAdmissionCandidate,
    PresenceGuardCandidate,
    SubscriptionGuardCandidate
} from './group-mutation-contracts.ts';
import { GroupAlreadyExistsError, GroupMutationRejectedError } from './group-mutation-contracts.ts';
import { groupMutationIdempotencyKey } from './group-mutation-idempotency-key.ts';
import {
    GroupConnectDeniedError,
    GroupRetiredError,
    type GroupMutationRejectionCode
} from './group-mutation-rejection-codes.ts';
import { computeGroupMutationPersistence } from './orchestration/compute-group-mutation-persistence.ts';
import { toGroupMutationActor, toGroupMutationEvent } from './to-group-mutation-event.ts';

const DEFAULT_GROUP_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface GroupMutationWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly guard: GroupGuardCandidate | PresenceGuardCandidate | SubscriptionGuardCandidate;
    readonly members: readonly GroupMember[];
    readonly initialPresenceSummary: InitialGroupPresenceSummaryCandidate | null;
    readonly presenceAdmission?: PresenceAdmissionCandidate | null;
    /** Null records no event: a subscription write, which enqueues no presence-summary work either. */
    readonly eventType: GroupEventType | null;
    readonly eventGroup?: Group;
    readonly presenceSummaryWork: 'enqueue' | 'none';
    readonly extraOutboxEntries?: readonly ResourceEntry[];
    readonly acceptedLayoutPromotion?: Extract<PlannedLayoutPromotion, { outcome: 'apply'; }> | null;
    /** The planned row a layout fence matched, re-asserted at commit. */
    readonly plannedLayoutFence?: GroupPlannedLayoutRow | null;
    readonly connectTriggerLatchEffect?: RuntimeStateGuardedBatchEffect | null;
    readonly layoutTombstones?: GroupLayoutTombstones | null;
    readonly lifecyclePolicy: GroupLifecyclePolicy | null;
    readonly publicationGrantEffects: readonly GroupPublicationGrantEffect[];
    readonly subscriptionEffects: readonly GroupTopicSubscriptionDeleteEffect[];
    readonly subscriptionOutcome: GroupTopicSubscriptionOutcome | null;
}

export interface RejectedGroupMutationInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly rejectionCode: Exclude<GroupMutationRejectionCode, 'group-policy-denied'>;
    readonly message: string;
}

interface NoOpInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly subscriptionOutcome: GroupTopicSubscriptionOutcome | null;
}

interface MaterializedGroupJoinCode {
    readonly joinCode: string;
    readonly expiresAtEpochMs: number;
}

interface GroupPolicyRejectionInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly denial: GroupPolicyDenied;
}

interface GroupMutationReceiptInput {
    readonly outcome: GroupMutationReceipt['outcome'];
    readonly causalRevision: GroupStateCausalRevision;
    readonly snapshotVersion: number;
    readonly acceptedStorageRevision: number | null;
    readonly eventId: string | null;
    readonly outboxIds: readonly string[];
    readonly subscriptionOutcome: GroupTopicSubscriptionOutcome | null;
    readonly rejection: string | null;
}

export function materializedRotateJoinCode(
    command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode'; }>,
    facts: GroupMutationFacts
): MaterializedGroupJoinCode {
    const joinCode = command.input.joinCode ?? facts.resolvedJoinCode;
    const expiresAtEpochMs = command.input.expiresAtEpochMs ?? facts.attemptAtEpochMs + DEFAULT_GROUP_JOIN_CODE_TTL_MS;
    if (!joinCode || !Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs <= 0) {
        throw new GroupMutationRejectedError('Join code defaults could not be materialized safely');
    }
    return { joinCode, expiresAtEpochMs };
}

export function computeGroupMutationWriteResult(
    input: GroupMutationWriteInput
): GroupMutationComputed {
    const { command, eventGroup, facts, guard, read } = input;
    const group = eventGroup ??
        (guard.kind === 'group' ? guard.value : requireGroup(read, command.aggregateRef).value);
    const presenceRevision = read.presenceSummary?.value.causalRevision.presenceRevision ?? 0;
    const causalRevision = { groupRevision: group.snapshotVersion, presenceRevision };
    const event = input.eventType === null
        ? null
        : toGroupMutationEvent({
            eventType: input.eventType,
            group,
            causalRevision,
            command,
            facts,
            members: input.members,
            publicationGrantEffects: input.publicationGrantEffects
        });
    const outboxEntries = computeMutationFollowupEntries(input, causalRevision, event);
    const acceptedLayoutPromotion = input.acceptedLayoutPromotion ?? null;
    const plannedLayoutFence = input.plannedLayoutFence ?? null;
    const layoutTombstones = input.layoutTombstones ?? null;
    const receipt = toGroupMutationReceipt(command, facts, {
        outcome: 'applied',
        causalRevision,
        snapshotVersion: group.snapshotVersion,
        acceptedStorageRevision: input.guard.operation === 'insert' ? 0 : input.guard.expectedRevision + 1,
        eventId: event?.eventId ?? null,
        outboxIds: outboxEntries.map((outboxEntry) => outboxEntry.key.resourceId),
        subscriptionOutcome: input.subscriptionOutcome,
        rejection: null
    });
    const computed: GroupMutationDomainWrite = {
        outcome: 'write',
        guard: input.guard,
        members: input.members,
        initialPresenceSummary: input.initialPresenceSummary,
        presenceAdmission: input.presenceAdmission ?? null,
        event,
        receipt,
        idempotency: toGroupMutationIdempotency(command, facts, receipt),
        outboxWrites: outboxEntries.map(computeAppOutboxInsert),
        lifecyclePolicy: input.lifecyclePolicy,
        acceptedLayoutPromotion,
        plannedLayoutFence,
        layoutTombstones,
        connectTriggerLatchEffect: input.connectTriggerLatchEffect ?? null,
        publicationGrantEffects: input.publicationGrantEffects,
        subscriptionEffects: input.subscriptionEffects
    };
    return { ...computed, persistence: computeGroupMutationPersistence(computed, facts, read) };
}

function toGroupMutationIdempotency(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    receipt: GroupMutationReceipt
): GroupMutationIdempotencyRecord | null {
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (idempotencyKey === null) {
        return null;
    }
    return {
        aggregateRef: command.aggregateRef,
        requestId: idempotencyKey,
        commandHash: facts.commandHash,
        receipt
    };
}

export function noOp(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    return toNoOp({ command, read, facts, subscriptionOutcome: null });
}

/** An unsubscribe that found nothing it may delete: a receipt-only no-op that still answers its outcome. */
export function notSubscribed(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    return toNoOp({ command, read, facts, subscriptionOutcome: 'not-subscribed' });
}

function toNoOp({ command, read, facts, subscriptionOutcome }: NoOpInput): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const causalRevision = currentCausalRevision(read);
    return {
        outcome: 'no-op',
        rejectionCode: null,
        receipt: toGroupMutationReceipt(command, facts, {
            outcome: 'no-op',
            causalRevision,
            snapshotVersion: stored.value.snapshotVersion,
            acceptedStorageRevision: stored.entry.revision,
            eventId: null,
            outboxIds: [],
            subscriptionOutcome,
            rejection: null
        })
    };
}

export function rejected(
    input: RejectedGroupMutationInput
): Extract<GroupMutationComputed, { rejectionCode: Exclude<GroupMutationRejectionCode, 'group-policy-denied'>; }> {
    const { command, facts, message, read, rejectionCode } = input;
    const causalRevision = currentCausalRevision(read);
    return {
        outcome: 'rejected',
        rejectionCode,
        receipt: toGroupMutationReceipt(command, facts, {
            outcome: 'rejected',
            causalRevision,
            snapshotVersion: read.group?.value.snapshotVersion ?? 0,
            acceptedStorageRevision: read.group?.entry.revision ?? null,
            eventId: null,
            outboxIds: [],
            subscriptionOutcome: null,
            rejection: message
        })
    };
}

export function rejectedByGroupPolicy(
    input: GroupPolicyRejectionInput
): GroupMutationComputed {
    return {
        ...rejected({ ...input, rejectionCode: 'group-mutation-rejected', message: input.denial.message }),
        rejectionCode: 'group-policy-denied',
        policyDenial: {
            allowed: false,
            code: input.denial.code,
            message: input.denial.message,
            ...(input.denial.details === undefined ? {} : { details: input.denial.details })
        }
    };
}

export function toGroupMutationRejectionError(
    computed: Extract<GroupMutationComputed, { outcome: 'rejected'; }>
):
    | GroupRetiredError
    | GroupAlreadyExistsError
    | GroupConnectDeniedError
    | GroupMutationRejectedError
    | GroupPolicyDeniedError {
    const message = computed.receipt.rejection ?? 'Group mutation rejected';
    switch (computed.rejectionCode) {
        case 'group-policy-denied':
            return new GroupPolicyDeniedError(computed.policyDenial);
        case 'group-retired':
            return new GroupRetiredError(message);
        case 'group-already-exists':
            return new GroupAlreadyExistsError(message);
        case 'group-connect-stale-epoch':
        case 'group-connect-no-planned-layout':
        case 'group-connect-planned-layout-superseded':
            return new GroupConnectDeniedError(computed.rejectionCode, message);
        case 'group-mutation-rejected':
            return new GroupMutationRejectedError(message);
    }
}

function toGroupMutationReceipt(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    input: GroupMutationReceiptInput
): GroupMutationReceipt {
    const joinCode = command.operation === 'rotateGroupJoinCode' ? materializedRotateJoinCode(command, facts) : null;
    return {
        commandId: command.commandId,
        requestId: command.requestId,
        commandHash: facts.commandHash,
        aggregateRef: command.aggregateRef,
        outcome: input.outcome,
        attemptCount: facts.attemptCount,
        acceptedStorageRevision: input.acceptedStorageRevision,
        snapshotVersion: input.snapshotVersion,
        causalRevision: input.causalRevision,
        eventId: input.eventId,
        outboxIds: input.outboxIds,
        joinCode: joinCode?.joinCode ?? null,
        joinCodeExpiresAtEpochMs: joinCode?.expiresAtEpochMs ?? null,
        subscriptionOutcome: input.subscriptionOutcome,
        rejection: input.rejection
    };
}

export function currentCausalRevision(read: GroupMutationRead): GroupStateCausalRevision {
    return {
        groupRevision: read.group?.value.snapshotVersion ?? 0,
        presenceRevision: read.presenceSummary?.value.causalRevision.presenceRevision ?? 0
    };
}

export function requireGroup(
    read: GroupMutationRead,
    ref: GroupRef
): RuntimeStateEntryValue<Group> {
    // Fresh non-create absence is a typed rejection at computeGroupMutation.
    // Result assembly reaches this only after that existence decision.
    if (!read.group) {
        throw new GroupMutationRejectedError(`Group not found: ${ref.groupId}`);
    }
    return read.group;
}

export function auditStamp(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    defaultPrincipalId: string | undefined
): AuditStamp {
    return {
        atEpochMs: facts.nowEpochMs,
        actor: toGroupMutationActor(command, facts, defaultPrincipalId),
        reason: command.input.reason,
        traceId: facts.traceId,
        requestId: command.requestId
    };
}

function computeMutationFollowupEntries(
    input: GroupMutationWriteInput,
    causalRevision: GroupStateCausalRevision,
    event: GroupEvent | null
): readonly ResourceEntry[] {
    const { command, facts } = input;
    if (event === null) {
        if (input.presenceSummaryWork === 'enqueue') {
            throw new TypeError('Presence-summary work expands an event, and this write records none');
        }
        return input.extraOutboxEntries ?? [];
    }
    const summaryOutboxEntries = input.presenceSummaryWork === 'none'
        ? []
        : [
            computeGroupPresenceSummaryEntry(
                {
                    effectKind: 'group-presence-summary',
                    aggregateRef: command.aggregateRef,
                    commandId: command.commandId,
                    createdAtEpochMs: facts.nowEpochMs,
                    expireAtEpochMs: facts.expireAtEpochMs,
                    acceptedCausalRevision: causalRevision,
                    event
                },
                facts.serviceId,
                facts.traceId
            )
        ];
    return [...summaryOutboxEntries, ...(input.extraOutboxEntries ?? [])];
}
