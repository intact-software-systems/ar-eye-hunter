import { Temporal } from '@js-temporal/polyfill';
import { consumesFormationDeadlineAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { computeFormationRetryBackoffMs } from '@shared/api/group-lifecycle/evaluate-group-activation-criterion.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { isFormationAttemptBudgetExhausted } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import { fnv1a64, toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import type {
    GroupLifecycleTransitionOperation,
    GroupMutationCommand,
    GroupMutationFacts
} from './mutation/group-mutation-contracts.ts';

import { groupStateGroupStorageKey } from './persistence/aggregate/group-aggregate-storage-keys.ts';

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
    /** The committed group snapshot that created this timer. */
    groupSnapshotVersion: number;
    notBeforeEpochMs: number;
}>;

export interface ComputeFormationTimerEntryInput {
    readonly work: GroupFormationTimerWork;
    readonly senderId: string;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

export function computeFormationTimerEntry(input: ComputeFormationTimerEntryInput): ResourceEntry {
    const work: GroupFormationTimerWork = {
        ...input.work,
        groupRef: {
            applicationId: input.work.groupRef.applicationId,
            workspaceId: input.work.groupRef.workspaceId,
            groupId: input.work.groupRef.groupId
        }
    };
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
    const message = toFormationTimerMessage({ input, work, key, createdBy });
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
    const message = readJsonObject(
        decodeJsonWireValue(JSON.parse(resource), 'Formation timer message'),
        'Formation timer message'
    );
    const payload = readJsonObject(message.payload, 'Formation timer message payload');
    const payloadResource = payload.resource;
    if (typeof payloadResource !== 'string') {
        throw new TypeError('Formation timer message payload is invalid');
    }
    const parsed = readExactJsonObject(
        decodeJsonWireValue(JSON.parse(payloadResource), 'Formation timer work payload'),
        ['kind', 'groupRef', 'formationEpoch', 'groupSnapshotVersion', 'notBeforeEpochMs'],
        'Formation timer work payload'
    );
    const groupRef = readExactJsonObject(
        parsed.groupRef,
        ['applicationId', 'workspaceId', 'groupId'],
        'Formation timer group identity'
    );
    if (parsed.kind !== 'deadline' && parsed.kind !== 'retry') {
        throw new TypeError('Formation timer work payload is invalid');
    }
    return {
        kind: parsed.kind,
        groupRef: {
            applicationId: readNonEmptyString(groupRef.applicationId, 'Formation timer application id'),
            workspaceId: readNonEmptyString(groupRef.workspaceId, 'Formation timer workspace id'),
            groupId: readNonEmptyString(groupRef.groupId, 'Formation timer group id')
        },
        formationEpoch: readNonNegativeSafeInteger(parsed.formationEpoch, 'Formation timer epoch'),
        groupSnapshotVersion: readNonNegativeSafeInteger(
            parsed.groupSnapshotVersion,
            'Formation timer group snapshot version'
        ),
        notBeforeEpochMs: readNonNegativeSafeInteger(
            parsed.notBeforeEpochMs,
            'Formation timer due time'
        )
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
    if (consumesFormationDeadlineAt(next.lifecycleState) && deadlineArmed) {
        return [timerEntry(input, 'deadline', facts.nowEpochMs + policy.activation.deadlineMs)];
    }
    const retryAllowed = !isFormationAttemptBudgetExhausted({
        activation: policy.activation,
        formationAttemptCount: next.formationAttemptCount
    });
    if (command.operation === 'failGroupFormation' && next.lifecycleState === 'forming' && retryAllowed) {
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
            groupSnapshotVersion: next.snapshotVersion,
            notBeforeEpochMs
        },
        senderId: facts.serviceId,
        createdAtEpochMs: facts.nowEpochMs,
        expireAtEpochMs: facts.expireAtEpochMs
    });
}

function readExactJsonObject(
    value: JsonWireValue | undefined,
    expectedKeys: readonly string[],
    label: string
): JsonWireObject {
    const record = readJsonObject(value, label);
    const keys = Object.keys(record).sort();
    const expected = [...expectedKeys].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new TypeError(`${label} fields are invalid`);
    }
    return record;
}

function readJsonObject(value: JsonWireValue | undefined, label: string): JsonWireObject {
    if (value === undefined || !isJsonWireObject(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: JsonWireValue | undefined, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function readNonNegativeSafeInteger(value: JsonWireValue | undefined, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

interface FormationTimerMessageInput {
    readonly input: ComputeFormationTimerEntryInput;
    readonly work: GroupFormationTimerWork;
    readonly key: ResourceEntry['key'];
    readonly createdBy: string;
}

function toFormationTimerMessage({ input, work, key, createdBy }: FormationTimerMessageInput): ALMessage {
    return {
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
}
