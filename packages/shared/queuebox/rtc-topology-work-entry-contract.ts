import { Temporal } from '@js-temporal/polyfill';

import { decodePersistedALMessage } from '../al-contracts/al-message-persistence-validation.ts';
import {
    decodePersistedALRecord,
    type PersistedALRecord,
    type PersistedALValue
} from '../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { EnqueuedType } from '../api/api-config.ts';
import { toAppQueueKey } from './AppQueueIdentity.ts';
import { EntityStatus, isKeysEqual, NEVER_EXPIRE_TS, type ResourceEntry } from './ResourceEntry.ts';

export const RTC_TOPOLOGY_OUTBOX_TOPIC = 'app-outbox.rtc-topology';
export const RTC_TOPOLOGY_OUTBOX_TYPE = 'RTC_TOPOLOGY_RECOMPUTE';

const ENTRY_STATUSES = new Set<string>(Object.values(EntityStatus));
const ENVELOPE_KEYS = [
    'type',
    'topicId',
    'resourceId',
    'contextId',
    'senderId',
    'data'
] as const;

export function isCanonicalRtcTopologyWorkEntry(entry: ResourceEntry): boolean {
    try {
        requireResourceEntryShape(entry);
        const message = decodePersistedALMessage(entry.resource);
        const envelope = decodePersistedALRecord(
            message.payload.resource,
            'RTC topology work envelope'
        );
        exactKeys(envelope, ENVELOPE_KEYS);

        const senderId = nonEmptyString(envelope.senderId);
        const expectedKey = toAppQueueKey({
            topicId: nonEmptyString(envelope.topicId),
            resourceId: nonEmptyString(envelope.resourceId),
            contextId: nonEmptyString(envelope.contextId)
        });
        const data = requirePersistedALRecord(envelope.data);
        if (
            entry.typeId !== EnqueuedType.APP_OUTBOX ||
            entry.key.topicId !== RTC_TOPOLOGY_OUTBOX_TOPIC ||
            envelope.type !== RTC_TOPOLOGY_OUTBOX_TYPE ||
            envelope.topicId !== RTC_TOPOLOGY_OUTBOX_TOPIC ||
            message.payload.typeId !== RTC_TOPOLOGY_OUTBOX_TYPE ||
            message.payload.contentType !== 'application/json' ||
            !isKeysEqual(entry.key, message.route) ||
            !isKeysEqual(entry.key, expectedKey) ||
            message.id.senderId !== senderId ||
            message.audit?.createdBy !== senderId ||
            message.audit.createdTs !== message.id.ts ||
            entry.audit.createdBy !== senderId ||
            !['group-revision', 'rtt-refresh'].includes(String(data.kind))
        ) {
            throw new TypeError('RTC topology work identity is invalid');
        }

        const expectedCreatedTs = Temporal.Instant
            .fromEpochMilliseconds(message.id.ts)
            .toZonedDateTimeISO('UTC')
            .toPlainDateTime();
        const expectedExpiryTs = message.constraints?.expiresAtMs === undefined
            ? NEVER_EXPIRE_TS
            : Temporal.Instant.fromEpochMilliseconds(
                message.constraints.expiresAtMs
            );
        if (
            !entry.audit.createdTs.equals(expectedCreatedTs) ||
            !entry.audit.date.equals(expectedCreatedTs.toPlainTime()) ||
            !entry.audit.expiryTs.equals(expectedExpiryTs)
        ) {
            throw new TypeError('RTC topology work audit is invalid');
        }
        return true;
    }
    catch {
        return false;
    }
}

function requireResourceEntryShape(entry: ResourceEntry): void {
    exactKeys(
        entry,
        ['key', 'resource', 'typeId', 'audit', 'status', 'dequeueAudit'],
        ['db']
    );
    exactKeys(entry.key, ['topicId', 'resourceId', 'contextId']);
    nonEmptyString(entry.key.topicId);
    nonEmptyString(entry.key.resourceId);
    nonEmptyString(entry.key.contextId);
    nonEmptyString(entry.resource);
    nonEmptyString(entry.typeId);
    if (!ENTRY_STATUSES.has(entry.status)) {
        throw new TypeError('RTC topology work status is invalid');
    }

    exactKeys(entry.audit, [
        'date',
        'createdBy',
        'createdTs',
        'expiryTs'
    ]);
    nonEmptyString(entry.audit.createdBy);
    requireTemporal(entry.audit.date, Temporal.PlainTime);
    requireTemporal(entry.audit.createdTs, Temporal.PlainDateTime);
    requireTemporal(entry.audit.expiryTs, Temporal.Instant);

    exactKeys(
        entry.dequeueAudit,
        ['attempts'],
        ['startTs', 'endTs', 'nextTs']
    );
    if (
        !Number.isSafeInteger(entry.dequeueAudit.attempts) ||
        entry.dequeueAudit.attempts < 0
    ) {
        throw new TypeError('RTC topology work attempts are invalid');
    }
    for (
        const timestamp of [
            entry.dequeueAudit.startTs,
            entry.dequeueAudit.endTs,
            entry.dequeueAudit.nextTs
        ]
    ) {
        if (timestamp !== undefined) {
            requireTemporal(timestamp, Temporal.Instant);
        }
    }
    if (entry.db !== undefined) {
        exactKeys(entry.db, ['id']);
        nonEmptyString(entry.db.id);
    }
}

function requirePersistedALRecord(value: PersistedALValue): PersistedALRecord {
    if (!isPersistedALRecord(value)) {
        throw new TypeError('RTC topology work record is invalid');
    }
    return value;
}

function isPersistedALRecord(value: PersistedALValue): value is PersistedALRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
    value: object,
    required: readonly string[],
    optional: readonly string[] = []
): void {
    const keys = Object.keys(value);
    if (
        required.some((key) => !Object.hasOwn(value, key)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key))
    ) {
        throw new TypeError('RTC topology work keys are invalid');
    }
}

function nonEmptyString(value: PersistedALValue | undefined): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('RTC topology work string is invalid');
    }
    return value;
}

function requireTemporal<T extends object>(
    value: object,
    constructor: abstract new(...args: never[]) => T
): asserts value is T {
    if (!(value instanceof constructor)) {
        throw new TypeError('RTC topology work temporal value is invalid');
    }
}
