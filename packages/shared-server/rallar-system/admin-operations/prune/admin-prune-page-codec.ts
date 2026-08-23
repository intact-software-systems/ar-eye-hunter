import { Temporal } from '@js-temporal/polyfill';
import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    decodeAdminPruneAppData,
    readExactRecord,
    requireAdminPruneCategory,
    requireAdminPruneEpoch,
    requireAdminPrunePageSize,
    requireAdminPruneString,
    type AdminPruneAppData
} from '../inbox/admin-prune-command-codec.ts';

export const ADMIN_PRUNE_APP_OUTBOX_TOPIC = 'rallar.admin.prune-expired';
export interface AdminPrunePageWork {
    readonly kind: 'page';
    readonly jobId: string;
    readonly category: AdminPruneExpiredCategory;
    readonly requestedBy: string;
    readonly requestedSessionId: string;
    readonly capturedAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly pageSize: number;
    readonly afterCursor: string | null;
    readonly pageIndex: number;
    readonly appData: AdminPruneAppData | null;
}

export type ReservedAdminPrunePageWork =
    & AdminPrunePageWork
    & Readonly<{
        reservation: ResourceEntry;
    }>;

export function decodeAdminPruneWork(entry: ResourceEntry): ReservedAdminPrunePageWork {
    if (entry.status !== EntityStatus.RESERVED) {
        throw new TypeError('Admin prune work must be a reserved APP_OUTBOX entry');
    }
    const { work, senderId } = decodeAdminPruneOutboxMessage(entry);
    if (
        entry.audit.createdBy !== toAppQueueCreatedBy(senderId) ||
        entry.audit.createdTs.toString() !== toPlainDateTime(work.capturedAtEpochMs).toString() ||
        Number(entry.audit.expiryTs.epochMilliseconds) !== work.expireAtEpochMs
    ) {
        throw new TypeError('Admin prune work route, sender, expiry, or audit identity is invalid');
    }
    return { ...work, reservation: entry };
}

export interface AdminPruneOutboxMessage {
    readonly work: AdminPrunePageWork;
    readonly senderId: string;
}

export function decodeAdminPruneOutboxMessage(
    entry: Pick<ResourceEntry, 'key' | 'resource' | 'typeId'>
): AdminPruneOutboxMessage {
    if (entry.typeId !== EnqueuedType.APP_OUTBOX) {
        throw new TypeError('Admin prune work must be an APP_OUTBOX entry');
    }
    const outer = readExactRecord(decodeJsonWireValue(JSON.parse(entry.resource), 'Admin prune message'), [
        'id',
        'route',
        'targets',
        'constraints',
        'payload',
        'audit'
    ], 'admin prune message');
    const id = readExactRecord(outer.id, ['v', 'msgId', 'ts', 'senderId'], 'admin prune id');
    const route = readExactRecord(outer.route, ['topicId', 'resourceId', 'contextId'], 'admin prune route');
    const targets = readExactRecord(outer.targets, ['mode', 'scope'], 'admin prune targets');
    const constraints = readExactRecord(outer.constraints, ['expiresAtMs'], 'admin prune constraints');
    const audit = readExactRecord(outer.audit, ['createdBy', 'createdTs'], 'admin prune audit');
    const payload = readExactRecord(outer.payload, ['typeId', 'contentType', 'resource'], 'admin prune payload');
    if (payload.typeId !== 'ADMIN_PRUNE_EXPIRED' || payload.contentType !== 'application/json') {
        throw new TypeError('Admin prune payload identity is invalid');
    }
    if (typeof payload.resource !== 'string') {
        throw new TypeError('Admin prune resource is invalid');
    }
    const work = decodePageWork(decodeJsonWireValue(JSON.parse(payload.resource), 'Admin prune page work'));
    const expectedRoute = toAppQueueKey({
        topicId: ADMIN_PRUNE_APP_OUTBOX_TOPIC,
        resourceId: `${work.jobId}:${work.category}:${work.pageIndex}`,
        contextId: work.jobId
    });
    if (
        id.v !== 2 || id.msgId !== expectedRoute.resourceId || id.ts !== work.capturedAtEpochMs ||
        typeof id.senderId !== 'string' || id.senderId.length === 0 ||
        route.topicId !== expectedRoute.topicId || route.resourceId !== expectedRoute.resourceId ||
        route.contextId !== expectedRoute.contextId || entry.key.topicId !== route.topicId ||
        entry.key.resourceId !== route.resourceId || entry.key.contextId !== route.contextId ||
        targets.mode !== 'all' || targets.scope !== 'global' ||
        constraints.expiresAtMs !== work.expireAtEpochMs ||
        audit.createdBy !== id.senderId || audit.createdTs !== work.capturedAtEpochMs
    ) {
        throw new TypeError('Admin prune work route, sender, expiry, or audit identity is invalid');
    }
    return { work, senderId: id.senderId };
}

export function toAdminPruneOutbox(work: AdminPrunePageWork, serviceId: string): ResourceEntry {
    const route = toAppQueueKey({
        topicId: ADMIN_PRUNE_APP_OUTBOX_TOPIC,
        resourceId: `${work.jobId}:${work.category}:${work.pageIndex}`,
        contextId: work.jobId
    });
    const message = {
        id: { v: 2, msgId: route.resourceId, ts: work.capturedAtEpochMs, senderId: serviceId },
        route,
        targets: { mode: 'all', scope: 'global' },
        constraints: { expiresAtMs: work.expireAtEpochMs },
        payload: {
            typeId: 'ADMIN_PRUNE_EXPIRED',
            contentType: 'application/json',
            resource: JSON.stringify(work)
        },
        audit: { createdBy: serviceId, createdTs: work.capturedAtEpochMs }
    };
    const createdTs = toPlainDateTime(work.capturedAtEpochMs);
    return {
        key: route,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(serviceId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(work.expireAtEpochMs)
        },
        dequeueAudit: { attempts: 0 }
    };
}

function decodePageWork(value: JsonWireValue): AdminPrunePageWork {
    const work = readExactRecord(value, [
        'kind',
        'jobId',
        'category',
        'requestedBy',
        'requestedSessionId',
        'capturedAtEpochMs',
        'expireAtEpochMs',
        'pageSize',
        'afterCursor',
        'pageIndex',
        'appData'
    ], 'admin prune page work');
    if (work.kind !== 'page') {
        throw new TypeError('Admin prune work kind is invalid');
    }
    requireAdminPruneString(work.jobId, 'jobId');
    requireAdminPruneCategory(work.category);
    requireAdminPruneString(work.requestedBy, 'requestedBy');
    requireAdminPruneString(work.requestedSessionId, 'requestedSessionId');
    requireAdminPruneEpoch(work.capturedAtEpochMs, 'capturedAtEpochMs');
    requireAdminPruneEpoch(work.expireAtEpochMs, 'expireAtEpochMs');
    if (work.expireAtEpochMs <= work.capturedAtEpochMs) {
        throw new TypeError('Admin prune page expiry must follow capture time');
    }
    const pageSize = requireAdminPrunePageSize(work.pageSize);
    if (work.afterCursor !== null) {
        requireAdminPruneString(work.afterCursor, 'afterCursor');
    }
    requireAdminPruneEpoch(work.pageIndex, 'pageIndex');
    const appData = decodeAdminPruneAppData(work.appData);
    if ((work.pageIndex === 0) !== (work.afterCursor === null)) {
        throw new TypeError('Admin prune page cursor differs from page index');
    }
    if ((work.category === 'app-data') !== (work.appData !== null)) {
        throw new TypeError('Admin prune app-data category and details differ');
    }
    return {
        kind: 'page',
        jobId: work.jobId,
        category: work.category,
        requestedBy: work.requestedBy,
        requestedSessionId: work.requestedSessionId,
        capturedAtEpochMs: work.capturedAtEpochMs,
        expireAtEpochMs: work.expireAtEpochMs,
        pageSize,
        afterCursor: work.afterCursor,
        pageIndex: work.pageIndex,
        appData
    };
}

function toPlainDateTime(epochMs: number): Temporal.PlainDateTime {
    return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO('UTC').toPlainDateTime();
}
