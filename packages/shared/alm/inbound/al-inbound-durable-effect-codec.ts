import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { ALInboundDurableEffect, ALPersistedInboundEffect } from './al-inbound-admission-store.ts';

interface StoredResourceEntry {
    readonly key: ResourceEntry['key'];
    readonly resource: string;
    readonly typeId: string;
    readonly audit: Readonly<{
        date: string;
        createdBy: string;
        createdTs: string;
        expiryTs: string;
    }>;
    readonly status: ResourceEntry['status'];
    readonly dequeueAudit: Readonly<{
        startTs?: string;
        endTs?: string;
        nextTs?: string;
        attempts: number;
    }>;
    readonly db?: ResourceEntry['db'];
}

type StoredALInboundDurableEffect =
    | Readonly<{
        kind: 'dispatch-local';
        msg: ALMessage;
        entry: StoredResourceEntry;
        plan: ALMessageHandlingPlan;
    }>
    | Readonly<{
        kind: 'enqueue-inbox';
        msg: ALMessage;
        entry: StoredResourceEntry;
        plan: ALMessageHandlingPlan;
    }>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'send-control'; }>>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'forward-message'; }>>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'release-buffered'; }>>;

export interface StoredALPersistedInboundEffect extends Omit<ALPersistedInboundEffect, 'payload'> {
    readonly payload: StoredALInboundDurableEffect;
}

export function toStoredPersistedInboundEffect(
    effect: ALPersistedInboundEffect
): StoredALPersistedInboundEffect {
    return {
        ...effect,
        payload: toStoredInboundDurableEffect(effect.payload)
    };
}

export function toPersistedInboundEffect(
    effect: StoredALPersistedInboundEffect | undefined
): ALPersistedInboundEffect | undefined {
    if (!effect) {
        return undefined;
    }

    return {
        ...effect,
        payload: toInboundDurableEffect(effect.payload)
    };
}

function toStoredInboundDurableEffect(
    effect: ALInboundDurableEffect
): StoredALInboundDurableEffect {
    switch (effect.kind) {
        case 'dispatch-local':
        case 'enqueue-inbox':
            return {
                ...effect,
                entry: toStoredResourceEntry(effect.entry)
            };
        case 'send-control':
        case 'forward-message':
        case 'release-buffered':
            return effect;
    }
}

function toInboundDurableEffect(
    effect: StoredALInboundDurableEffect
): ALInboundDurableEffect {
    switch (effect.kind) {
        case 'dispatch-local':
        case 'enqueue-inbox':
            return {
                ...effect,
                entry: toResourceEntry(effect.entry)
            };
        case 'send-control':
        case 'forward-message':
        case 'release-buffered':
            return effect;
    }
}

function toStoredResourceEntry(
    entry: ResourceEntry
): StoredResourceEntry {
    return {
        key: entry.key,
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: entry.audit.date.toString(),
            createdBy: entry.audit.createdBy,
            createdTs: entry.audit.createdTs.toString(),
            expiryTs: entry.audit.expiryTs.toString()
        },
        status: entry.status,
        dequeueAudit: {
            startTs: entry.dequeueAudit.startTs?.toString(),
            endTs: entry.dequeueAudit.endTs?.toString(),
            nextTs: entry.dequeueAudit.nextTs?.toString(),
            attempts: entry.dequeueAudit.attempts
        },
        db: entry.db
    };
}

function toResourceEntry(
    entry: StoredResourceEntry
): ResourceEntry {
    return {
        key: entry.key,
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: Temporal.PlainTime.from(entry.audit.date),
            createdBy: entry.audit.createdBy,
            createdTs: Temporal.PlainDateTime.from(entry.audit.createdTs),
            expiryTs: Temporal.Instant.from(entry.audit.expiryTs)
        },
        status: entry.status,
        dequeueAudit: {
            startTs: entry.dequeueAudit.startTs
                ? Temporal.Instant.from(entry.dequeueAudit.startTs)
                : undefined,
            endTs: entry.dequeueAudit.endTs
                ? Temporal.Instant.from(entry.dequeueAudit.endTs)
                : undefined,
            nextTs: entry.dequeueAudit.nextTs
                ? Temporal.Instant.from(entry.dequeueAudit.nextTs)
                : undefined,
            attempts: entry.dequeueAudit.attempts
        },
        db: entry.db
    };
}
