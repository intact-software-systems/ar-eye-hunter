import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { fnv1a64, toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { serializeCanonicalJson } from '../protocol/canonical-json.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { toExactJsonWireObject, toJsonWireObject } from '../protocol/to-json-wire-object.ts';

import { groupStateGroupStorageKey } from './persistence/aggregate/group-aggregate-storage-keys.ts';

export const APP_OUTBOX_GROUP_CONNECT_TRIGGER_TOPIC = 'app-outbox.group-connect-trigger';

export type GroupConnectTriggerWork =
    | {
        readonly kind: 'intent';
        readonly groupRef: GroupRef;
        readonly formationEpoch: number;
        readonly triggerGeneration: string;
        readonly wakeIdentity: string;
    }
    | { readonly kind: 'publication'; readonly groupRef: GroupRef; readonly wakeIdentity: string; };

export interface ComputeGroupConnectTriggerEntryInput {
    readonly work: GroupConnectTriggerWork;
    readonly senderId: string;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

export function computeGroupConnectTriggerEntry(
    input: ComputeGroupConnectTriggerEntryInput
): ResourceEntry {
    const work = input.work;
    const contextId = groupStateGroupStorageKey(work.groupRef);
    const identity = fnv1a64(contextId + serializeCanonicalJson(work));
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_GROUP_CONNECT_TRIGGER_TOPIC,
        resourceId: `ct-${identity}`,
        contextId
    });
    const createdBy = toAppQueueCreatedBy(input.senderId);
    const createdTs = Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        typeId: EnqueuedType.APP_OUTBOX,
        resource: JSON.stringify(toGroupConnectTriggerMessage({
            work,
            route: key,
            createdBy,
            createdAtEpochMs: input.createdAtEpochMs,
            expireAtEpochMs: input.expireAtEpochMs
        })),
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtEpochMs)
        },
        dequeueAudit: {
            attempts: 0
        }
    };
}

interface GroupConnectTriggerMessageInput {
    readonly work: GroupConnectTriggerWork;
    readonly route: ReturnType<typeof toAppQueueKey>;
    readonly createdBy: string;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

function toGroupConnectTriggerMessage(input: GroupConnectTriggerMessageInput): ALMessage {
    return {
        id: {
            v: 2,
            msgId: input.route.resourceId,
            ts: input.createdAtEpochMs,
            senderId: input.createdBy
        },
        route: input.route,
        constraints: { expiresAtMs: input.expireAtEpochMs },
        ordering: {
            orderingKey: input.route.contextId,
            epoch: input.work.kind === 'intent' ? input.work.formationEpoch : 0,
            seq: 0
        },
        delivery: {
            ownership: 'exclusive',
            reliability: 'at-least-once',
            ack: 'none'
        },
        payload: {
            typeId: AppOutboxType.GROUP_CONNECT_TRIGGER,
            contentType: 'application/json',
            resource: JSON.stringify(input.work)
        },
        audit: {
            createdBy: input.createdBy,
            createdTs: input.createdAtEpochMs
        }
    };
}

export function decodeGroupConnectTriggerWork(resource: string): GroupConnectTriggerWork {
    const message = toJsonWireObject(
        decodeJsonWireValue(JSON.parse(resource), 'Connect trigger message'),
        'Connect trigger message'
    );
    const payload = toJsonWireObject(message.payload, 'Connect trigger message payload');
    const payloadResource = payload.resource;
    if (typeof payloadResource !== 'string') {
        throw new TypeError('Connect trigger message payload is invalid');
    }
    const value = toJsonWireObject(
        decodeJsonWireValue(JSON.parse(payloadResource), 'Connect trigger work'),
        'Connect trigger work'
    );
    if (value.kind !== 'intent' && value.kind !== 'publication') {
        throw new TypeError('Connect trigger work kind is invalid');
    }
    const parsed = toExactJsonWireObject(
        value,
        value.kind === 'intent'
            ? ['kind', 'groupRef', 'formationEpoch', 'triggerGeneration', 'wakeIdentity']
            : ['kind', 'groupRef', 'wakeIdentity'],
        'Connect trigger work'
    );
    const groupRef = toExactJsonWireObject(
        parsed.groupRef,
        ['applicationId', 'workspaceId', 'groupId'],
        'Connect trigger group identity'
    );
    const common = {
        groupRef: {
            applicationId: toNonEmptyString(groupRef.applicationId, 'applicationId'),
            workspaceId: toNonEmptyString(groupRef.workspaceId, 'workspaceId'),
            groupId: toNonEmptyString(groupRef.groupId, 'groupId')
        },
        wakeIdentity: toNonEmptyString(parsed.wakeIdentity, 'wakeIdentity')
    };
    return value.kind === 'publication' ? { kind: 'publication', ...common } : {
        kind: 'intent',
        ...common,
        formationEpoch: toNonNegativeInteger(parsed.formationEpoch, 'formationEpoch'),
        triggerGeneration: toNonEmptyString(parsed.triggerGeneration, 'triggerGeneration')
    };
}

function toNonEmptyString(value: JsonWireValue | undefined, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Connect trigger ${field} must be a non-empty string`);
    }
    return value;
}

function toNonNegativeInteger(value: JsonWireValue | undefined, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`Connect trigger ${field} must be a non-negative integer`);
    }
    return value;
}
