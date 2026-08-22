import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '../al-contracts/al-contract.ts';
import { EnqueuedType } from '../api/api-config.ts';
import { validateAuthoritativeGroupEvent } from '../api/authoritative-state-validation.ts';
import type { GroupEvent, GroupRef, GroupStateCausalRevision } from '../api/group-types.ts';

import { toAppQueueCreatedBy, toAppQueueKey } from './AppQueueIdentity.ts';
import { EntityStatus, isKeysEqual, type ResourceEntry } from './ResourceEntry.ts';

export const GROUP_PRESENCE_SUMMARY_EFFECT_KIND = 'group-presence-summary';
export const GROUP_PRESENCE_SUMMARY_OUTBOX_TYPE = 'GROUP_PRESENCE_SUMMARY';
export const GROUP_PRESENCE_SUMMARY_TOPIC = 'app-outbox.group-presence-summary';

export interface GroupPresenceSummaryWorkData {
    readonly effectKind: typeof GROUP_PRESENCE_SUMMARY_EFFECT_KIND;
    readonly aggregateRef: GroupRef;
    readonly commandId: string;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly acceptedCausalRevision: GroupStateCausalRevision;
    readonly event: GroupEvent;
}

const MESSAGE_KEYS = [
    'id',
    'route',
    'constraints',
    'ordering',
    'delivery',
    'payload',
    'audit'
] as const;
const ENVELOPE_KEYS = ['type', 'topicId', 'resourceId', 'contextId', 'senderId', 'data'] as const;
const WORK_KEYS = [
    'effectKind',
    'aggregateRef',
    'commandId',
    'createdAtEpochMs',
    'expireAtEpochMs',
    'acceptedCausalRevision',
    'event'
] as const;
const RESOURCE_ENTRY_STATUSES = new Set<string>(Object.values(EntityStatus));

export function computeGroupPresenceSummaryEntry(
    work: GroupPresenceSummaryWorkData,
    senderId: string
): ResourceEntry {
    requireCanonicalGroupPresenceSummaryWork(work);
    requireNonEmptyString(senderId);

    const causalIdentity = [
        `group=${work.acceptedCausalRevision.groupRevision}`,
        `presence=${work.acceptedCausalRevision.presenceRevision}`
    ].join(';');
    const resourceId = [work.commandId, work.effectKind, causalIdentity].join(':');
    const contextId = JSON.stringify([
        work.aggregateRef.applicationId,
        work.aggregateRef.workspaceId,
        work.aggregateRef.groupId
    ]);
    const key = toAppQueueKey({
        topicId: GROUP_PRESENCE_SUMMARY_TOPIC,
        resourceId,
        contextId
    });
    const createdBy = toAppQueueCreatedBy(senderId);
    const envelope = {
        type: GROUP_PRESENCE_SUMMARY_OUTBOX_TYPE,
        topicId: GROUP_PRESENCE_SUMMARY_TOPIC,
        resourceId,
        contextId,
        senderId: createdBy,
        data: work
    } as const;
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: resourceId,
            ts: work.createdAtEpochMs,
            senderId: createdBy
        },
        route: key,
        constraints: { expiresAtMs: work.expireAtEpochMs },
        ordering: {
            orderingKey: key.contextId,
            epoch: work.acceptedCausalRevision.groupRevision,
            seq: work.acceptedCausalRevision.presenceRevision
        },
        delivery: {
            ownership: 'exclusive',
            reliability: 'at-least-once',
            ack: 'none'
        },
        payload: {
            typeId: GROUP_PRESENCE_SUMMARY_OUTBOX_TYPE,
            contentType: 'application/json',
            resource: JSON.stringify(envelope)
        },
        audit: {
            createdBy,
            createdTs: work.createdAtEpochMs
        }
    };
    const createdTs = Temporal.Instant.fromEpochMilliseconds(work.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();

    return {
        key,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(work.expireAtEpochMs)
        },
        dequeueAudit: { attempts: 0 }
    };
}

export function decodeCanonicalGroupPresenceSummaryEntry(
    entry: ResourceEntry
): GroupPresenceSummaryWorkData {
    requireResourceEntryShape(entry);
    const messageRecord = requireRecord(JSON.parse(entry.resource));
    requireExactKeys(messageRecord, MESSAGE_KEYS);
    const payload = requireRecord(messageRecord.payload);
    requireExactKeys(payload, ['typeId', 'contentType', 'resource']);
    if (typeof payload.resource !== 'string') {
        throw new TypeError('Group presence-summary payload resource is invalid');
    }

    const envelope = requireRecord(JSON.parse(payload.resource));
    requireExactKeys(envelope, ENVELOPE_KEYS);
    requireNonEmptyString(envelope.senderId);
    const workRecord = requireRecord(envelope.data);
    requireExactKeys(workRecord, WORK_KEYS);
    const work = toGroupPresenceSummaryWork(workRecord);

    const expected = computeGroupPresenceSummaryEntry(work, envelope.senderId);
    if (!hasSameGroupPresenceSummaryImmutableEntry(entry, expected)) {
        throw new TypeError('Group presence-summary entry is not canonical');
    }

    return work;
}

export function isCanonicalGroupPresenceSummaryEntry(entry: ResourceEntry): boolean {
    try {
        decodeCanonicalGroupPresenceSummaryEntry(entry);
        return true;
    }
    catch {
        return false;
    }
}

export function hasSameGroupPresenceSummaryImmutableEntry(
    left: ResourceEntry,
    right: ResourceEntry
): boolean {
    try {
        return (
            left.typeId === right.typeId &&
            isKeysEqual(left.key, right.key) &&
            left.resource === right.resource &&
            left.audit.createdBy === right.audit.createdBy &&
            left.audit.date.toString() === right.audit.date.toString() &&
            left.audit.createdTs.toString() === right.audit.createdTs.toString() &&
            left.audit.expiryTs.toString() === right.audit.expiryTs.toString()
        );
    }
    catch {
        return false;
    }
}

function toGroupPresenceSummaryWork(value: Record<string, unknown>): GroupPresenceSummaryWorkData {
    const effectKind = value.effectKind;
    const aggregateRef = value.aggregateRef;
    const commandId = value.commandId;
    const createdAtEpochMs = value.createdAtEpochMs;
    const expireAtEpochMs = value.expireAtEpochMs;
    const acceptedCausalRevision = value.acceptedCausalRevision;
    const event = value.event;
    if (effectKind !== GROUP_PRESENCE_SUMMARY_EFFECT_KIND) {
        throw new TypeError('Group presence-summary effect kind is invalid');
    }
    requireGroupRef(aggregateRef);
    requireNonEmptyString(commandId);
    requireNonNegativeSafeInteger(createdAtEpochMs);
    requireNonNegativeSafeInteger(expireAtEpochMs);
    requireCausalRevision(acceptedCausalRevision);
    validateAuthoritativeGroupEvent(event, aggregateRef);

    const work: GroupPresenceSummaryWorkData = {
        effectKind,
        aggregateRef,
        commandId,
        createdAtEpochMs: Number(createdAtEpochMs),
        expireAtEpochMs: Number(expireAtEpochMs),
        acceptedCausalRevision,
        event
    };
    requireCanonicalGroupPresenceSummaryWork(work);

    return work;
}

function requireCanonicalGroupPresenceSummaryWork(work: GroupPresenceSummaryWorkData): void {
    requireExactKeys(requireRecord(work), WORK_KEYS);
    requireGroupRef(work.aggregateRef);
    requireNonEmptyString(work.commandId);
    requireNonNegativeSafeInteger(work.createdAtEpochMs);
    requireNonNegativeSafeInteger(work.expireAtEpochMs);
    requireCausalRevision(work.acceptedCausalRevision);
    validateAuthoritativeGroupEvent(work.event, work.aggregateRef);
    requireNullableNonEmptyString(work.event.reason);
    requireNullableNonEmptyString(work.event.traceId);

    if (
        work.effectKind !== GROUP_PRESENCE_SUMMARY_EFFECT_KIND ||
        work.expireAtEpochMs <= work.createdAtEpochMs ||
        work.event.occurredAtEpochMs !== work.createdAtEpochMs ||
        work.event.snapshotVersion !== work.acceptedCausalRevision.groupRevision ||
        !causalRevisionsEqual(work.event.causalRevision, work.acceptedCausalRevision)
    ) {
        throw new TypeError('Group presence-summary work is invalid');
    }
}

function requireResourceEntryShape(entry: ResourceEntry): void {
    const record = requireRecord(entry);
    requireExactKeys(
        record,
        ['key', 'resource', 'typeId', 'audit', 'status', 'dequeueAudit'],
        ['db']
    );
    requireExactKeys(requireRecord(entry.key), ['topicId', 'resourceId', 'contextId']);
    requireNonEmptyString(entry.key.topicId);
    requireNonEmptyString(entry.key.resourceId);
    requireNonEmptyString(entry.key.contextId);
    requireNonEmptyString(entry.resource);
    requireNonEmptyString(entry.typeId);
    if (!RESOURCE_ENTRY_STATUSES.has(entry.status)) {
        throw new TypeError('Group presence-summary entry status is invalid');
    }

    const audit = requireRecord(entry.audit);
    requireExactKeys(audit, ['date', 'createdBy', 'createdTs', 'expiryTs']);
    requireNonEmptyString(entry.audit.createdBy);
    requirePlainTime(entry.audit.date);
    requirePlainDateTime(entry.audit.createdTs);
    requireInstant(entry.audit.expiryTs);

    const dequeueAudit = requireRecord(entry.dequeueAudit);
    requireExactKeys(dequeueAudit, ['attempts'], ['startTs', 'endTs', 'nextTs']);
    requireNonNegativeSafeInteger(entry.dequeueAudit.attempts);
    requireOptionalInstant(entry.dequeueAudit.startTs);
    requireOptionalInstant(entry.dequeueAudit.endTs);
    requireOptionalInstant(entry.dequeueAudit.nextTs);

    if (entry.db !== undefined) {
        const databaseIdentity = requireRecord(entry.db);
        requireExactKeys(databaseIdentity, ['id']);
        requireNonEmptyString(entry.db.id);
    }
}

function requireGroupRef(value: unknown): asserts value is GroupRef {
    const ref = requireRecord(value);
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId']);
    requireNonEmptyString(ref.applicationId);
    requireNonEmptyString(ref.workspaceId);
    requireNonEmptyString(ref.groupId);
}

function requireCausalRevision(value: unknown): asserts value is GroupStateCausalRevision {
    const revision = requireRecord(value);
    requireExactKeys(revision, ['groupRevision', 'presenceRevision']);
    requireNonNegativeSafeInteger(revision.groupRevision);
    requireNonNegativeSafeInteger(revision.presenceRevision);
}

function causalRevisionsEqual(
    left: GroupStateCausalRevision,
    right: GroupStateCausalRevision
): boolean {
    return (
        left.groupRevision === right.groupRevision && left.presenceRevision === right.presenceRevision
    );
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Group presence-summary record is invalid');
    }

    return value as Record<string, unknown>;
}

function requireExactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
): void {
    const keys = Object.keys(value);
    if (
        required.some((key) => !Object.hasOwn(value, key)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key))
    ) {
        throw new TypeError('Group presence-summary keys are invalid');
    }
}

function requireNonEmptyString(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('Group presence-summary string is invalid');
    }
}

function requireNullableNonEmptyString(value: unknown): void {
    if (value !== null) {
        requireNonEmptyString(value);
    }
}

function requireNonNegativeSafeInteger(value: unknown): void {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError('Group presence-summary integer is invalid');
    }
}

function requirePlainTime(value: unknown): void {
    if (!(value instanceof Temporal.PlainTime)) {
        throw new TypeError('Group presence-summary temporal value is invalid');
    }
}

function requirePlainDateTime(value: unknown): void {
    if (!(value instanceof Temporal.PlainDateTime)) {
        throw new TypeError('Group presence-summary temporal value is invalid');
    }
}

function requireInstant(value: unknown): void {
    if (!(value instanceof Temporal.Instant)) {
        throw new TypeError('Group presence-summary temporal value is invalid');
    }
}

function requireOptionalInstant(value: unknown): void {
    if (value !== undefined) {
        requireInstant(value);
    }
}
