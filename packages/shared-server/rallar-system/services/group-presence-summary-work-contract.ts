import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type {
    GroupRef,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    isKeysEqual,
    type ResourceEntry,
} from '@shared/queuebox/ResourceEntry.ts';
import { validateGroupEvent } from '../persisted-group-event.ts';
import {
    APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC,
    computeGroupPresenceSummaryEntry,
    type GroupPresenceSummaryWorkData,
} from './group-state-mutations.ts';
import { AppOutboxType } from './AppOutboxService.ts';

const MALFORMED_SUMMARY_WORK = 'Presence-summary work payload is malformed';

export function decodeCanonicalGroupPresenceSummaryWork(
    message: ALMessage,
    entry: ResourceEntry,
): GroupPresenceSummaryWorkData {
    try {
        return decodeCanonicalGroupPresenceSummaryWorkUnsafe(message, entry);
    } catch {
        throw new NonRetryableException(MALFORMED_SUMMARY_WORK);
    }
}

function decodeCanonicalGroupPresenceSummaryWorkUnsafe(
    message: ALMessage,
    entry: ResourceEntry,
): GroupPresenceSummaryWorkData {
    const persistedMessage = requireRecord(JSON.parse(entry.resource));
    requireExactKeys(persistedMessage, [
        'id', 'route', 'constraints', 'ordering', 'delivery', 'payload', 'audit',
    ]);
    if (entry.resource !== JSON.stringify(message)) throw new TypeError();

    const id = requireRecord(persistedMessage.id);
    const route = requireRecord(persistedMessage.route);
    const constraints = requireRecord(persistedMessage.constraints);
    const ordering = requireRecord(persistedMessage.ordering);
    const delivery = requireRecord(persistedMessage.delivery);
    const payload = requireRecord(persistedMessage.payload);
    const messageAudit = requireRecord(persistedMessage.audit);
    requireExactKeys(id, ['v', 'msgId', 'ts', 'senderId']);
    requireExactKeys(route, ['topicId', 'resourceId', 'contextId']);
    requireExactKeys(constraints, ['expiresAtMs']);
    requireExactKeys(ordering, ['orderingKey', 'epoch', 'seq']);
    requireExactKeys(delivery, ['ownership', 'reliability', 'ack']);
    requireExactKeys(payload, ['typeId', 'contentType', 'resource']);
    requireExactKeys(messageAudit, ['createdBy', 'createdTs']);
    if (typeof payload.resource !== 'string') throw new TypeError();

    const envelope = requireRecord(JSON.parse(payload.resource));
    requireExactKeys(envelope, [
        'type', 'topicId', 'resourceId', 'contextId', 'senderId', 'data',
    ]);
    const workRecord = requireRecord(envelope.data);
    requireExactKeys(workRecord, [
        'effectKind', 'aggregateRef', 'commandId', 'createdAtEpochMs',
        'expireAtEpochMs', 'acceptedCausalRevision', 'event',
    ]);
    const ref = requireGroupRef(workRecord.aggregateRef);
    const accepted = requireCausalRevision(workRecord.acceptedCausalRevision);
    requireNonEmptyString(workRecord.commandId);
    requireNonNegativeSafeInteger(workRecord.createdAtEpochMs);
    requireNonNegativeSafeInteger(workRecord.expireAtEpochMs);
    if (
        workRecord.effectKind !== 'group-presence-summary' ||
        Number(workRecord.expireAtEpochMs) <= Number(workRecord.createdAtEpochMs)
    ) throw new TypeError();
    validateGroupEvent(workRecord.event, ref, 'Group presence-summary work event');
    const work = workRecord as unknown as GroupPresenceSummaryWorkData;
    if (
        work.event.requestId !== work.commandId ||
        work.event.occurredAtEpochMs !== work.createdAtEpochMs ||
        work.event.snapshotVersion !== accepted.groupRevision ||
        !causalRevisionsEqual(work.event.causalRevision, accepted)
    ) throw new TypeError();

    requireExactKeys(requireRecord(entry), [
        'key', 'resource', 'typeId', 'audit', 'status', 'dequeueAudit',
    ], ['db']);
    requireExactKeys(requireRecord(entry.key), ['topicId', 'resourceId', 'contextId']);
    requireExactKeys(requireRecord(entry.audit), [
        'date', 'createdBy', 'createdTs', 'expiryTs',
    ]);
    const dequeueAudit = requireRecord(entry.dequeueAudit);
    requireExactKeys(dequeueAudit, ['startTs', 'attempts'], ['endTs', 'nextTs']);
    if (
        entry.typeId !== EnqueuedType.APP_OUTBOX ||
        entry.status !== EntityStatus.RESERVED ||
        !entry.dequeueAudit.startTs ||
        entry.dequeueAudit.endTs !== undefined ||
        entry.dequeueAudit.nextTs !== undefined ||
        !Number.isSafeInteger(entry.dequeueAudit.attempts) ||
        entry.dequeueAudit.attempts < 1
    ) throw new TypeError();

    requireNonEmptyString(envelope.senderId);
    const expected = computeGroupPresenceSummaryEntry(work, envelope.senderId as string);
    if (
        envelope.type !== AppOutboxType.GROUP_PRESENCE_SUMMARY ||
        envelope.topicId !== APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC ||
        envelope.resourceId !== id.msgId ||
        envelope.contextId !== toGroupPresenceSummaryQueueContextId(ref) ||
        envelope.senderId !== id.senderId ||
        payload.typeId !== AppOutboxType.GROUP_PRESENCE_SUMMARY ||
        payload.contentType !== 'application/json' ||
        route.topicId !== APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC ||
        id.v !== 2 ||
        id.ts !== work.createdAtEpochMs ||
        constraints.expiresAtMs !== work.expireAtEpochMs ||
        ordering.orderingKey !== expected.key.contextId ||
        ordering.epoch !== accepted.groupRevision ||
        ordering.seq !== accepted.presenceRevision ||
        delivery.ownership !== 'exclusive' ||
        delivery.reliability !== 'at-least-once' ||
        delivery.ack !== 'none' ||
        messageAudit.createdBy !== envelope.senderId ||
        messageAudit.createdTs !== work.createdAtEpochMs ||
        !isKeysEqual(entry.key, expected.key) ||
        entry.resource !== expected.resource ||
        entry.audit.createdBy !== expected.audit.createdBy ||
        entry.audit.date.toString() !== expected.audit.date.toString() ||
        entry.audit.createdTs.toString() !== expected.audit.createdTs.toString() ||
        entry.audit.expiryTs.toString() !== expected.audit.expiryTs.toString()
    ) throw new TypeError();
    return work;
}

function toGroupPresenceSummaryQueueContextId(ref: GroupRef): string {
    return JSON.stringify([ref.applicationId, ref.workspaceId, ref.groupId]);
}

function requireGroupRef(value: unknown): GroupRef {
    const ref = requireRecord(value);
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId']);
    requireNonEmptyString(ref.applicationId);
    requireNonEmptyString(ref.workspaceId);
    requireNonEmptyString(ref.groupId);
    return ref as GroupRef;
}

function requireCausalRevision(value: unknown): GroupStateCausalRevision {
    const revision = requireRecord(value);
    requireExactKeys(revision, ['groupRevision', 'presenceRevision']);
    requireNonNegativeSafeInteger(revision.groupRevision);
    requireNonNegativeSafeInteger(revision.presenceRevision);
    return revision as unknown as GroupStateCausalRevision;
}

function causalRevisionsEqual(
    left: GroupStateCausalRevision,
    right: GroupStateCausalRevision,
): boolean {
    return left.groupRevision === right.groupRevision &&
        left.presenceRevision === right.presenceRevision;
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError();
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
): void {
    const keys = Object.keys(value);
    if (
        required.some((key) => !Object.hasOwn(value, key)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key))
    ) throw new TypeError();
}

function requireNonEmptyString(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError();
}

function requireNonNegativeSafeInteger(value: unknown): void {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError();
}
