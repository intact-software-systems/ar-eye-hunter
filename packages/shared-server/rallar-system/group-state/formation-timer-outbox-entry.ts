import { Temporal } from '@js-temporal/polyfill';
import {
    consumesFormationDeadlineAt,
    holdsPlannedCandidateAt
} from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { computeFormationRetryBackoffMs } from '@shared/api/group-lifecycle/evaluate-group-activation-criterion.ts';
import { toStageTriggerTimerDelayMs } from '@shared/api/group-lifecycle/evaluate-group-stage-trigger.ts';
import type { GroupLifecyclePolicy, GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { isFormationAttemptBudgetExhausted } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import { fnv1a64, toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { requireOneOf } from '../protocol/exact-object-decoding.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import type {
    GroupLifecycleTransitionOperation,
    GroupMutationCommand,
    GroupMutationFacts
} from './mutation/group-mutation-contracts.ts';

import { groupStateGroupStorageKey } from './persistence/aggregate/group-aggregate-storage-keys.ts';

export const APP_OUTBOX_FORMATION_TIMER_TOPIC = 'app-outbox.formation-timer';

export const GROUP_FORMATION_TIMER_KINDS = ['deadline', 'retry', 'plan', 'connect'] as const;

export type GroupFormationTimerKind = (typeof GROUP_FORMATION_TIMER_KINDS)[number];

/**
 * The durable time leg of formation. `deadline` fires the activation
 * criterion once the establishment deadline elapses; `retry` re-enters
 * establishment after a below-floor return, under backoff; `plan` and
 * `connect` are the stage triggers' settle (product decision 8). Entries
 * are inserted with `dequeueAudit.nextTs` at their due time -- the queue's
 * own visibility filter (`next_ts <= now()`) holds them invisible until
 * then, so the consumer never sees an early entry and no polling or requeue
 * loop exists.
 */
export type GroupFormationTimerWork = Readonly<{
    kind: GroupFormationTimerKind;
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
    // prefix, and the group identity rides the fnv hash. The hash folds in the
    // arming write's snapshot version: a re-created group restarts its epochs,
    // and its previous life's rows never expire, so kind and epoch alone would
    // collide with them at the very first write.
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_FORMATION_TIMER_TOPIC,
        resourceId: `ft-${work.kind}-${work.formationEpoch}-${fnv1a64(`${contextId}:${work.groupSnapshotVersion}`)}`,
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
    return {
        kind: requireOneOf(parsed.kind, GROUP_FORMATION_TIMER_KINDS, 'Formation timer kind'),
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
    readonly command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation | 'createGroup'; }>;
    /** The stage the group held before this write; null when the write creates the group. */
    readonly previous: GroupLifecycleState | null;
    readonly next: Group;
    readonly policy: GroupLifecyclePolicy;
    readonly facts: GroupMutationFacts;
}

/**
 * The writes arm the time leg themselves (plan refinement 2026-08-18): a
 * pure function of the command, the stages, the policy and the facts, which
 * the outbox validator recomputes byte-exactly. Every entry carries the
 * post-write epoch, so a group that moves on before the timer fires turns
 * the entry into a stale drop.
 */
export function computeFormationTimerEntries(
    input: ComputeFormationTimerEntriesInput
): readonly ResourceEntry[] {
    return [...computeEstablishmentTimerEntries(input), ...computeStageTriggerTimerEntries(input)];
}

/**
 * Entering an establishment phase schedules the deadline evaluation, and a
 * below-floor return schedules the next attempt under backoff.
 */
function computeEstablishmentTimerEntries(
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

/**
 * The commands that can land a group in a stage holding a planned candidate,
 * and so arm the connect trigger: a `plan` from `forming` and the
 * `reconfigure` that opens `reconfiguring`. The latch and its timer backstop
 * must agree on this, or a trigger with a settle arms an intent nothing wakes.
 */
export function opensPlannedCandidateStage(operation: GroupMutationCommand['operation']): boolean {
    return operation === 'planGroupLayout' || operation === 'reconfigureGroup';
}

/**
 * The stage triggers' time leg (product decision 8), phased groups only
 * (product decision 17): the first entry into `forming` — creation or
 * `start` — arms the plan trigger, and a command that lands a candidate in a
 * stage that holds one arms the connect trigger, each at the delay its kind
 * gives — a settle for `after`, a fallback for `presence`. A below-floor
 * return into `forming` is the retry leg's, and a repeated `plan` while
 * `planned` is the state machine's idempotent cell, not an entry.
 */
function computeStageTriggerTimerEntries(
    input: ComputeFormationTimerEntriesInput
): readonly ResourceEntry[] {
    const { previous, next, policy, facts } = input;
    if (policy.formation !== 'phased' || previous === next.lifecycleState) {
        return [];
    }
    if (next.lifecycleState === 'forming' && (previous === null || previous === 'dormant')) {
        const delayMs = toStageTriggerTimerDelayMs(policy.establishment.planTrigger);
        return delayMs === null ? [] : [timerEntry(input, 'plan', facts.nowEpochMs + delayMs)];
    }
    const { connectTrigger } = policy.establishment;
    if (
        !opensPlannedCandidateStage(input.command.operation) || !holdsPlannedCandidateAt(next.lifecycleState) ||
        // `immediate` needs no entry: the publication that follows petitions
        // the latch, which is sooner than any timer could be.
        connectTrigger.kind === 'immediate'
    ) {
        return [];
    }
    const delayMs = toStageTriggerTimerDelayMs(connectTrigger);
    return delayMs === null ? [] : [timerEntry(input, 'connect', facts.nowEpochMs + delayMs)];
}

function timerEntry(
    input: ComputeFormationTimerEntriesInput,
    kind: GroupFormationTimerKind,
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
