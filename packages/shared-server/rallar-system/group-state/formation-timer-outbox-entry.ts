import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { computeFormationRetryBackoffMs } from '@shared/api/group-lifecycle/evaluate-group-activation-criterion.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import { fnv1a64 } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { AppOutboxType } from '../services/AppOutboxService.ts';
import type {
    GroupLifecycleTransitionOperation,
    GroupMutationCommand,
    GroupMutationFacts
} from './mutation/group-mutation-contracts.ts';

import { toAppQueueCreatedBy, toAppQueueKey } from '../services/app-inbox-queue-key.ts';
import { groupStateGroupStorageKey } from './persistence/group-state-storage-keys.ts';

export const APP_OUTBOX_FORMATION_TIMER_TOPIC = 'app-outbox.formation-timer';

/**
 * The time leg of the activation criterion. `deadline` fires the criterion
 * once the establishment deadline elapses; `retry` re-enters establishment
 * after a below-floor return, under backoff. Entries are inserted with
 * `dequeueAudit.nextTs` at their due time -- the queue's own visibility filter
 * (`next_ts <= now()`) holds them invisible until then, so the consumer never
 * sees an early entry and no polling or requeue loop exists.
 */
export type GroupFormationTimerWork = Readonly<{
    kind: 'deadline' | 'retry';
    groupRef: GroupRef;
    /** The formation epoch this timer was armed for; a mismatch is a stale drop. */
    formationEpoch: number;
    notBeforeEpochMs: number;
}>;

export interface ComputeFormationTimerEntryInput {
    readonly work: GroupFormationTimerWork;
    readonly senderId: string;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

export function computeFormationTimerEntry(input: ComputeFormationTimerEntryInput): ResourceEntry {
    const { work } = input;
    const contextId = groupStateGroupStorageKey(work.groupRef);
    // Queue resource ids cap at 36 chars and lose punctuation when rewritten, so
    // the id is short by construction: the receipt validator matches the ft-
    // prefix, and the group identity rides the fnv hash of the storage key.
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_FORMATION_TIMER_TOPIC,
        resourceId: `ft-${work.kind}-${work.formationEpoch}-${fnv1a64(contextId)}`,
        contextId
    });
    const createdBy = toAppQueueCreatedBy(input.senderId);
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: key.resourceId,
            ts: input.createdAtEpochMs,
            senderId: createdBy
        },
        route: key,
        constraints: { expiresAtMs: input.expireAtEpochMs },
        ordering: {
            orderingKey: key.contextId,
            epoch: work.formationEpoch,
            seq: 0
        },
        delivery: {
            ownership: 'exclusive',
            reliability: 'at-least-once',
            ack: 'none'
        },
        payload: {
            typeId: AppOutboxType.FORMATION_TIMER,
            contentType: 'application/json',
            resource: JSON.stringify(work)
        },
        audit: {
            createdBy,
            createdTs: input.createdAtEpochMs
        }
    };
    const createdTs = Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        typeId: EnqueuedType.APP_OUTBOX,
        resource: JSON.stringify(message),
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtEpochMs)
        },
        dequeueAudit: {
            attempts: 0,
            nextTs: Temporal.Instant.fromEpochMilliseconds(work.notBeforeEpochMs)
        }
    };
}

export function decodeFormationTimerWork(resource: string): GroupFormationTimerWork {
    const message = JSON.parse(resource) as ALMessage;
    const payloadResource = (message as { payload?: { resource?: string; }; }).payload?.resource;
    if (typeof payloadResource !== 'string') {
        throw new TypeError('Formation timer message payload is invalid');
    }
    const parsed = JSON.parse(payloadResource) as GroupFormationTimerWork;
    if (
        (parsed.kind !== 'deadline' && parsed.kind !== 'retry') ||
        typeof parsed.groupRef?.applicationId !== 'string' ||
        typeof parsed.groupRef?.workspaceId !== 'string' ||
        typeof parsed.groupRef?.groupId !== 'string' ||
        !Number.isSafeInteger(parsed.formationEpoch) ||
        parsed.formationEpoch < 0 ||
        !Number.isSafeInteger(parsed.notBeforeEpochMs)
    ) {
        throw new TypeError('Formation timer work payload is invalid');
    }
    return {
        kind: parsed.kind,
        groupRef: {
            applicationId: parsed.groupRef.applicationId,
            workspaceId: parsed.groupRef.workspaceId,
            groupId: parsed.groupRef.groupId
        },
        formationEpoch: parsed.formationEpoch,
        notBeforeEpochMs: parsed.notBeforeEpochMs
    };
}

export interface ComputeFormationTimerEntriesInput {
    readonly command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
    readonly next: Group;
    readonly policy: GroupLifecyclePolicy;
    readonly facts: GroupMutationFacts;
}

/**
 * The transitions arm the time leg themselves (plan refinement 2026-08-18):
 * entering an establishment phase schedules the deadline evaluation, and a
 * below-floor return schedules the next attempt under backoff. Both entries
 * carry the post-transition epoch, so a group that moves on before the timer
 * fires turns the entry into a stale drop.
 */
export function computeFormationTimerEntries(
    input: ComputeFormationTimerEntriesInput
): readonly ResourceEntry[] {
    const { command, next, policy, facts } = input;
    const deadlineArmed = policy.activation.mode === 'deadline' || policy.activation.mode === 'threshold-or-deadline';
    const beginsEstablishment = command.operation === 'startGroupEstablishment' ||
        command.operation === 'reopenGroupEstablishment';
    if (beginsEstablishment && deadlineArmed) {
        return [timerEntry(input, 'deadline', facts.nowEpochMs + policy.activation.deadlineMs)];
    }
    const retryAllowed = next.formationAttemptCount < policy.activation.maxFormationAttempts;
    if (command.operation === 'failGroupFormation' && retryAllowed) {
        return [
            timerEntry(
                input,
                'retry',
                facts.nowEpochMs + computeFormationRetryBackoffMs(next.formationAttemptCount)
            )
        ];
    }
    return [];
}

function timerEntry(
    input: ComputeFormationTimerEntriesInput,
    kind: 'deadline' | 'retry',
    notBeforeEpochMs: number
): ResourceEntry {
    const { next, facts } = input;
    return computeFormationTimerEntry({
        work: {
            kind,
            groupRef: {
                applicationId: next.applicationId,
                workspaceId: next.workspaceId,
                groupId: next.groupId
            },
            formationEpoch: next.formationEpoch,
            notBeforeEpochMs
        },
        senderId: facts.serviceId,
        createdAtEpochMs: facts.nowEpochMs,
        expireAtEpochMs: facts.expireAtEpochMs
    });
}
