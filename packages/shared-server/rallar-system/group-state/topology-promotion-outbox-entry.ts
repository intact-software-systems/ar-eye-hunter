import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { fnv1a64, toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { serializeCanonicalJson } from '../protocol/canonical-json.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { toExactJsonWireObject, toJsonWireObject } from '../protocol/to-json-wire-object.ts';

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
    const createdTs = Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        typeId: EnqueuedType.APP_OUTBOX,
        resource: JSON.stringify(toTopologyPromotionMessage({
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

interface TopologyPromotionMessageInput {
    readonly work: GroupTopologyPromotionWork;
    readonly route: ReturnType<typeof toAppQueueKey>;
    readonly createdBy: string;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

function toTopologyPromotionMessage(input: TopologyPromotionMessageInput): ALMessage {
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
            epoch: input.work.formationEpoch,
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
            resource: JSON.stringify(input.work)
        },
        audit: {
            createdBy: input.createdBy,
            createdTs: input.createdAtEpochMs
        }
    };
}

export function decodeTopologyPromotionWork(resource: string): GroupTopologyPromotionWork {
    const message = toJsonWireObject(
        decodeJsonWireValue(JSON.parse(resource), 'Topology promotion message'),
        'Topology promotion message'
    );
    const payload = toJsonWireObject(message.payload, 'Topology promotion message payload');
    const payloadResource = payload.resource;
    if (typeof payloadResource !== 'string') {
        throw new TypeError('Topology promotion message payload is invalid');
    }
    const parsed = toExactJsonWireObject(
        decodeJsonWireValue(JSON.parse(payloadResource), 'Topology promotion work payload'),
        ['groupRef', 'formationEpoch', 'expectedLayout'],
        'Topology promotion work payload'
    );
    const groupRef = toExactJsonWireObject(
        parsed.groupRef,
        ['applicationId', 'workspaceId', 'groupId'],
        'Topology promotion group identity'
    );
    const expectedLayout = toExactJsonWireObject(
        parsed.expectedLayout,
        GROUP_LAYOUT_IDENTITY_KEYS,
        'Topology promotion layout identity'
    );
    return {
        groupRef: {
            applicationId: toNonEmptyString(groupRef.applicationId, 'applicationId'),
            workspaceId: toNonEmptyString(groupRef.workspaceId, 'workspaceId'),
            groupId: toNonEmptyString(groupRef.groupId, 'groupId')
        },
        formationEpoch: toNonNegativeInteger(parsed.formationEpoch, 'formationEpoch'),
        expectedLayout: {
            groupRevision: toNonNegativeInteger(expectedLayout.groupRevision, 'groupRevision'),
            presenceRevision: toNonNegativeInteger(expectedLayout.presenceRevision, 'presenceRevision'),
            version: toNonNegativeInteger(expectedLayout.version, 'version'),
            state: toLayoutState(expectedLayout.state)
        }
    };
}

function toNonEmptyString(value: JsonWireValue | undefined, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Topology promotion ${field} must be a non-empty string`);
    }
    return value;
}

function toNonNegativeInteger(value: JsonWireValue | undefined, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`Topology promotion ${field} must be a non-negative integer`);
    }
    return value;
}

function toLayoutState(value: JsonWireValue | undefined): GroupLayoutIdentity['state'] {
    const state = GROUP_LAYOUT_IDENTITY_STATES.find((candidate) => candidate === value);
    if (state === undefined) {
        throw new TypeError('Topology promotion layout state is invalid');
    }
    return state;
}
