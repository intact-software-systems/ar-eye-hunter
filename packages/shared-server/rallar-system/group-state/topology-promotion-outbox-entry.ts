import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { fnv1a64, toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { serializeCanonicalJson } from '../protocol/canonical-json.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { readExactJsonObject, readJsonObject } from './formation-timer-outbox-entry.ts';
import { groupStateGroupStorageKey } from './persistence/aggregate/group-aggregate-storage-keys.ts';

export const APP_OUTBOX_TOPOLOGY_PROMOTION_TOPIC = 'app-outbox.topology-promotion';

/** The promotion the accepted publication's transaction durably requests. */
export interface GroupTopologyPromotionWork {
    readonly groupRef: GroupRef;
    readonly formationEpoch: number;
    readonly expectedLayout: GroupLayoutIdentity;
}

export interface ComputeTopologyPromotionEntryInput {
    readonly work: GroupTopologyPromotionWork;
    readonly senderId: string;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

/**
 * The durable half of decision 27's atomicity: this entry commits inside the
 * planned-publication transaction, so process loss cannot strand the
 * promotion — the outbox worker re-fires until applyPlannedLayout lands, and
 * the command id it builds spells the same fence, so replays converge.
 */
export function computeTopologyPromotionEntry(
    input: ComputeTopologyPromotionEntryInput
): ResourceEntry {
    const work: GroupTopologyPromotionWork = {
        groupRef: {
            applicationId: input.work.groupRef.applicationId,
            workspaceId: input.work.groupRef.workspaceId,
            groupId: input.work.groupRef.groupId
        },
        formationEpoch: input.work.formationEpoch,
        expectedLayout: input.work.expectedLayout
    };
    const contextId = groupStateGroupStorageKey(work.groupRef);
    // Same 36-char discipline as the formation timers: the layout identity
    // rides the fnv hash of its canonical spelling.
    const identity = fnv1a64(contextId + serializeCanonicalJson(work.expectedLayout));
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_TOPOLOGY_PROMOTION_TOPIC,
        resourceId: `tp-${work.formationEpoch}-${identity}`,
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
            typeId: AppOutboxType.TOPOLOGY_PROMOTION,
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
            attempts: 0
        }
    };
}

export function decodeTopologyPromotionWork(resource: string): GroupTopologyPromotionWork {
    const message = readJsonObject(
        decodeJsonWireValue(JSON.parse(resource), 'Topology promotion message'),
        'Topology promotion message'
    );
    const payload = readJsonObject(message.payload, 'Topology promotion message payload');
    const payloadResource = payload.resource;
    if (typeof payloadResource !== 'string') {
        throw new TypeError('Topology promotion message payload is invalid');
    }
    const parsed = readExactJsonObject(
        decodeJsonWireValue(JSON.parse(payloadResource), 'Topology promotion work payload'),
        ['groupRef', 'formationEpoch', 'expectedLayout'],
        'Topology promotion work payload'
    );
    const groupRef = readExactJsonObject(
        parsed.groupRef,
        ['applicationId', 'workspaceId', 'groupId'],
        'Topology promotion group identity'
    );
    const expectedLayout = readExactJsonObject(
        parsed.expectedLayout,
        ['groupRevision', 'presenceRevision', 'version', 'state'],
        'Topology promotion layout identity'
    );
    if (
        typeof groupRef.applicationId !== 'string' ||
        typeof groupRef.workspaceId !== 'string' ||
        typeof groupRef.groupId !== 'string' ||
        !Number.isSafeInteger(parsed.formationEpoch) ||
        !Number.isSafeInteger(expectedLayout.groupRevision) ||
        !Number.isSafeInteger(expectedLayout.presenceRevision) ||
        !Number.isSafeInteger(expectedLayout.version) ||
        (expectedLayout.state !== 'active' && expectedLayout.state !== 'removed')
    ) {
        throw new TypeError('Topology promotion work payload is invalid');
    }
    return {
        groupRef: {
            applicationId: groupRef.applicationId,
            workspaceId: groupRef.workspaceId,
            groupId: groupRef.groupId
        },
        formationEpoch: parsed.formationEpoch as number,
        expectedLayout: {
            groupRevision: expectedLayout.groupRevision as number,
            presenceRevision: expectedLayout.presenceRevision as number,
            version: expectedLayout.version as number,
            state: expectedLayout.state
        }
    };
}
